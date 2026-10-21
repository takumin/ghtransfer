/**
 * The one structured log entry every run leaves: what src/run.ts returned, or what it threw.
 * Workers Logs fills its Level column from the entry's own `level`, and `wrangler tail` has only the
 * console method to go by, so emit() picks the method off the field.
 */

import type { Completed, Outcome } from "./run";

/**
 * @octokit/request builds an error message from the response body and takes the whole body when it
 * is not JSON, so a message arrives unbounded however short the error it names.
 */
const MAX_ERROR_MESSAGE_CHARS = 512;

type LogLevel = "error" | "info" | "warn";

/** A run's log entry: its level, flat fields, and the per-repository lists a completed run carries. */
type LogEntry = Readonly<Record<string, number | string | readonly unknown[]>> & {
	readonly level: LogLevel;
};

/* oxlint-disable eslint/no-console -- the run's one entry: `console` is the only sink a Worker has */
const LEVEL_SINK: Record<LogLevel, (entry: LogEntry) => void> = {
	error: (entry) => {
		console.error(entry);
	},
	info: (entry) => {
		console.info(entry);
	},
	warn: (entry) => {
		console.warn(entry);
	},
};
/* oxlint-enable eslint/no-console */

function emit(entry: LogEntry): void {
	LEVEL_SINK[entry.level](entry);
}

/**
 * A refused transfer is an error: it will be refused again tomorrow until someone looks (a name
 * already taken on the target is the usual cause). Deferred repositories are only a warning — the
 * next run takes them — but a run that defers every day is one falling behind.
 */
function completedLevel(outcome: Completed): LogLevel {
	if (outcome.failed.length > 0) {
		return "error";
	}
	if (outcome.deferred.length > 0) {
		return "warn";
	}
	return "info";
}

function logOutcome(env: Env, outcome: Outcome): void {
	if (outcome.kind !== "completed") {
		emit({ level: "error", outcome: outcome.kind, versionId: env.CF_VERSION_METADATA.id });
		return;
	}
	emit({
		deferred: outcome.deferred,
		failed: outcome.failed,
		from: env.SOURCE_OWNER,
		level: completedLevel(outcome),
		outcome: outcome.kind,
		to: env.TARGET_OWNER,
		transferred: outcome.transferred,
		versionId: env.CF_VERSION_METADATA.id,
	});
}

/** A run that threw: the token refresh, the KV put or the listing failed, or something unforeseen. */
function logFailure(env: Env, error: unknown): void {
	let name: string = typeof error;
	let message = String(error);
	if (error instanceof Error) {
		({ message, name } = error);
	}
	emit({
		errorMessage: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
		errorName: name,
		level: "error",
		outcome: "internal-error",
		versionId: env.CF_VERSION_METADATA.id,
	});
}

export { MAX_ERROR_MESSAGE_CHARS, logFailure, logOutcome };
export type { LogEntry, LogLevel };
