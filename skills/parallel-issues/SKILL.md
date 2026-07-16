---
name: parallel-issues
description: Implement an exact GitHub issue frontier with isolated writers, deterministic assembly, one combined independent review, and one final suite gate.
disable-model-invocation: true
license: MIT
---

# Parallel Issues

The run controller owns state, Git operations, evidence validity, and scheduling. Models only write or review code. Follow the controller; do not recreate its state machine in prose.

## Invariants

- Start from a clean attached parent checkout and immutable baseline.
- Use exact issue IDs. GitHub dependency facts and frontier selection are deterministic.
- One cwd-bound writer per issue worktree; one writer at a time in the assembly worktree.
- Assembly is deterministic and stops on conflicts. No model resolves Git conflicts.
- One independent reviewer covers Standards, Spec per issue, and Interactions on the exact assembled tree.
- Writers run focused checks only. The controller runs the full suite after clean review.
- Review and suite evidence is valid only for its exact tree.
- Never reset, force-clean, push, overwrite changed parent state, or improvise around controller failures.

## Driver loop

1. Call `parallel_issue_run` with `action=open`, the deterministic local checkout root, GitHub `owner/repository`, exact issue IDs, a collision-resistant run ID, execution mode, and the repository's documented full-suite command. If an existing run is rejected as unsupported or mismatched, call `action=inspect` for read-only diagnostics; never improvise a current workflow from legacy generated agents.
2. The result contains zero or more jobs. Launch every job in the same `parallelGroup` together in one `subagent children` call, using each returned generated agent and its exact `model`/`thinking` fields. The controller also embeds that routing in generated agent frontmatter.
3. Every job requests JSON-only output. Parse it and call `parallel_issue_run action=submit` with the exact `jobId` and receipt.
4. After submitting the group's receipts, call `parallel_issue_run action=next`.
5. Repeat steps 2–4 until the controller returns a terminal state.

Do not launch a planner, worktree manager, integrator, separate Standards/Spec reviewers, or per-issue reviewers. Do not ask writers to run the full suite.

## Terminal handling

Success is `CLEANED`. Stop and report exact controller evidence for:

- `BLOCKED` — issue needs a decision or implementation failed;
- `INTEGRATION_CONFLICT` — deterministic assembly failed;
- `REVIEW_EXHAUSTED` — bounded review/repair cycles did not converge;
- `PARENT_CHANGED` — parent checkout changed before landing.

`SUITE_FAILED` is recoverable: the controller returns a repair job, then requires review of the changed tree before another suite run.

Report:

```text
STATUS, RUN, BASELINE, STATE, LANDED_ISSUES, DEFERRED,
REVIEW_ATTEMPTS, SUITE_TREE, SUITE_RESULT, BRANCHES, BLOCKER
```
