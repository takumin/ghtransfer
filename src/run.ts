/**
 * One scheduled run: rotate the user access token (src/token.ts), list what the source owner has
 * archived, and transfer it to the target owner (src/github.ts). What the run did is returned as an
 * outcome for src/log.ts to report, rather than logged from here.
 */

import type { GithubClient, Owners, TransferFailure } from "./github";
import { createGithubClient, listArchivedRepos, transferRepo } from "./github";
import { rotateUserToken } from "./token";

/**
 * The most transfers one run starts. Each is a subrequest, and the Workers Free plan allows 50 per
 * invocation, the token refresh and the listing pages included; the rest wait for the next run,
 * which lists them again.
 */
const MAX_TRANSFERS_PER_RUN = 30;

/** A run that got as far as the transfers; `deferred` is what the cap left for the next run. */
interface Completed {
	readonly deferred: readonly string[];
	readonly failed: readonly TransferFailure[];
	readonly kind: "completed";
	readonly transferred: readonly string[];
}

type Outcome =
	| Completed
	| { readonly kind: "missing-credentials" }
	| { readonly kind: "missing-refresh-token" };

interface Transfers {
	readonly failed: readonly TransferFailure[];
	readonly transferred: readonly string[];
}

/* Sequential on purpose: transfers create repositories on the target, which is what GitHub's
 * secondary rate limits watch, and a daily run has no deadline worth racing. */
async function transferEach(
	client: GithubClient,
	repos: readonly string[],
	owners: Owners,
): Promise<Transfers> {
	const transferred: string[] = [];
	const failed: TransferFailure[] = [];
	for (const repo of repos) {
		// oxlint-disable-next-line no-await-in-loop -- sequential on purpose; see above
		const failure = await transferRepo(client, repo, owners);
		if (failure === undefined) {
			transferred.push(repo);
		} else {
			failed.push(failure);
		}
	}
	return { failed, transferred };
}

async function transferAll(token: string, owners: Owners): Promise<Completed> {
	const client = createGithubClient(token);
	const archived = await listArchivedRepos(client, owners.from);
	const { failed, transferred } = await transferEach(
		client,
		archived.slice(0, MAX_TRANSFERS_PER_RUN),
		owners,
	);
	return {
		deferred: archived.slice(MAX_TRANSFERS_PER_RUN),
		failed,
		kind: "completed",
		transferred,
	};
}

/* Tested for falsiness: an unset Workers Secret arrives as undefined though `Env` declares it a
 * string, and an emptied var arrives as "". */
async function runTransfer(env: Env): Promise<Outcome> {
	const clientId = env.GITHUB_APP_CLIENT_ID;
	const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return { kind: "missing-credentials" };
	}
	const token = await rotateUserToken(env.TOKENS, { clientId, clientSecret });
	if (token === undefined) {
		return { kind: "missing-refresh-token" };
	}
	const outcome = await transferAll(token, { from: env.SOURCE_OWNER, to: env.TARGET_OWNER });
	return outcome;
}

export { MAX_TRANSFERS_PER_RUN, runTransfer };
export type { Completed, Outcome, Transfers };
