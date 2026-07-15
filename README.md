# pi-parallel-issues

Installable parallel GitHub issue implementation for [Pi](https://github.com/earendil-works/pi): persistent issue worktrees, independent Standards and Spec reviews, deterministic integration, and bounded remediation loops.

## What it installs

- `/implement-parallel <issues>` — complete orchestration command.
- `/parallel-issues-setup` — choose the model for each role.
- `/parallel-issues-doctor` — verify runtime tools, managed agents, and model configuration.
- `parallel_issue_graph` — build GitHub dependency edges, frontier, waves, and deterministic deferrals without an LLM.
- `parallel_issue_worktrees` — controlled worktree lifecycle tool.
- `parallel-issues` — the orchestration skill, also available as `/skill:parallel-issues`.
- `parallel-issue-implement` — implementation discipline injected into workers.
- Five managed role agents plus generated cwd-bound implementer/reviewer copies for each issue.

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
2. During extension initialization, it synchronizes five marked agent definitions into `$PI_CODING_AGENT_DIR/agents/`.
3. The worktree tool creates issue worktrees and derives cwd-bound implementer/reviewer definitions from the bundled role templates. edxeth v2.5.3 requires `cwd` in agent frontmatter; its launch tool does not accept `cwd` as a parameter.
4. Cleanup removes clean worktrees and generated agents while retaining issue branches.
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

## Bundled agents

| Agent | Why it is bundled | Model setup role |
|---|---|---|
| `parallel-issues-planner` | Resolves only specification and overlap uncertainty left by the deterministic graph | semantic planner |
| `parallel-issues-worktree-manager` | Calls the controlled worktree tool when orchestrator mode hides non-subagent tools | worktree manager |
| `parallel-issues-implementer` | Source template for cwd-bound issue writers; each generated session is resumed for remediation | implementer |
| `parallel-issues-code-reviewer` | Source template for cwd-bound read-only Standards or Spec reviewers | reviewer |
| `parallel-issues-integrator` | Applies reviewed diffs, verifies the integrated state, and handles final remediation | integrator |

The package intentionally does not bundle generic `Explore` or `general-purpose` agents; those are not workflow roles and may already exist in a user's edxeth setup. It also does not add an LLM-based dependency-graph agent, conflict resolver, or separate verifier: graph construction is deterministic, conflicts stop integration, and verification belongs to implementers/integrator. Extra agents there would add calls without creating a deeper interface.

`/parallel-issues-setup` asks for the model of every model-consuming bundled agent. The worktree manager can use a small inexpensive model because it only calls one constrained tool.

## Workflow

1. The extension reads the clean checkout baseline and builds the native GitHub dependency graph programmatically.
2. A semantic planner runs only when acceptance criteria or likely code overlap cannot be decided from structured evidence.
3. A controlled tool creates one persistent worktree and branch per eligible frontier issue.
4. Generated cwd-bound implementer agents run concurrently and commit focused results.
5. Generated cwd-bound reviewers run Standards and Spec axes independently.
6. Original implementer sessions are resumed to remediate findings, up to three cycles.
7. One integrator applies reviewed diffs in issue order and runs full verification.
8. Two final reviewers inspect the integrated committed diff; the integrator is resumed if needed.
9. Clean worktrees and generated agents are removed; issue branches remain for audit/recovery.

See [`docs/dependency-graph.md`](docs/dependency-graph.md) for the deterministic/semantic split and the conditions that trigger a planner call.

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
