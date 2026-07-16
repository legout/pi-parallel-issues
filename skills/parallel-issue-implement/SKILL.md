---
name: parallel-issue-implement
description: Writing discipline for pi-parallel-issues implementation and assembled-candidate repair jobs.
disable-model-invocation: true
license: MIT
---

# Parallel Issue Writer

Read repository instructions, the supplied issue or findings, and only the named governing decisions before editing. Expand discovery only to resolve a concrete uncertainty.

## Before editing

Create a concise requirement-to-seam-to-focused-test matrix inside the current call. Identify public entrypoints, shared invariants, adjacent endpoints, authorization/storage/indexing implications, and explicit non-goals. If a product decision cannot be inferred safely, return `outcome=needs_decision` instead of inventing intent.

## Implementation job

- Implement exactly the assigned issue in the supplied worktree.
- Prefer public-interface, vertical behavior tests.
- Do not implement sibling issues, speculative abstractions, broad refactors, or unrelated formatting.
- Run focused tests plus changed-file lint/type checks. Never run the full suite; the run controller owns that final gate.
- Commit intended tracked changes and verify the tracked worktree is clean.

## Repair job

- Change only what is needed for the supplied integrated-review or suite findings.
- Reproduce each finding where practical, add focused regressions, and preserve unrelated assembled behavior.
- Commit the repair and leave the tracked worktree clean.
- Any changed tree must be reviewed again; do not run the full suite yourself.

Return exactly the structured receipt requested by the job. The controller independently verifies commit ancestry, tree state, and cleanliness.
