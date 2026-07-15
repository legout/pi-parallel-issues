# pi-parallel-issues

Installable parallel GitHub issue implementation for [Pi](https://github.com/earendil-works/pi): persistent issue worktrees, independent Standards and Spec reviews, deterministic integration, and bounded remediation loops.

## What it installs

- `/implement-parallel <issues>` — complete orchestration command.
- `/parallel-issues-setup` — choose the model for each role.
- `/parallel-issues-doctor` — verify runtime tools, managed agents, and model configuration.
- `parallel_issue_worktrees` — controlled worktree lifecycle tool.
- `parallel-issues` — the orchestration skill, also available as `/skill:parallel-issues`.
- `parallel-issue-implement` — implementation discipline injected into workers.
- Four managed static agent definitions plus generated cwd-bound implementer/reviewer agents.

## Requirements

- Pi 0.80.7 or newer.
- Git and Node.js 22 or newer.
- `gh` authenticated for repositories whose issue tracker is GitHub.
- [`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents) v2.5.3 or newer.
- At least two available Pi models so implementation and review use different models.

`pi-lens` and `@ff-labs/pi-fff` are optional. Managed writers list their enhanced diagnostics/search tools, but edxeth/pi-subagents safely ignores unavailable optional tool names; built-in read, Bash, edit, and write remain sufficient.

## Install from GitHub

```bash
pi install git:github.com/edxeth/pi-subagents@v2.5.3
pi install git:github.com/legout/pi-parallel-issues
```

Restart Pi, then configure and verify:

```text
/parallel-issues-setup
/parallel-issues-doctor
```

For a delegation-only parent:

```bash
PI_ORCHESTRATOR_MODE=1 pi
```

Then run:

```text
/implement-parallel 41 42 45
```

A normal Pi session can also run the command. Orchestrator mode simply prevents the parent from doing worker tasks itself.

## Package design

Pi packages natively install extensions, skills, prompts, and themes. They do **not** currently expose an agent-definition resource type. edxeth/pi-subagents discovers named agents only from `.pi/agents/` and `$PI_CODING_AGENT_DIR/agents/`.

This package bridges that seam as follows:

1. Pi loads `extensions/index.ts` from the package manifest.
2. During extension initialization, it synchronizes four marked agent definitions into `$PI_CODING_AGENT_DIR/agents/`.
3. The worktree tool creates issue worktrees and marked cwd-bound agents for each run.
4. Cleanup removes generated agents and clean worktrees while retaining issue branches.
5. `/parallel-issues-uninstall` removes only marked managed agents before package removal.

The synchronizer never overwrites an unmarked user-owned agent with the same filename.

## External skills and patching policy

Matt Pocock's skills are **not runtime dependencies**. This package includes namespaced, adapted workflow text derived from the MIT-licensed `implement`, `tdd`, and two-axis `code-review` ideas. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

We deliberately do not patch files under `~/.agents/skills`, `~/.pi/agent/skills`, or another package's installation directory:

- package updates would overwrite such edits;
- same-name skill discovery is precedence-dependent;
- local customizations would become indistinguishable from package changes.

Instead, the package uses unique skill names:

- `parallel-issues`
- `parallel-issue-implement`

The managed agents allowlist and inject those exact names. This is an **overlay**, not an in-place patch.

The same rule applies to tools. Required functionality is either:

- owned by this package (`parallel_issue_worktrees`), or
- checked as an explicit external capability (`subagent`, `subagent_resume`).

Optional external tools are additive and never required for correctness.

## Workflow

1. A read-only planner resolves issues, blockers, dependencies, overlap, and one clean baseline.
2. A controlled tool creates one persistent worktree and branch per eligible issue.
3. Generated implementers run concurrently and commit focused results.
4. Generated reviewers run Standards and Spec axes independently.
5. Original implementer sessions are resumed to remediate findings, up to three cycles.
6. One integrator applies reviewed diffs in issue order and runs full verification.
7. Two final reviewers inspect the integrated committed diff; the integrator is resumed if needed.
8. Clean worktrees and generated agents are removed; issue branches remain for audit/recovery.

## State and safety

Default locations:

```text
$PI_CODING_AGENT_DIR/pi-parallel-issues.json
~/.pi/parallel-runs/<repo-key>/<run-id>/manifest.json
~/.pi/worktrees/<repo-key>/<run-id>/issue-<N>
$PI_CODING_AGENT_DIR/agents/parallel-*.md
```

Safety properties:

- setup refuses a dirty parent checkout;
- existing branches/worktrees are never overwritten;
- generated identifiers accept only letters, digits, `.`, `_`, and `-`;
- partial setup rolls back only artifacts created by that failed call;
- normal cleanup refuses dirty worktrees;
- integration stops on changed parent state or patch conflict;
- forced cleanup is not used by the orchestration skill.

## Update

```bash
pi update git:github.com/legout/pi-parallel-issues
pi update git:github.com/edxeth/pi-subagents@v2.5.3
```

Restart Pi after updates. Managed static agents refresh automatically; unmarked collisions are reported by `/parallel-issues-doctor`.

## Uninstall

First remove managed agent files:

```text
/parallel-issues-uninstall
```

Then:

```bash
pi remove git:github.com/legout/pi-parallel-issues
```

Remove edxeth/pi-subagents only if no other workflow uses it.

## Development

```bash
npm install
npm run verify
pi -e .
```

`pi -e .` loads the local package for one Pi run without installing it.

## License

MIT. Third-party attributions are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
