import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readConfig,
	writeConfig,
	type ParallelIssuesConfig,
} from "../src/config.ts";

const config: ParallelIssuesConfig = {
	version: 4,
	models: {
		writer: { model: "anthropic/claude", reasoningEffort: "high" },
		reviewer: { model: "openai/gpt", reasoningEffort: "medium" },
	},
};

test("argument parsing and role routing expose one uniform two-role path", async () => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(
		join(tmpdir(), "pi-parallel-extension-"),
	);
	const { formatRoleRouting, parseImplementParallelArguments } = await import(
		`../extensions/index.ts?parse=${Date.now()}`
	);
	assert.deepEqual(parseImplementParallelArguments("--verbose 41 42"), {
		selection: "41 42",
		mode: "interactive",
	});
	const routing = formatRoleRouting(config);
	assert.match(routing, /writer jobs: model=anthropic\/claude/);
	assert.match(routing, /review jobs: model=openai\/gpt/);
	assert.doesNotMatch(routing, /planner|integrator|worktree manager/i);
});

test("extension registers one run-controller tool and four commands", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { default: extension } = await import(
		`../extensions/index.ts?register=${Date.now()}`
	);
	const tools: string[] = [];
	const commands: string[] = [];
	extension({
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as never);
	assert.deepEqual(tools, ["parallel_issue_run"]);
	assert.deepEqual(commands.sort(), [
		"implement-parallel",
		"parallel-issues-doctor",
		"parallel-issues-setup",
		"parallel-issues-uninstall",
	]);
});

test("setup selects only writer and independent reviewer model plus reasoning", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { default: extension } = await import(
		`../extensions/index.ts?setup=${Date.now()}`
	);
	const commands = new Map<
		string,
		(args: string, ctx: unknown) => Promise<void>
	>();
	extension({
		registerTool() {},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, command.handler);
		},
		getAllTools: () => [{ name: "subagent" }],
	} as never);

	let selections = 0;
	const models = [
		{ provider: "anthropic", id: "claude", reasoning: true },
		{ provider: "openai", id: "gpt", reasoning: true },
	];
	const ctx = {
		hasUI: true,
		mode: "rpc",
		model: models[0],
		modelRegistry: { getAvailable: () => models },
		ui: {
			select: async (_title: string, choices: string[]) => {
				selections += 1;
				return choices[0];
			},
			notify() {},
		},
	};
	await commands.get("parallel-issues-setup")?.("", ctx);
	assert.equal(selections, 4);
	assert.deepEqual(readConfig(agentDir), {
		version: 4,
		models: {
			writer: { model: "anthropic/claude", reasoningEffort: "high" },
			reviewer: { model: "openai/gpt", reasoningEffort: "medium" },
		},
	});
});

test("implement command accepts exact IDs and injects the deterministic driver loop", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-parallel-command-"));
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-b", "main", repo]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ scripts: { verify: "node --test" } }),
	);
	execFileSync("git", ["-C", repo, "add", "package.json"]);
	execFileSync("git", ["-C", repo, "commit", "-m", "chore: fixture"]);
	execFileSync("git", [
		"-C",
		repo,
		"remote",
		"add",
		"origin",
		"git@github.com:acme/repo.git",
	]);

	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeConfig(config, agentDir);
	const { default: extension } = await import(
		`../extensions/index.ts?command=${Date.now()}`
	);
	const commands = new Map<
		string,
		(args: string, ctx: unknown) => Promise<void>
	>();
	let sent = "";
	extension({
		registerTool() {},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, command.handler);
		},
		getAllTools: () => [{ name: "subagent" }],
		sendUserMessage(message: string) {
			sent = message;
		},
	} as never);
	const models = [
		{ provider: "anthropic", id: "claude", reasoning: true },
		{ provider: "openai", id: "gpt", reasoning: true },
	];
	await commands.get("implement-parallel")?.("41 42", {
		cwd: repo,
		hasUI: true,
		mode: "rpc",
		model: models[0],
		modelRegistry: { getAvailable: () => models },
		ui: { notify() {} },
	});
	assert.match(sent, /parallel_issue_run/);
	assert.match(sent, /"issues": \[\s*41,\s*42\s*\]/);
	assert.match(sent, /Use fullSuiteCommand="npm run verify"/);
	assert.match(sent, /Do not launch a planner/);
});
