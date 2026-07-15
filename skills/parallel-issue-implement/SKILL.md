---
name: parallel-issue-implement
description: Implementation and integration discipline for pi-parallel-issues workers. Loaded only by managed implementer and integrator agents.
disable-model-invocation: true
license: MIT
---

# Parallel Issue Implementation

Read repo instructions, issue spec, and governing decisions before editing.

## Implementation worker

- Implement exactly the assigned issue on the supplied branch/worktree.
- First scan issue seams/invariants: public entrypoints, shared helpers, cross-record/system invariants, adjacent endpoints, and what is in scope. For validation/publication/auth/storage/indexing, decide whether checks must use isolated input or complete prospective state.
- Use public-interface, vertical tests where practical; avoid private-test lock-in.
- No speculative behavior, sibling issues, broad refactors, or broad autoformatting. Format only intended files when repo docs require it.
- Validate with focused tests plus changed-file lint/type checks. **Do not run the full suite unless the parent explicitly asks or the issue changes global test/runtime infrastructure.** The integrator owns the final full-suite gate.
- Commit only intended tracked changes. Before returning, confirm `git status --short` has no tracked unstaged changes; leave unrelated untracked files untouched and report them.
- Return commit SHA, branch, changed files, focused validation commands/results, and blockers.
- On review resume, fix actionable in-scope findings, run focused regression validation, and commit/amend. Report adjacent out-of-scope findings instead of expanding scope silently.

## Integrator

- Integrate only parent-approved issue diffs in deterministic order.
- Verify parent branch/baseline/clean state; apply binary-safe patches; stop on conflict.
- Run cheap/focused integration checks and create the integration candidate commit before final review.
- After final review is clean, run the full suite once on the final tree and record the tree hash. Reuse a passing full-suite result for the same tree; rerun only after code changes.
- Never reset, clean, push, or silently resolve user work.
