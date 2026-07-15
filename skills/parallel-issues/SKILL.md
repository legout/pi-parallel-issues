---
name: parallel-issues
description: Implement independent GitHub issues concurrently with persistent worktrees, independent Standards and Spec reviews, deterministic integration, and final review. Use when asked to implement multiple ready issues in parallel.
disable-model-invocation: true
license: MIT
---

# Parallel Issues

You orchestrate; subagents do the work. Use injected `model`/`thinking`, execution mode, and generated worktree-bound implementer/reviewer agents exactly.

## Rules

- Clean parent checkout, one baseline SHA, one issue branch/worktree, one writer per worktree.
- Eligible issues are ready, unblocked, independent, and in the current graph frontier.
- Implementers run focused validation only; **the integrator owns the full-suite final gate**.
- Full suite runs the absolute minimum: normally once after final integrated review is clean. Reuse a pass by `git rev-parse HEAD^{tree}`; never rerun for unchanged/no-op-amended trees.
- Reviewers are read-only and use reviewer model. Max 3 review/fix cycles per issue and after integration.
- Stop on dirty parent state, conflicts, setup errors, or unresolved decisions; never reset/clean/improvise over user work.

## 1. Resolve scope

Use deterministic graph facts first: GitHub state, labels, assignees, dependency edges, frontier/waves, deferrals.

- Exact single issue + graph: fast path. No planner, no contract-confirmation question unless a real product/architecture choice is unknowable. If eligible, brief implementer from graph body/criteria and pass semantic uncertainties as risks; otherwise report deferral.
- Graph without semantic uncertainty: use `frontier`; no planner.
- Graph with semantic uncertainty: planner resolves only spec sufficiency and likely code/file overlap.
- Free-form selection: planner resolves exact issues, then uses `parallel_issue_graph` when available.

Only this frontier enters the wave; defer later waves. Choose a safe run id.

## 2. Prepare and implement

Prepare worktrees via `parallel_issue_worktrees prepare` directly or through worktree-manager. Pass repo, baseline, run id, issue ids, and mode.

Launch implementers together, issue-number order. Each brief includes issue criteria, relevant docs, baseline, branch/worktree, scope limits, and focused validation expectations. Require commit SHA, changed files, focused commands/results, blockers, and clean tracked worktree. Do not request a full suite unless the issue changes global test/runtime infrastructure.

Verify with worktree-manager `status`: head descends from baseline, diff non-empty, tracked tree clean, focused validation passed. Defer failures with reasons.

## 3. Review and remediate candidates

For each candidate, launch Standards and Spec reviewers together against `<baseline>...<issue-head>`.

- Standards: repo standards plus smell heuristics; skip tooling-enforced issues.
- Spec: issue body/criteria. Adjacent pre-existing behavior blocks only when in issue scope or newly depended on by the diff; otherwise follow-up.

Require `VERDICT=clean|findings`; findings cite diff plus quoted requirement/standard. Resume original implementer for in-scope findings, require focused regression validation and commit/amend, verify status, rerun both axes only for changed issues, repeat up to 3 cycles.

## 4. Integrate, final review, full-suite gate

Integrator verifies parent state, applies approved diffs in issue order with binary-safe patches, stops on conflict, runs cheap/focused integration checks, and creates an integration candidate commit. It does not run the full suite yet.

Run final Standards and Spec reviews against `<baseline>...HEAD`. If findings are actionable, resume integrator for focused fixes and rerun final reviews. Once final review is clean, run the full suite once on the final tree and record tree hash, command, result, and whether reused. If code changes after that pass, repeat focused checks and one full suite on the new final tree.

## 5. Cleanup and report

After clean final review and passing/reused full-suite gate, cleanup worktrees without force; retain dirty/failed paths. Report:

```text
STATUS, RUN, BASELINE, HEAD, LANDED, DEFERRED,
PER_ISSUE_REVIEW, FINAL_REVIEW, FULL_SUITE,
WORKTREES, BRANCHES
```
