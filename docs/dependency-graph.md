# Deterministic issue dependency graph

Dependency and readiness are data problems, not language-model problems. GitHub facts determine which exact issues may enter a run; a model must not invent competing edges or silently broaden scope.

## Controller facts

`parallel_issue_run open` reads:

- issue identity, state, title, URL, and body;
- labels and assignees;
- native `blocked_by` edges;
- open versus closed blockers;
- workflow deferrals such as `needs-info`, `wontfix`, or missing `ready-for-agent`;
- the current frontier and topological waves;
- local repository root, branch, baseline SHA, and porcelain status.

Only the current eligible frontier receives implementation worktrees. Later waves are reported as deferred and should begin in a new run from the newly landed baseline.

## No semantic routing

The graph deliberately does not extract:

- acceptance-criteria counts;
- backticked path hints;
- predicted code overlap;
- semantic uncertainty scores.

These signals previously existed only to decide whether to launch a planner. The uniform workflow has no planner:

- a writer plans its issue inside the existing implementation call;
- genuine product ambiguity returns `needs_decision` and blocks safely;
- actual textual conflicts stop deterministic patch assembly;
- logical cross-issue conflicts are reviewed on the real assembled tree.

This removes speculative model routing without weakening the canonical dependency graph.

## Decision table

| Situation | Controller result |
|---|---|
| Exact ready issues in the same frontier | create isolated writer jobs |
| Requested issue has an open blocker | defer with blocker evidence |
| Requested issues span dependency waves | run only the current frontier; defer later waves |
| Missing specification body | defer instead of inventing intent |
| Dirty checkout or detached HEAD | reject before creating artifacts |
| Free-form selection | reject; resolve exact IDs before execution |
| Candidate patches conflict | stop at `INTEGRATION_CONFLICT` |

## Why not infer dependencies from prose?

Text such as “after #42” may be useful to a repository linter, but GitHub’s native dependency relation is canonical. Prose inference creates duplicate truth, stale edges, and false confidence. An LLM may report a suspected missing dependency for human follow-up, but it must never mutate the run graph silently.

## Guardrail

The graph determines scheduling only. It does not certify implementation correctness. Focused writer checks, combined independent review, and the final full-suite gate operate on committed trees after scheduling.
