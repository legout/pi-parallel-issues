import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueDependencyGraph,
  flattenPaginatedPages,
  mapWithConcurrency,
  parseIssueSelection,
  type GitHubClient,
} from "../src/issue-graph.ts";

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    html_url: `https://github.com/acme/repo/issues/${number}`,
    body: `## Acceptance Criteria\n- [ ] update \`src/issue-${number}.ts\`\n- [ ] add tests`,
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    issue_dependencies_summary: {
      blocked_by: 0,
      blocking: 0,
      total_blocked_by: 0,
      total_blocking: 0,
    },
    ...overrides,
  };
}

class FakeClient implements GitHubClient {
  private readonly responses: Record<string, unknown>;

  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  async get(path: string): Promise<unknown> {
    if (!(path in this.responses)) throw new Error(`unexpected API path: ${path}`);
    return this.responses[path];
  }

  async list(path: string): Promise<unknown[]> {
    const value = await this.get(path);
    if (!Array.isArray(value)) throw new Error(`expected list response: ${path}`);
    return value;
  }
}

test("selection parser handles numbers, hashes, and GitHub issue URLs", () => {
  assert.deepEqual(parseIssueSelection("41, #42 https://github.com/acme/repo/issues/43"), {
    numbers: [41, 42, 43],
    repository: "acme/repo",
    hasUnparsedText: false,
  });
  assert.equal(parseIssueSelection("all ready issues").hasUnparsedText, true);
});

test("native dependencies produce deterministic frontier and topological waves without a planner", async () => {
  const one = issue(1);
  const two = issue(2, {
    issue_dependencies_summary: {
      blocked_by: 1,
      blocking: 0,
      total_blocked_by: 1,
      total_blocking: 0,
    },
  });
  const graph = await buildIssueDependencyGraph({
    repository: "acme/repo",
    numbers: [2, 1],
    client: new FakeClient({
      "repos/acme/repo/issues/1": one,
      "repos/acme/repo/issues/2": two,
      "repos/acme/repo/issues/2/dependencies/blocked_by": [one],
    }),
  });

  assert.deepEqual(graph.edges, [{ blocker: 1, blocked: 2 }]);
  assert.deepEqual(graph.frontier, [1]);
  assert.deepEqual(graph.waves, [[1], [2]]);
  assert.deepEqual(graph.deferred, [{ number: 2, reasons: ["open blockers: #1"] }]);
  assert.equal(graph.requiresSemanticPlanner, false);
});

test("paginated dependency pages are flattened so later blockers cannot disappear", () => {
  const firstPage = Array.from({ length: 30 }, (_, index) => issue(index + 10, { state: "closed" }));
  const laterOpenBlocker = issue(99);
  const flattened = flattenPaginatedPages([firstPage, [laterOpenBlocker]], "dependencies/blocked_by");
  assert.equal(flattened.length, 31);
  assert.equal((flattened.at(-1) as { number: number }).number, 99);
});

test("API mapping enforces its concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    },
  );
  assert.equal(peak, 4);
  assert.deepEqual(result, Array.from({ length: 20 }, (_, index) => index * 2));
});

test("planner is requested only for semantic uncertainty or declared overlap", async () => {
  const graph = await buildIssueDependencyGraph({
    repository: "acme/repo",
    numbers: [3, 4],
    client: new FakeClient({
      "repos/acme/repo/issues/3": issue(3, { body: "Implement the feature." }),
      "repos/acme/repo/issues/4": issue(4, {
        body: "## Acceptance Criteria\n- [ ] update `src/shared.ts`\n- [ ] test `src/shared.ts`",
      }),
    }),
  });

  assert.equal(graph.requiresSemanticPlanner, true);
  assert.equal(graph.semanticUncertainties.some((item) => item.includes("#3 has no machine-detectable")), true);
  assert.equal(graph.semanticUncertainties.some((item) => item.includes("#3 declare no path hints")), true);
});
