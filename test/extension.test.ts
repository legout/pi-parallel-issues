import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.ts";

test("extension registers commands and deterministic tools while installing managed agents", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { default: extension } = await import(
		`../extensions/index.ts?test=${Date.now()}`
	);

	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: unknown) => Promise<void>
	>();
	const tools: string[] = [];
	const pi = {
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.push(name);
			commandHandlers.set(name, command.handler);
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
	assert.equal(
		existsSync(join(agentDir, "agents", "parallel-issues-planner.md")),
		true,
	);
	assert.equal(
		existsSync(join(agentDir, "agents", "parallel-issues-implementer.md")),
		true,
	);

	let selectorCalls = 0;
	const setupContext = {
		hasUI: true,
		mode: "tui",
		modelRegistry: {
			getAvailable: () => [
				{ provider: "openai", id: "gpt" },
				{ provider: "anthropic", id: "claude" },
			],
		},
		ui: {
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (value: string | null) => void,
				) => unknown,
			) =>
				await new Promise<string | null>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{
							matches: (data: string, binding: string) =>
								binding === "tui.select.confirm" && data === "enter",
						},
						resolve,
					) as { handleInput(data: string): void };
					component.handleInput("enter");
					selectorCalls++;
				}),
			notify() {},
		},
	};
	await commandHandlers.get("parallel-issues-setup")?.("", setupContext);
	assert.equal(selectorCalls, 5);
	assert.deepEqual(readConfig(agentDir), {
		version: 2,
		models: {
			planner: "anthropic/claude",
			worktreeManager: "anthropic/claude",
			implementer: "anthropic/claude",
			reviewer: "openai/gpt",
			integrator: "anthropic/claude",
		},
	});
});
