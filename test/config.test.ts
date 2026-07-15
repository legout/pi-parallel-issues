import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConfigPath, readConfig, validateConfig } from "../src/config.ts";

test("version 1 configuration migrates worktree manager to planner model", () => {
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
  assert.equal(config.version, 2);
  assert.equal(config.models.worktreeManager, "provider/planner");
});

test("version 2 validates every model-consuming bundled agent role", () => {
  assert.throws(
    () => validateConfig({
      version: 2,
      models: {
        planner: "provider/planner",
        worktreeManager: "missing-provider-separator",
        implementer: "provider/implementer",
        reviewer: "provider/reviewer",
        integrator: "provider/integrator",
      },
    }),
    /models.worktreeManager/,
  );
});
