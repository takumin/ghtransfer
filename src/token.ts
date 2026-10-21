/**
 * The user access token a run acts with. Transferring a repository is a user-to-server call only
 * (POST /repos/{owner}/{repo}/transfer accepts no installation token), so the Worker holds the
 * GitHub App's refresh token for the source owner rather than a private key. GitHub spends a
 * refresh token on use and hands back its successor, which is why every run rotates the one stored
 * in KV before it does anything else; scripts/authorize.sh seeds the first one.
 */

import { refreshToken as exchangeRefreshToken } from "@octokit/oauth-methods";

/** The KV key the current refresh token lives under, shared with scripts/authorize.sh. */
const REFRESH_TOKEN_KEY = "refresh-token";

interface AppCredentials {
	/** GitHub App client ID (a var, not a secret: it is public by design). */
	readonly clientId: string;
	/** GitHub App client secret, required to exchange a refresh token. */
	readonly clientSecret: string;
}

/**
 * A fresh access token, or nothing when no refresh token has been seeded yet. The successor is
 * stored before the access token is returned: once GitHub has answered, the stored token is
 * already spent, so a failure anywhere after this point must not be able to lose its replacement.
 * A failure of the put itself does lose it, and the run's log entry is what says to re-seed.
 */
async function rotateUserToken(
	kv: KVNamespace,
	credentials: AppCredentials,
): Promise<string | undefined> {
	const stored = await kv.get(REFRESH_TOKEN_KEY);
	if (stored === null) {
		return undefined;
	}
	const { authentication } = await exchangeRefreshToken({
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		clientType: "github-app",
		refreshToken: stored,
	});
	await kv.put(REFRESH_TOKEN_KEY, authentication.refreshToken);
	return authentication.token;
}

export { REFRESH_TOKEN_KEY, rotateUserToken };
export type { AppCredentials };
