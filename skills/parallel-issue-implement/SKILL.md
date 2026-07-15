---
name: parallel-issue-implement
description: Implementation and integration discipline for pi-parallel-issues workers. Loaded only by managed implementer and integrator agents.
disable-model-invocation: true
license: MIT
---

# Parallel Issue Implementation

Read repository instructions, domain context, the approved specification, and governing architectural decisions before editing.

## Implementation worker

- Implement exactly the assigned issue in the current worktree and branch.
- Before editing, do a short issue-specific invariant scan: identify existing public seams, cross-object/cross-record invariants, adjacent endpoints that share helpers, and which of those are in scope for the issue. For validation, publication, authorization, storage, or indexing issues, explicitly decide whether validation must run against an isolated proposal or the prospective complete system state.
- Use red-green development where the repository exposes a stable public seam: write one failing behavior test, add the minimum implementation, and repeat vertically.
- Test through public interfaces rather than private implementation details.
- Do not add speculative behavior or abstractions outside the issue.
- Do not run broad autoformatters or reformat unrelated code unless repository documentation explicitly requires that formatter. Prefer surgical edits plus the repo's lint command. If formatting is required, limit it to files intentionally changed for the issue and verify the resulting diff is semantic or mandated.
- Run typechecking and focused tests regularly, then the full required suite once for the final semantic tree. During review remediation, rerun focused regression tests and changed-file lint/type checks first; rerun the full suite only when the tree changed semantically since the last full-suite pass or when the parent explicitly requests it. Do not rerun a long full suite after a no-op amend of an already verified tree.
- Do not run independent code review; the parent owns separate Standards and Spec reviews.
- Commit only intended tracked changes with a concise Conventional Commits subject.
- Before returning, verify `git status --short` and the committed diff. There must be no tracked unstaged changes; leave unrelated untracked user files untouched and report them explicitly.
- Return commit SHA, branch, changed files, validation commands/results, and blockers.
- When resumed with review findings, address every actionable finding that is in the assigned issue scope, validate, and commit remediation. If a finding targets adjacent pre-existing behavior outside the issue, report it as out-of-scope follow-up instead of expanding the implementation without parent confirmation.

## Integrator

- Integrate only approved issue diffs and only in the supplied deterministic order.
- Use binary-safe Git patches and stop on the first conflict or changed parent state.
- Never reset, clean, or silently resolve user work.
- Run the full required verification on the integrated state before committing.
- Use a concise Conventional Commits subject: `<type>(<scope>): <imperative summary>`.
- Do not push.
