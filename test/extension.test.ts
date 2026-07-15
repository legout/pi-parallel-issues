import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("extension registers commands and deterministic tools while installing managed agents", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-extension-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { default: extension } = await import(`../extensions/index.ts?test=${Date.now()}`);

  const commands: string[] = [];
  const tools: string[] = [];
  const pi = {
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
  };
  extension(pi as never);

  assert.deepEqual(tools, ["parallel_issue_graph", "parallel_issue_worktrees"]);
  assert.deepEqual(commands.sort(), [
    "implement-parallel",
    "parallel-issues-doctor",
    "parallel-issues-refresh-agents",
    "parallel-issues-setup",
    "parallel-issues-uninstall",
  ]);
  assert.equal(existsSync(join(agentDir, "agents", "parallel-issues-planner.md")), true);
  assert.equal(existsSync(join(agentDir, "agents", "parallel-issues-implementer.md")), true);
});
