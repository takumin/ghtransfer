/**
 * What the suites drive a run with: the env the Worker is handed, the routes GitHub answers on —
 * its OAuth token endpoint and the REST API — and the capture of the run's one log entry
 * (src/log.ts). The KV namespace is the real one the pool binds from wrangler.jsonc, so a suite
 * reads back what src/token.ts actually stored.
 */

import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { onTestFinished, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { PlannedRoute } from "./fetch-stub";
import { REFRESH_TOKEN_KEY } from "~src/token";
import { env as boundEnv } from "cloudflare:workers";
import { jsonRoute } from "./fetch-stub";
import worker from "~src/index";

const ACCESS_TOKEN = "ghu_fixture-access-token";
const CLIENT_ID = "Iv23fixture";
const CLIENT_SECRET = "fixture-client-secret";
const SEEDED_REFRESH_TOKEN = "ghr_fixture-seeded";
const ROTATED_REFRESH_TOKEN = "ghr_fixture-rotated";
const SOURCE_OWNER = "source-owner";
const TARGET_OWNER = "target-owner";
const VERSION_ID = "fixture-version";

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
/** Eight hours and six months: what GitHub answers a refresh with for an expiring token. */
const ACCESS_TOKEN_TTL_SECONDS = 28_800;
const REFRESH_TOKEN_TTL_SECONDS = 15_897_600;

const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const REPOS_URL = "https://api.github.com/user/repos?affiliation=owner&per_page=100&sort=full_name";

interface RepoFixture {
	readonly archived: boolean;
	readonly name: string;
	readonly owner?: string;
}

function transferUrl(repo: string): string {
	return `https://api.github.com/repos/${SOURCE_OWNER}/${repo}/transfer`;
}

/* The token's expiry is dated by oauth-methods off the response's own Date header, as GitHub sends one. */
const RESPONSE_DATE = "Wed, 21 Oct 2026 19:00:00 GMT";

function refreshRoute(): PlannedRoute {
	return jsonRoute({
		headers: { date: RESPONSE_DATE },
		method: "POST",
		payload: {
			access_token: ACCESS_TOKEN,
			expires_in: ACCESS_TOKEN_TTL_SECONDS,
			refresh_token: ROTATED_REFRESH_TOKEN,
			refresh_token_expires_in: REFRESH_TOKEN_TTL_SECONDS,
			scope: "",
			token_type: "bearer",
		},
		status: HTTP_OK,
		url: OAUTH_TOKEN_URL,
	});
}

/** GitHub answers a spent or revoked refresh token with 200 and an error body. */
function rejectedRefreshRoute(): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: {
			error: "bad_refresh_token",
			error_description: "The refresh token passed is incorrect or expired.",
			error_uri: "https://docs.github.com",
		},
		status: HTTP_OK,
		url: OAUTH_TOKEN_URL,
	});
}

function reposRoute(repos: readonly RepoFixture[]): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: repos.map((repo) => ({
			archived: repo.archived,
			name: repo.name,
			owner: { login: repo.owner ?? SOURCE_OWNER },
		})),
		status: HTTP_OK,
		url: REPOS_URL,
	});
}

function transferRoute(repo: string, status: number = HTTP_ACCEPTED): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { message: "Repository creation failed." },
		status,
		url: transferUrl(repo),
	});
}

/** The env a deployment hands the Worker; the client secret is the one thing a case varies. */
function makeEnv(clientSecret: string = CLIENT_SECRET): Env {
	return {
		CF_VERSION_METADATA: { id: VERSION_ID, tag: "", timestamp: "" },
		GITHUB_APP_CLIENT_ID: CLIENT_ID,
		GITHUB_APP_CLIENT_SECRET: clientSecret,
		SOURCE_OWNER,
		TARGET_OWNER,
		TOKENS: boundEnv.TOKENS,
	};
}

async function seedRefreshToken(): Promise<void> {
	await boundEnv.TOKENS.put(REFRESH_TOKEN_KEY, SEEDED_REFRESH_TOKEN);
}

async function clearRefreshToken(): Promise<void> {
	await boundEnv.TOKENS.delete(REFRESH_TOKEN_KEY);
}

async function storedRefreshToken(): Promise<string | null> {
	const stored = await boundEnv.TOKENS.get(REFRESH_TOKEN_KEY);
	return stored;
}

async function runScheduled(env: Env): Promise<void> {
	await worker.scheduled(createScheduledController(), env, createExecutionContext());
}

const LOG_SINKS = ["error", "info", "warn"] as const;

/** Every console method src/log.ts emits on, funnelled into one mock restored after the test. */
function captureLog(): MockInstance<typeof console.log> {
	const entries = vi.fn<typeof console.log>();
	for (const sink of LOG_SINKS) {
		const spy = vi.spyOn(console, sink).mockImplementation(entries);
		onTestFinished(() => {
			spy.mockRestore();
		});
	}
	return entries;
}

export {
	ACCESS_TOKEN,
	CLIENT_ID,
	CLIENT_SECRET,
	OAUTH_TOKEN_URL,
	REPOS_URL,
	ROTATED_REFRESH_TOKEN,
	SEEDED_REFRESH_TOKEN,
	SOURCE_OWNER,
	TARGET_OWNER,
	VERSION_ID,
	captureLog,
	clearRefreshToken,
	makeEnv,
	refreshRoute,
	rejectedRefreshRoute,
	reposRoute,
	runScheduled,
	seedRefreshToken,
	storedRefreshToken,
	transferRoute,
	transferUrl,
};
export type { RepoFixture };
