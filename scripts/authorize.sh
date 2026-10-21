#!/bin/sh
#
# Seeds the refresh token src/token.ts rotates. Runs the GitHub App's device
# flow, checks that the account that authorized it is the one the Worker
# transfers from, and stores the refresh token it yields in the TOKENS KV
# namespace under the key src/token.ts reads.
#
# Run it once after the first deploy, and again whenever a run logs
# missing-refresh-token or fails to refresh: a spent or revoked refresh token
# cannot be recovered, only replaced.
#
# Usage: task authorize -- <client-id> <login>

set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 <client-id> <login>" >&2
	exit 2
fi
client_id=$1
login=$2

cd "$(git rev-parse --show-toplevel)"

workdir=$(mktemp -d)
trap 'rm -rf "${workdir}"' EXIT

# The OAuth endpoints answer form posts and, asked for JSON, report every
# failure as a 200 with an `error` field rather than as an HTTP status.
oauth_post()
{
	curl -fsS -X POST -H 'Accept: application/json' "$@"
}

oauth_post -d "client_id=${client_id}" https://github.com/login/device/code \
	> "${workdir}/device.json"
device_code=$(jq -r .device_code "${workdir}/device.json")
interval=$(jq -r .interval "${workdir}/device.json")

echo "Open $(jq -r .verification_uri "${workdir}/device.json") and enter the code:"
echo
echo "    $(jq -r .user_code "${workdir}/device.json")"
echo

# The device code goes through a file for the same reason the token does
# below: whoever polls with it first receives the token.
printf 'client_id=%s&device_code=%s&grant_type=%s' \
	"${client_id}" "${device_code}" urn:ietf:params:oauth:grant-type:device_code \
	> "${workdir}/poll-body"

while :; do
	sleep "${interval}"
	oauth_post -d @"${workdir}/poll-body" \
		https://github.com/login/oauth/access_token > "${workdir}/token.json"
	error=$(jq -r '.error // empty' "${workdir}/token.json")
	case "${error}" in
		"") break ;;
		authorization_pending) ;;
		slow_down) interval=$(jq -r .interval "${workdir}/token.json") ;;
		*)
			echo "device flow failed: $(jq -r .error_description "${workdir}/token.json")" >&2
			exit 1
			;;
	esac
done

# A token that never expires has no refresh token, which leaves the Worker
# nothing to rotate: the App has token expiration switched off.
if [ "$(jq -r '.refresh_token // empty' "${workdir}/token.json")" = "" ]; then
	echo "no refresh token returned; enable user token expiration on the GitHub App" >&2
	exit 1
fi

# Headers and the token go through files rather than arguments, which any
# process on the machine can read off the process list.
jq -r '"Authorization: Bearer " + .access_token' "${workdir}/token.json" \
	> "${workdir}/auth-header"
authorized=$(curl -fsS -H @"${workdir}/auth-header" https://api.github.com/user | jq -r .login)
if [ "${authorized}" != "${login}" ]; then
	echo "authorized as ${authorized}, expected ${login}; nothing stored" >&2
	exit 1
fi

jq -j .refresh_token "${workdir}/token.json" > "${workdir}/refresh-token"
pnpm exec wrangler kv key put refresh-token --binding TOKENS --remote \
	--path "${workdir}/refresh-token"
echo "Stored a refresh token for ${login}."
