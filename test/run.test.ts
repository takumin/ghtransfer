/**
 * A scheduled run end to end, through the handler src/index.ts exports: the token rotation
 * (src/token.ts), the listing and the transfers (src/github.ts, src/run.ts), and the one entry the
 * run leaves (src/log.ts).
 */

import {
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
} from "./fixtures";
import { describe, expect, it } from "vitest";
import { installFetchMock, requestByUrl } from "./fetch-stub";
import { MAX_TRANSFERS_PER_RUN } from "~src/run";

const HTTP_UNPROCESSABLE = 422;
/* Typed at the matcher rather than at its use, `expect.any` being untyped where the entry is not. */
const ANY_MESSAGE: unknown = expect.any(String);

describe("transfers", () => {
	it(
		"transfers only the archived repositories the source owner owns",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			await seedRefreshToken();
			const log = captureLog();
			const session = installFetchMock([
				refreshRoute(),
				reposRoute([
					{ archived: true, name: "alpha" },
					{ archived: false, name: "active" },
					{ archived: true, name: "foreign", owner: "someone-else" },
					{ archived: true, name: "omega" },
				]),
				transferRoute("alpha"),
				transferRoute("omega"),
			]);
			await runScheduled(makeEnv());
			session.assertDone();
			const { body } = requestByUrl(session, transferUrl("alpha"));
			expect(JSON.parse(body)).toStrictEqual({ new_owner: TARGET_OWNER });
			expect(log).toHaveBeenCalledExactlyOnceWith({
				deferred: [],
				failed: [],
				from: SOURCE_OWNER,
				level: "info",
				outcome: "completed",
				to: TARGET_OWNER,
				transferred: ["alpha", "omega"],
				versionId: VERSION_ID,
			});
		},
	);
});

describe("refused transfers", () => {
	it("reports a refused transfer and carries on with the rest", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		await seedRefreshToken();
		const log = captureLog();
		installFetchMock([
			refreshRoute(),
			reposRoute([
				{ archived: true, name: "taken" },
				{ archived: true, name: "fine" },
			]),
			transferRoute("taken", HTTP_UNPROCESSABLE),
			transferRoute("fine"),
		]);
		await runScheduled(makeEnv());
		expect(log).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				failed: [{ message: ANY_MESSAGE, repo: "taken", status: HTTP_UNPROCESSABLE }],
				level: "error",
				transferred: ["fine"],
			}),
		);
	});
});

/* Stated as the cap plus one rather than as a count of its own: a literal would keep passing as a
 * run within the cap once the cap moved. */
describe("per-run cap", () => {
	it("defers what is beyond the cap to the next run", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		await seedRefreshToken();
		const log = captureLog();
		const names = Array.from({ length: MAX_TRANSFERS_PER_RUN + 1 }, (_, index) => `repo-${index}`);
		const due = names.slice(0, MAX_TRANSFERS_PER_RUN);
		const session = installFetchMock([
			refreshRoute(),
			reposRoute(names.map((name) => ({ archived: true, name }))),
			...due.map((name) => transferRoute(name)),
		]);
		await runScheduled(makeEnv());
		session.assertDone();
		expect(log).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				deferred: names.slice(MAX_TRANSFERS_PER_RUN),
				level: "warn",
				transferred: due,
			}),
		);
	});
});

describe("token rotation", () => {
	it("stores the successor and acts with the access token it buys", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		await seedRefreshToken();
		captureLog();
		const session = installFetchMock([refreshRoute(), reposRoute([])]);
		await runScheduled(makeEnv());
		const { body } = requestByUrl(session, OAUTH_TOKEN_URL);
		expect(JSON.parse(body)).toStrictEqual({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: SEEDED_REFRESH_TOKEN,
		});
		const { headers } = requestByUrl(session, REPOS_URL);
		expect(headers["authorization"]).toBe(`token ${ACCESS_TOKEN}`);
		await expect(storedRefreshToken()).resolves.toBe(ROTATED_REFRESH_TOKEN);
	});

	it(
		"logs and rethrows a refused refresh, keeping the stored token",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			await seedRefreshToken();
			const log = captureLog();
			installFetchMock([rejectedRefreshRoute()]);
			await expect(runScheduled(makeEnv())).rejects.toThrow("bad_refresh_token");
			await expect(storedRefreshToken()).resolves.toBe(SEEDED_REFRESH_TOKEN);
			expect(log).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					errorName: "HttpError",
					level: "error",
					outcome: "internal-error",
				}),
			);
		},
	);
});

describe("missing configuration", () => {
	it("does nothing until a refresh token has been seeded", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		await clearRefreshToken();
		const log = captureLog();
		const session = installFetchMock([]);
		await runScheduled(makeEnv());
		expect(session.requests).toHaveLength(0);
		expect(log).toHaveBeenCalledExactlyOnceWith({
			level: "error",
			outcome: "missing-refresh-token",
			versionId: VERSION_ID,
		});
	});

	it(
		"does nothing without the client secret, leaving the token unspent",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			await seedRefreshToken();
			const log = captureLog();
			const session = installFetchMock([]);
			await runScheduled(makeEnv(""));
			expect(session.requests).toHaveLength(0);
			await expect(storedRefreshToken()).resolves.toBe(SEEDED_REFRESH_TOKEN);
			expect(log).toHaveBeenCalledExactlyOnceWith({
				level: "error",
				outcome: "missing-credentials",
				versionId: VERSION_ID,
			});
		},
	);
});
