import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	bindAgentToCwd,
	MANAGED_MARKER,
	removeManagedAgents,
	WORKFLOW_TEMPLATE_HASH_KEY,
	writeManagedAgent,
} from "../src/managed-agents.ts";

const bundledAgents = join(import.meta.dirname, "..", "agents");

test("only writer and reviewer templates remain and have managed frontmatter", () => {
	assert.deepEqual(readdirSync(bundledAgents).sort(), [
		"reviewer.md",
		"writer.md",
	]);
	for (const file of readdirSync(bundledAgents)) {
		const content = readFileSync(join(bundledAgents, file), "utf8");
		assert.match(content, /^---\n[\s\S]*?\n---/);
		assert.match(content, /^managed-by: pi-parallel-issues$/m);
	}
});

test("cwd binding sets name, mode, and immutable workflow hash", () => {
	const template = readFileSync(join(bundledAgents, "writer.md"), "utf8");
	const bound = bindAgentToCwd({
		template,
		name: "parallel-test-writer",
		cwd: "/tmp/worktrees/path # literal",
		mode: "interactive",
		workflowTemplateHash: "abc123",
	});
	assert.match(bound, /^name: parallel-test-writer$/m);
	assert.match(bound, /^cwd: \/tmp\/worktrees\/path # literal$/m);
	assert.match(bound, /^mode: interactive$/m);
	assert.equal(bound.includes(`${WORKFLOW_TEMPLATE_HASH_KEY}: abc123\n`), true);
});

test("managed writes preserve unmanaged collisions", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
	const path = join(target, "writer.md");
	writeFileSync(path, "user owned\n");
	assert.throws(
		() =>
			writeManagedAgent(
				path,
				readFileSync(join(bundledAgents, "writer.md"), "utf8"),
			),
		/unmanaged agent/,
	);
});

test("uninstall removes only managed generated definitions", () => {
	const target = mkdtempSync(join(tmpdir(), "pi-parallel-agents-"));
	writeFileSync(join(target, "generated.md"), `${MANAGED_MARKER}\n`);
	writeFileSync(join(target, "user.md"), "user owned\n");
	assert.deepEqual(removeManagedAgents(target), ["generated.md"]);
	assert.equal(readFileSync(join(target, "user.md"), "utf8"), "user owned\n");
});
