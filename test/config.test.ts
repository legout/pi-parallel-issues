import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConfigPath, readConfig, validateConfig } from "../src/config.ts";

test("legacy configuration migrates role models and reasonable reasoning defaults", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-config-"));
  writeFileSync(getConfigPath(agentDir), JSON.stringify({
    version: 1,
    models: {
      planner: "provider/planner",
      implementer: "provider/implementer",
      reviewer: "provider/reviewer",
      integrator: "provider/integrator",
    },
  }));
  const config = readConfig(agentDir)!;
  assert.equal(config.version, 3);
  assert.deepEqual(config.models.worktreeManager, { model: "provider/planner", reasoningEffort: "low" });
  assert.deepEqual(config.models.implementer, { model: "provider/implementer", reasoningEffort: "high" });
});

test("version 2 configuration migrates models without changing model routing", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-config-"));
  writeFileSync(getConfigPath(agentDir), JSON.stringify({
    version: 2,
    models: {
      planner: "provider/planner",
      worktreeManager: "provider/utility",
      implementer: "provider/implementer",
      reviewer: "provider/reviewer",
      integrator: "provider/integrator",
    },
  }));
  const config = readConfig(agentDir)!;
  assert.equal(config.models.planner.model, "provider/planner");
  assert.equal(config.models.worktreeManager.model, "provider/utility");
  assert.equal(config.models.reviewer.reasoningEffort, "medium");
});

test("version 3 validates every model-consuming bundled agent role and reasoning effort", () => {
  assert.throws(
    () => validateConfig({
      version: 3,
      models: {
        planner: { model: "provider/planner", reasoningEffort: "high" },
        worktreeManager: { model: "missing-provider-separator", reasoningEffort: "low" },
        implementer: { model: "provider/implementer", reasoningEffort: "high" },
        reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
        integrator: { model: "provider/integrator", reasoningEffort: "high" },
      },
    }),
    /models.worktreeManager/,
  );
  assert.throws(
    () => validateConfig({
      version: 3,
      models: {
        planner: { model: "provider/planner", reasoningEffort: "high" },
        worktreeManager: { model: "provider/utility", reasoningEffort: "low" },
        implementer: { model: "provider/implementer", reasoningEffort: "unsupported" as never },
        reviewer: { model: "provider/reviewer", reasoningEffort: "medium" },
        integrator: { model: "provider/integrator", reasoningEffort: "high" },
      },
    }),
    /reasoningEffort/,
  );
});
