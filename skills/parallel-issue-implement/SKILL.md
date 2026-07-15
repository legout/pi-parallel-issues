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
- Use red-green development where the repository exposes a stable public seam: write one failing behavior test, add the minimum implementation, and repeat vertically.
- Test through public interfaces rather than private implementation details.
- Do not add speculative behavior or abstractions outside the issue.
- Run typechecking and focused tests regularly, then the full required suite once at the end.
- Do not run independent code review; the parent owns separate Standards and Spec reviews.
- Commit only intended tracked changes with a concise Conventional Commits subject.
- Return commit SHA, branch, changed files, validation commands/results, and blockers.
- When resumed with review findings, address every actionable finding, validate, and commit remediation.

## Integrator

- Integrate only approved issue diffs and only in the supplied deterministic order.
- Use binary-safe Git patches and stop on the first conflict or changed parent state.
- Never reset, clean, or silently resolve user work.
- Run the full required verification on the integrated state before committing.
- Use a concise Conventional Commits subject: `<type>(<scope>): <imperative summary>`.
- Do not push.
