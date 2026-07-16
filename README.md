# pi-parallel-issues

Installable parallel GitHub issue implementation for [Pi](https://github.com/earendil-works/pi): isolated writers, deterministic assembly, one independent integrated review, and one final full-suite gate.

## What it installs

- `/implement-parallel [--verbose] <exact issues>` — open and drive one immutable run.
- `/parallel-issues-setup` — choose the writer and independent reviewer models.
- `/parallel-issues-doctor` — verify runtime tools, models, and GitHub authentication.
- `parallel_issue_run` — the deterministic run controller.
- `parallel-issues` — the compact controller driver skill.
- `parallel-issue-implement` — implementation/repair discipline injected into writers.
- Two bundled templates: `writer` and `reviewer`. Run-bound copies are generated with hard cwd bindings.

## Requirements

- Pi 0.80.7 or newer.
- Git and Node.js 22 or newer.
- `gh` authenticated for GitHub repositories.
- [`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents) v2.5.3 or newer.
- At least two available Pi models so writing and review use different models.

`pi-lens` and `@ff-labs/pi-fff` are optional enhancements.

## Install

```bash
pi install git:github.com/edxeth/pi-subagents@v2.5.3
pi install git:github.com/legout/pi-parallel-issues
```

Restart Pi, then configure and verify:

```text
/parallel-issues-setup
/parallel-issues-doctor
```

Run exact issue IDs or URLs:

```text
/implement-parallel 41 42 45
```

Use foreground interactive panes when desired:

```text
/implement-parallel --verbose 41 42 45
```

Free-form selection is intentionally outside the execution interface. Resolve “next issues?” first, then pass exact IDs.

## Architecture

Models have only two responsibilities:

| Role | Responsibility |
|---|---|
| Writer | Implement one issue or repair cited findings in an isolated worktree |
| Reviewer | Review the exact assembled tree for Standards, Spec per issue, and Interactions |

The deterministic controller owns everything else:

- checkout and baseline validation;
- GitHub readiness and native dependency facts;
- frontier selection and later-wave deferral;
- worktree and generated-agent lifecycle;
- candidate ancestry, cleanliness, and non-empty-diff verification;
- binary-safe assembly in issue order;
- review/suite evidence keyed to exact tree hashes;
- bounded review/repair cycles;
- parent-state verification, fast-forward landing, and non-forced cleanup.

There is no planner, model-backed worktree manager, per-issue reviewer, or model-driven integrator.

## Uniform workflow

One issue is simply a run with `N=1`:

```text
OPEN → IMPLEMENTING → REVIEW_PENDING → REVIEW_CLEAN
     → SUITE_PASSED → LANDED → CLEANED
```

Recoverable review and suite findings route to the assembly-bound writer and invalidate prior evidence:

```text
REVIEW_FINDINGS ─→ repair ─→ REVIEW_PENDING
SUITE_FAILED ─────→ repair ─→ REVIEW_PENDING
```

Terminal safety stops include:

- `BLOCKED` — an issue needs a decision or implementation failed;
- `INTEGRATION_CONFLICT` — deterministic patch assembly failed;
- `REVIEW_EXHAUSTED` — three review attempts did not converge;
- `PARENT_CHANGED` — the parent checkout changed before landing.

The full suite normally runs once, after clean review. If it fails and code changes, the changed tree must be reviewed before the suite can run again.

Reviewers may run focused or static checks needed to validate a finding, but never the repository full suite. The controller owns that final gate.

## Persistent state

Default locations:

```text
$PI_CODING_AGENT_DIR/pi-parallel-issues.json
~/.pi/parallel-runs/<repo-key>/<run-id>/manifest.json
~/.pi/worktrees/<repo-key>/<run-id>/issue-<N>
~/.pi/worktrees/<repo-key>/<run-id>/integration
$PI_CODING_AGENT_DIR/agents/p-*.md
```

A run’s issue set and template hash are immutable. Package changes require a new run; old runs never acquire newly generated agents. Successful cleanup keeps the compact manifest and audit branches while removing worktrees and generated agent files.

Use `parallel_issue_run action=inspect` for read-only diagnostics when an older manifest cannot be resumed. Inspection reports its version, checkout match, branches, worktrees, generated agents, and safe recovery guidance without modifying the run. Legacy generated agents do not indicate that the current workflow ran.

## Safety

- setup refuses dirty or detached parent checkouts;
- branches, worktrees, manifests, and unmanaged agent files are never overwritten;
- each writable worktree has one cwd-bound writer;
- candidate receipts are independently checked against Git;
- conflicts stop assembly; no model improvises resolutions;
- reviewers are independent and run against one exact assembled tree;
- full-suite evidence is reusable only for the same tree;
- landing requires the parent to remain clean, on the same branch and baseline;
- normal cleanup never forces deletion of dirty worktrees;
- the package never resets, cleans, pushes, or silently drops selected work.

## Configuration migration

Version 1–3 configurations migrate automatically:

- `implementer` becomes `writer`;
- `reviewer` remains `reviewer`;
- planner, worktree-manager, and integrator routing is discarded.

Version 4 configuration is intentionally small:

```json
{
  "version": 4,
  "models": {
    "writer": { "model": "provider/model", "reasoningEffort": "high" },
    "reviewer": { "model": "other/model", "reasoningEffort": "medium" }
  }
}
```

An optional `fullSuiteCommand` may provide a repository-independent default. Otherwise `/implement-parallel` infers common Node scripts or asks the orchestrator to use repository instructions.

## Package design

Pi packages do not expose an agent-definition resource type, while edxeth/pi-subagents requires `cwd` in agent frontmatter. `parallel_issue_run open` therefore derives run-bound definitions from bundled templates and writes them under `$PI_CODING_AGENT_DIR/agents/`. Cleanup removes only definitions marked `managed-by: pi-parallel-issues`.

The package does not patch external skills or another package’s installation directory. Its skills and tools are namespaced overlays.

## Update

```bash
pi update git:github.com/legout/pi-parallel-issues
pi update git:github.com/edxeth/pi-subagents@v2.5.3
```

Restart Pi after updates. Start a new run to use new controller or prompt behavior.

## Uninstall

```text
/parallel-issues-uninstall
```

Then:

```bash
pi remove git:github.com/legout/pi-parallel-issues
```

The uninstall command removes managed generated agents only; manifests, branches, and worktrees are preserved.

## Development

```bash
npm install
npm run verify
pi -e .
```

## License

MIT. Third-party attributions are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
