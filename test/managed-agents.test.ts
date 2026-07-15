import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindAgentToCwd,
  MANAGED_MARKER,
  removeManagedAgents,
  verboseAgentName,
  syncStaticAgents,
} from "../src/managed-agents.ts";

const bundledAgents = join(import.meta.dirname, "..", "agents");

test("every bundled agent starts with parseable frontmatter", () => {
  for (const file of readdirSync(bundledAgents).filter((name) => name.endsWith(".md"))) {
    const content = readFileSync(join(bundledAgents, file), "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, `${file} must start with frontmatter`);
    assert.match(frontmatter[1]!, /^name:\s*\S+/m);
    assert.match(frontmatter[1]!, /^managed-by:\s*pi-parallel-issues$/m);
  }
});

test("cwd binding matches edxeth's raw frontmatter parser", () => {
  const template = readFileSync(join(bundledAgents, "implementer.md"), "utf8");
  const cwd = "/tmp/worktrees/path # literal";
  const bound = bindAgentToCwd(template, "parallel-test-implementer", cwd);
  const parsedCwd = bound.match(/^cwd:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(parsedCwd, cwd);
  assert.equal(bound.startsWith("---\n"), true);
});

test("interactive cwd bindings retain the generated name and foreground mode", () => {
  const template = readFileSync(join(bundledAgents, "implementer.md"), "utf8");
  const bound = bindAgentToCwd(template, "parallel-test-implementer", "/tmp/worktree", "interactive");
  assert.match(bound, /^name: parallel-test-implementer$/m);
  assert.match(bound, /^mode: interactive$/m);
});

test("sync installs and updates only managed agent definitions", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
  const first = syncStaticAgents(bundledAgents, target);
  assert.equal(first.installed.length, 10);
  assert.equal(first.conflicts.length, 0);
  const verbosePlanner = join(target, `${verboseAgentName("issue-planner")}.md`);
  assert.match(readFileSync(verbosePlanner, "utf8"), /^name: issue-planner-verbose$/m);
  assert.match(readFileSync(verbosePlanner, "utf8"), /^mode: interactive$/m);

  const planner = join(target, "issue-planner.md");
  writeFileSync(planner, `${MANAGED_MARKER}\nstale\n`);
  const second = syncStaticAgents(bundledAgents, target);
  assert.deepEqual(second.updated, [planner]);
  assert.match(readFileSync(planner, "utf8"), /name: issue-planner/);
  assert.equal(readFileSync(planner, "utf8").startsWith("---\n"), true);
});

test("sync preserves unmanaged collisions and uninstall removes only managed files", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
  const collision = join(target, "issue-planner.md");
  writeFileSync(collision, "user owned\n");

  const result = syncStaticAgents(bundledAgents, target);
  assert.deepEqual(result.conflicts, [collision]);
  assert.equal(readFileSync(collision, "utf8"), "user owned\n");

  const removed = removeManagedAgents(target);
  assert.equal(removed.length, 9);
  assert.equal(readFileSync(collision, "utf8"), "user owned\n");
});
