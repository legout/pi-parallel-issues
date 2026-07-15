import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntimeReadiness } from "../src/doctor.ts";

const config = {
  version: 2 as const,
  models: {
    planner: "provider/planner",
    worktreeManager: "provider/utility",
    implementer: "provider/implementer",
    reviewer: "provider/reviewer",
    integrator: "provider/integrator",
  },
};

test("doctor accepts complete tools and configured available models", () => {
  const result = checkRuntimeReadiness({
    toolNames: ["subagent", "subagent_resume"],
    availableModels: Object.values(config.models),
    config,
    agentConflicts: [],
    checkGitHub: false,
  });
  assert.equal(result.ok, true);
});

test("doctor reports missing runtime capabilities and stale model references", () => {
  const result = checkRuntimeReadiness({
    toolNames: ["subagent"],
    availableModels: [config.models.implementer],
    config,
    agentConflicts: ["conflict.md"],
    checkGitHub: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.lines.some((line) => line.includes("subagent_resume")), true);
  assert.equal(result.lines.some((line) => line.includes("provider/reviewer")), true);
  assert.equal(result.lines.some((line) => line.includes("conflict.md")), true);
});
