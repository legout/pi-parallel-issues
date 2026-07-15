# Deterministic issue dependency graph

Dependency graph creation is a data problem, not a language-model problem. GitHub already stores the relevant facts; an LLM should not be paid to rediscover them or allowed to invent competing edges.

## Split facts from judgement

### Programmatic facts

`parallel_issue_graph` reads these directly from GitHub REST:

- issue identity, state, title, URL, and body;
- labels and assignees;
- native `blocked_by` edges;
- open versus closed blockers;
- workflow deferrals such as `needs-info`, `wontfix`, or a missing `ready-for-agent` label;
- the current frontier and topological waves.

The `/implement-parallel` command also reads Git directly for:

- repository root;
- current branch;
- baseline SHA;
- porcelain status.

These facts are authoritative. A planner may explain them but must not reinterpret them.

### Semantic judgement

A planner remains useful for two questions that GitHub does not answer reliably:

1. Is the issue specification complete enough to implement without product decisions?
2. Are nominally independent issues likely to collide in the same code or interface?

The graph builder detects cheap evidence first:

- acceptance-criteria headings or task lists;
- backticked file/path hints;
- explicit path overlap between requested issues.

If every frontier issue has machine-detectable acceptance criteria and multiple issues declare disjoint paths, `requiresSemanticPlanner` is false and the planner call is skipped. Missing evidence or declared overlap triggers one narrowly scoped semantic-planner call.

## Decision table

| Situation | Graph call | Planner call |
|---|---:|---:|
| Exact issue numbers, complete criteria, disjoint declared paths | yes | no |
| Exact issue numbers, one issue only, complete criteria | yes | no |
| Exact issue numbers, missing criteria or path evidence | yes | yes, semantic questions only |
| Exact issue numbers with native blockers | yes | only if remaining frontier has semantic uncertainty |
| Free-form selection such as “all ready children of #63” | partial checkout snapshot | yes to resolve selection, then graph tool |
| Dirty checkout or detached HEAD | no implementation | no |

## Why not infer dependency edges from prose?

Text such as “after #42” is useful as a migration warning, but GitHub's native dependency relation should be canonical. Prose inference creates duplicate truth, stale edges, and false confidence. A future linter may report prose references that disagree with native edges; it should not silently add edges.

## Further reductions in model use

The current implementation deliberately starts small. The following additions can further narrow semantic planning without weakening correctness:

1. **Issue-form fields.** Adopt structured fields for `affected_paths`, `public_seams`, `acceptance_criteria`, and `verification`. Structured issue forms are stronger evidence than regex extraction.
2. **CODEOWNERS expansion.** Map declared paths to ownership areas and flag shared ownership domains programmatically.
3. **Git co-change matrix.** Build a local matrix from recent commits. Two path hints with high historical co-change frequency indicate collision risk even when the paths differ.
4. **Symbol index lookup.** Resolve backticked symbols and paths through a local identifier index. Compare their modules and transitive dependents rather than asking an LLM to browse broadly.
5. **Test-impact map.** Record which tests cover each module and flag issues whose predicted test sets overlap heavily.
6. **ETag cache.** Cache issue payloads by repository, issue number, and GitHub ETag/`updated_at`; refetch only changed nodes.
7. **Bounded concurrent API reads.** Fetch exact issue nodes concurrently and request dependency lists only when `total_blocked_by` is non-zero, as the current client already does.
8. **Machine-readable readiness policy.** Move required/deferred labels and assignment policy into package configuration for repositories that do not use the Matt Pocock vocabulary.

A useful future collision score could combine:

```text
score = exact_path_overlap
      + shared_module_dependents
      + historical_cochange
      + shared_test_impact
      + shared_codeowner_area
```

Only scores in an uncertain middle band need an LLM. Low scores proceed; high scores serialize automatically.

## Guardrail

An LLM may propose a missing dependency or collision for human review, but it must never mutate the canonical graph silently. Native GitHub edges and explicit structured issue metadata remain the source of truth.
