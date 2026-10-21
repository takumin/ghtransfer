# Builds the reviewdog runner matrix for CI out of `task --list-all --json`,
# so adding a runner is a task change rather than a workflow change.
#
# `pnpm-install` says whether a shard needs node_modules. Task's JSON carries no
# dependency list to derive it from, so the runners that need it are named
# here, and a name that no longer matches a task is an error rather than a
# shard that silently installs nothing.
def needs_pnpm: ["reviewdog:oxlint"];

[.tasks[].name | select(startswith("reviewdog:") and . != "reviewdog:default" and . != "reviewdog:matrix")]
| . as $targets
| if (needs_pnpm - $targets) != []
	then error("no such reviewdog task: \(needs_pnpm - $targets | join(", "))")
	else {
		include: [
			$targets[] | {
				name: split(":") | last,
				target: .,
				"pnpm-install": (. as $t | needs_pnpm | index($t) != null | tostring),
			}
		]
	}
	end
