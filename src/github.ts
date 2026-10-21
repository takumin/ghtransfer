/**
 * The GitHub side of a run: the client the rotated user access token (src/token.ts) authenticates,
 * the listing of what is due for transfer, and the transfer itself.
 */

import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";
import { paginateRest } from "@octokit/plugin-paginate-rest";

const API_VERSION = "2022-11-28";
const USER_AGENT = "ghtransfer";
/**
 * Whole-run budget shared by every GitHub call, pagination and transfers included. A cron
 * invocation may run for 15 minutes; this is far inside that and far beyond what a run of
 * src/run.ts's MAX_TRANSFERS_PER_RUN transfers needs, so it only binds on a call that hangs.
 */
const RUN_TIMEOUT_MS = 120_000;

const GithubOctokit = Octokit.plugin(paginateRest);

/** Per-run client with the user access token and Link-header pagination wired in. */
type GithubClient = InstanceType<typeof GithubOctokit>;

/** The source and target owners, from wrangler.jsonc's vars. */
interface Owners {
	readonly from: string;
	readonly to: string;
}

/** A transfer GitHub refused, with what it answered; the run moves on to the next repository. */
interface TransferFailure {
	readonly message: string;
	readonly repo: string;
	readonly status: number;
}

function createGithubClient(token: string): GithubClient {
	const client = new GithubOctokit({
		auth: token,
		request: { signal: AbortSignal.timeout(RUN_TIMEOUT_MS) },
		userAgent: USER_AGENT,
	});
	// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- the before-request hook pins the header by writing into the options octokit hands it
	client.hook.before("request", (options) => {
		options.headers["x-github-api-version"] = API_VERSION;
	});
	return client;
}

/**
 * The names of the archived repositories `owner` owns, in name order. GET /user/repos rather than
 * GET /users/{owner}/repos, because only the former lists private repositories; it lists the
 * authenticated user's, which is why the owner is still compared — a token seeded for anyone else
 * lists nothing to transfer rather than someone else's repositories.
 */
async function listArchivedRepos(client: GithubClient, owner: string): Promise<string[]> {
	const repos = await client.paginate("GET /user/repos", {
		affiliation: "owner",
		per_page: 100,
		sort: "full_name",
	});
	const names: string[] = [];
	for (const { archived, name, owner: repoOwner } of repos) {
		if (archived && repoOwner.login === owner) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Starts one transfer, or says why GitHub refused it. GitHub completes a transfer asynchronously,
 * so success here is acceptance; a repository that somehow stays behind is simply listed again by
 * the next run. Only a RequestError is a refusal — anything else is not GitHub's answer and ends
 * the run.
 */
async function transferRepo(
	client: GithubClient,
	repo: string,
	owners: Owners,
): Promise<TransferFailure | undefined> {
	try {
		await client.request("POST /repos/{owner}/{repo}/transfer", {
			new_owner: owners.to,
			owner: owners.from,
			repo,
		});
		return undefined;
	} catch (error) {
		if (error instanceof RequestError) {
			return { message: error.message, repo, status: error.status };
		}
		throw error;
	}
}

export { createGithubClient, listArchivedRepos, transferRepo };
export type { GithubClient, Owners, TransferFailure };
