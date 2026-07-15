import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig, type ParallelIssuesConfig } from "../src/config.ts";

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
		existsSync(join(agentDir, "agents", "issue-planner.md")),
		true,
	);
	assert.equal(
		existsSync(join(agentDir, "agents", "implementer.md")),
		true,
	);

	let selectorCalls = 0;
	const setupContext = {
		hasUI: true,
		mode: "tui",
		modelRegistry: {
			getAvailable: () => [
				{ provider: "openai", id: "gpt", reasoning: true },
				{ provider: "anthropic", id: "claude", reasoning: true },
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
  assert.equal(selectorCalls, 10);
  assert.deepEqual(readConfig(agentDir), {
    version: 3,
    models: {
      planner: { model: "anthropic/claude", reasoningEffort: "high" },
      worktreeManager: { model: "anthropic/claude", reasoningEffort: "low" },
      implementer: { model: "anthropic/claude", reasoningEffort: "high" },
      reviewer: { model: "openai/gpt", reasoningEffort: "medium" },
      integrator: { model: "anthropic/claude", reasoningEffort: "high" },
    },
  });
});

test("setup filters unsupported reasoning efforts and routing preserves every configured effort", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-parallel-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const extensionModule = await import(`../extensions/index.ts?capabilities=${Date.now()}`);
	const { default: extension, formatRoleRouting, supportedReasoningEfforts } = extensionModule;

	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	extension({
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		registerTool() {},
	} as never);

	const models = [
		{
			provider: "anthropic",
			id: "claude",
			reasoning: true,
			thinkingLevelMap: {
				off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: null, max: null,
			},
		},
		{ provider: "openai", id: "gpt", reasoning: true },
		{ provider: "provider", id: "utility", reasoning: false },
	];
	assert.deepEqual(
		supportedReasoningEfforts({ modelRegistry: { getAvailable: () => models } } as never, "anthropic/claude"),
		["low", "medium"],
	);
	assert.deepEqual(
		supportedReasoningEfforts({ modelRegistry: { getAvailable: () => models } } as never, "openai/gpt"),
		["off", "minimal", "low", "medium", "high"],
	);
	assert.deepEqual(
		supportedReasoningEfforts({ modelRegistry: { getAvailable: () => models } } as never, "provider/utility"),
		["off"],
	);

	const renderedSelectors: string[] = [];
	const setupContext = {
		hasUI: true,
		mode: "tui",
		modelRegistry: { getAvailable: () => models },
		ui: {
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | null) => void) => unknown) =>
				await new Promise<string | null>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{ matches: (data: string, binding: string) => binding === "tui.select.confirm" && data === "enter" },
						resolve,
					) as { render(width: number): string[]; handleInput(data: string): void };
					renderedSelectors.push(component.render(120).join("\n"));
					component.handleInput("enter");
				}),
			notify() {},
		},
	};
	const setup = commands.get("parallel-issues-setup");
	assert.ok(setup);
	await setup("", setupContext);
	const plannerReasoningSelector = renderedSelectors[1];
	assert.ok(plannerReasoningSelector);
	assert.match(plannerReasoningSelector, /Filter reasoning efforts/);
	assert.match(plannerReasoningSelector, /→ medium/);
	assert.doesNotMatch(plannerReasoningSelector, /high/);

	const config = readConfig(agentDir);
	assert.ok(config);
	assert.equal(config.models.planner.reasoningEffort, "medium");
	const routing = formatRoleRouting(config);
	for (const [role, { model, reasoningEffort }] of Object.entries(config.models)) {
		assert.match(routing, new RegExp(`${role === "worktreeManager" ? "worktree manager" : role}: model=${model}, thinking=${reasoningEffort}`));
	}

	const explicitConfig: ParallelIssuesConfig = {
		version: 3,
		models: {
			planner: { model: "provider/planner", reasoningEffort: "xhigh" },
			worktreeManager: { model: "provider/utility", reasoningEffort: "off" },
			implementer: { model: "provider/implementer", reasoningEffort: "high" },
			reviewer: { model: "provider/reviewer", reasoningEffort: "minimal" },
			integrator: { model: "provider/integrator", reasoningEffort: "medium" },
		},
	};
	assert.match(formatRoleRouting(explicitConfig), /planner: model=provider\/planner, thinking=xhigh/);
	assert.match(formatRoleRouting(explicitConfig), /worktree manager: model=provider\/utility, thinking=off/);
});
