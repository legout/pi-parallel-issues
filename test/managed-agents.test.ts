import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_MARKER, removeManagedAgents, syncStaticAgents } from "../src/managed-agents.ts";

const bundledAgents = join(import.meta.dirname, "..", "agents");

test("sync installs and updates only managed agent definitions", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
  const first = syncStaticAgents(bundledAgents, target);
  assert.equal(first.installed.length, 4);
  assert.equal(first.conflicts.length, 0);

  const planner = join(target, "parallel-issues-planner.md");
  writeFileSync(planner, `${MANAGED_MARKER}\nstale\n`);
  const second = syncStaticAgents(bundledAgents, target);
  assert.deepEqual(second.updated, [planner]);
  assert.match(readFileSync(planner, "utf8"), /name: parallel-issues-planner/);
});

test("sync preserves unmanaged collisions and uninstall removes only managed files", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
  const collision = join(target, "parallel-issues-planner.md");
  writeFileSync(collision, "user owned\n");

  const result = syncStaticAgents(bundledAgents, target);
  assert.deepEqual(result.conflicts, [collision]);
  assert.equal(readFileSync(collision, "utf8"), "user owned\n");

  const removed = removeManagedAgents(target);
  assert.equal(removed.length, 3);
  assert.equal(readFileSync(collision, "utf8"), "user owned\n");
});
