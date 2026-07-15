---
name: parallel-issues
description: Implement independent GitHub issues concurrently with persistent worktrees, independent Standards and Spec reviews, deterministic integration, and final review. Use when asked to implement multiple ready issues in parallel.
disable-model-invocation: true
license: MIT
---

# Parallel Issues

Run the complete protocol. The parent is an orchestrator; implementation, review, worktree management, and integration belong to named subagents.

The `/implement-parallel` command injects four user-approved role model references. Use those exact model values in `subagent` launches. The implementer and reviewer models must remain different. Do not invent or upgrade models.

## Invariants

- Start from a clean parent checkout and one recorded baseline SHA.
- Only ready, unblocked, mutually independent issues are eligible.
- One persistent worktree and branch belong to each eligible issue.
- At most one writing agent runs in a worktree at a time.
- Standards and Spec reviewers are read-only and use the configured reviewer model, not the implementer model.
- No issue is integrated until both review axes are clean and focused validation passes.
- Integrate deterministically by issue number. Stop on conflicts; never improvise a merge or reset user work.
- Cap review/fix cycles at three per issue and three after integration.

## 1. Resolve scope

Launch one synchronous `parallel-issues-planner` subagent with the configured planner model. Give it the user's exact issue selection. Require repository root, current branch, baseline SHA, exact porcelain status, complete eligible issue briefs, deferred issues and reasons, dependencies, and overlap risks.

Stop if the parent is dirty, the baseline is ambiguous, no issue is eligible, or eligible issues depend on one another. Report deferrals rather than silently dropping them. Choose a collision-resistant safe run ID such as `20260715-issue-41-42`.

## 2. Create persistent worktrees

Launch `parallel-issues-worktree-manager` with the configured planner model. Ask it to call `parallel_issue_worktrees` with action `prepare`, the repository, baseline, run ID, and eligible issue numbers. The result contains each worktree, branch, generated implementer agent, and generated reviewer agent. Stop on setup error. Do not edit the parent checkout while issue pipelines run.

## 3. Implement concurrently

Make one `subagent` call with `children`, exactly one child per eligible issue in issue-number order. Use each generated implementer agent and the configured implementer model. Give every child a self-contained issue brief, acceptance criteria, relevant documentation paths, shared baseline, branch, and worktree. State that the parent owns independent review. Require focused validation and a committed result.

Record each child session file because remediation must use `subagent_resume`. A candidate succeeds only when its commit descends from the baseline, has a non-empty diff, leaves a clean worktree, and validation passed. Ask the worktree manager for `status` and verify those facts. Defer failed candidates with exact reasons.

## 4. Review every candidate concurrently

For every successful candidate, launch two read-only children in one `subagent children` batch using its generated reviewer agent and the configured reviewer model:

- **Standards:** exact `<baseline>...<issue-head>` diff, repository standards, and this smell baseline: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest. Repository standards override smell heuristics; skip tooling-enforced issues.
- **Spec:** the same exact diff plus the issue's complete specification and acceptance criteria. Check missing or partial requirements, scope creep, and incorrect behavior.

Use distinct issue-and-axis names and titles. Require `VERDICT=clean|findings` and numbered actionable findings. Review the committed diff, not implementation prose.

## 5. Remediate and repeat

Group findings by issue. Resume each original implementer session with both review reports verbatim. Require fixes, focused validation, and a remediation commit. Then verify new heads and clean worktrees through the manager and rerun both review axes only for changed issues. Repeat until clean or three cycles have run. Defer issues that remain unclean, fail validation, or require unresolved product or architecture decisions.

## 6. Integrate

Launch `parallel-issues-integrator` in the parent checkout with the configured integrator model. Provide repository root, parent branch, baseline and original clean status, reviewed branches/worktrees in issue order, deferred issues, overlap warnings, and verification commands.

The integrator verifies unchanged parent state, inspects every baseline diff, applies binary-safe patches in order, stops on conflict, runs typechecking and the full test suite once, and creates one integrated commit only after verification passes. Require `BASELINE`, `HEAD`, `LANDED`, `DEFERRED`, changed files, and exact verification results.

## 7. Final integrated review

Against exact `<baseline>...HEAD`, launch Standards and Spec `parallel-issues-code-reviewer` children together with the configured reviewer model. The Spec review covers all landed issues and groups findings by issue.

If either axis has actionable findings, resume the original integrator with both reports. Require fixes, full relevant verification, and a remediation commit, then rerun both axes. Stop after three cycles rather than claiming success with findings.

## 8. Cleanup and report

Only after clean final review, ask the worktree manager to call `parallel_issue_worktrees` with action `cleanup`, without force. Cleanup removes clean worktrees and generated agent definitions but retains issue branches for recovery. If cleanup fails, report retained paths and do not destroy dirty worktrees.

End with:

```text
STATUS=success|failed
RUN=<run-id>
BASELINE=<sha>
HEAD=<sha>
LANDED=<issue list>
DEFERRED=<issue list and reasons>
PER_ISSUE_REVIEW=<cycles and verdicts>
FINAL_REVIEW=<cycles and verdicts>
VERIFICATION=<commands and results>
WORKTREES=<cleaned|retained paths and reasons>
BRANCHES=<issue:number=branch list>
```
