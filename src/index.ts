/**
 * Worker entry point: the cron trigger (wrangler.jsonc) and nothing else. There is no fetch
 * handler, so the Worker answers no request and its refresh token is reachable only through KV.
 */

import { logFailure, logOutcome } from "./log";
import { runTransfer } from "./run";

/* Every run leaves exactly one log entry. A thrown failure is logged and then rethrown, so the
 * cron event is also recorded as failed in the dashboard's trigger history. */
async function runAndLog(env: Env): Promise<void> {
	try {
		const outcome = await runTransfer(env);
		logOutcome(env, outcome);
	} catch (error) {
		logFailure(env, error);
		throw error;
	}
}

// oxlint-disable-next-line import/no-default-export -- the Workers runtime takes its handler as the module's default export
export default {
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		await runAndLog(env);
	},
} satisfies ExportedHandler<Env>;
