import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntimeReadiness } from "../src/doctor.ts";

const config = {
  version: 3 as const,
  models: {
    planner: { model: "provider/planner", reasoningEffort: "high" as const },
    worktreeManager: { model: "provider/utility", reasoningEffort: "low" as const },
    implementer: { model: "provider/implementer", reasoningEffort: "high" as const },
    reviewer: { model: "provider/reviewer", reasoningEffort: "medium" as const },
    integrator: { model: "provider/integrator", reasoningEffort: "high" as const },
  },
};

test("doctor accepts complete tools and configured available models", () => {
  const result = checkRuntimeReadiness({
    toolNames: ["subagent", "subagent_resume"],
    availableModels: Object.values(config.models).map(({ model }) => model),
    config,
    agentConflicts: [],
    checkGitHub: false,
  });
  assert.equal(result.ok, true);
});

test("doctor reports missing runtime capabilities and stale model references", () => {
  const result = checkRuntimeReadiness({
    toolNames: ["subagent"],
    availableModels: [config.models.implementer.model],
    config,
    agentConflicts: ["conflict.md"],
    checkGitHub: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.lines.some((line) => line.includes("subagent_resume")), true);
  assert.equal(result.lines.some((line) => line.includes("provider/reviewer")), true);
  assert.equal(result.lines.some((line) => line.includes("conflict.md")), true);
});

test("doctor reports a reasoning effort no longer supported by a configured model", () => {
  const result = checkRuntimeReadiness({
    toolNames: ["subagent", "subagent_resume"],
    availableModels: Object.values(config.models).map(({ model }) => model),
    availableReasoningEfforts: {
      "provider/planner": ["low", "medium"],
      "provider/utility": ["low"],
      "provider/implementer": ["high"],
      "provider/reviewer": ["medium"],
      "provider/integrator": ["high"],
    },
    config,
    agentConflicts: [],
    checkGitHub: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.lines.some((line) => line.includes("planner=provider/planner:high")), true);
});
