import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	getPiAgentDir,
	readConfig,
	REASONING_EFFORTS,
	ROLE_REASONING_DEFAULTS,
	writeConfig,
	type ParallelIssuesConfig,
	type ReasoningEffort,
	type RoleModelConfig,
} from "../src/config.ts";
import { checkRuntimeReadiness } from "../src/doctor.ts";
import {
	parseIssueSelection,
	readCheckoutSnapshot,
	resolveGitHubRepository,
} from "../src/issue-graph.ts";
import {
	removeManagedAgent,
	removeManagedAgents,
	type AgentLaunchMode,
} from "../src/managed-agents.ts";
import { selectModel, selectReasoningEffort } from "../src/model-selector.ts";
import {
	cleanupRun,
	inspectRun,
	nextRun,
	openRun,
	statusRun,
	submitRun,
	type RunReceipt,
} from "../src/run.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = getPiAgentDir();
const installedAgentsDir = join(agentDir, "agents");
for (const file of [
	"issue-planner.md",
	"issue-planner-verbose.md",
	"worktree-manager.md",
	"worktree-manager-verbose.md",
	"implementer.md",
	"implementer-verbose.md",
	"code-reviewer.md",
	"code-reviewer-verbose.md",
	"integrator.md",
	"integrator-verbose.md",
]) {
	removeManagedAgent(join(installedAgentsDir, file));
}

function modelRefs(ctx: ExtensionContext): string[] {
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
	const refs = [
		...new Set(
			ctx.modelRegistry
				.getAvailable()
				.map((model) => `${model.provider}/${model.id}`),
		),
	];
	refs.sort((a, b) => a.localeCompare(b));
	return current ? [current, ...refs.filter((ref) => ref !== current)] : refs;
}

export function supportedReasoningEfforts(
	ctx: ExtensionContext,
	modelRef: string,
): ReasoningEffort[] {
	const model =
		ctx.modelRegistry
			.getAvailable()
			.find(
				(candidate) => `${candidate.provider}/${candidate.id}` === modelRef,
			) ??
		(ctx.model && `${ctx.model.provider}/${ctx.model.id}` === modelRef
			? ctx.model
			: undefined);
	if (!model?.reasoning) return ["off"];
	return REASONING_EFFORTS.filter((effort) => {
		const mapped = model.thinkingLevelMap?.[effort];
		if (mapped === null) return false;
		return (effort !== "xhigh" && effort !== "max") || mapped !== undefined;
	});
}

function reasoningEffortsByModel(
	ctx: ExtensionContext,
): Record<string, ReasoningEffort[]> {
	return Object.fromEntries(
		ctx.modelRegistry.getAvailable().map((model) => {
			const ref = `${model.provider}/${model.id}`;
			return [ref, supportedReasoningEfforts(ctx, ref)];
		}),
	);
}

function nearestSupportedReasoningEffort(
	recommended: ReasoningEffort,
	supported: ReasoningEffort[],
): ReasoningEffort | undefined {
	const index = REASONING_EFFORTS.indexOf(recommended);
	for (
		let candidate = index;
		candidate < REASONING_EFFORTS.length;
		candidate += 1
	) {
		const effort = REASONING_EFFORTS[candidate];
		if (effort && supported.includes(effort)) return effort;
	}
	for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
		const effort = REASONING_EFFORTS[candidate];
		if (effort && supported.includes(effort)) return effort;
	}
	return undefined;
}

async function selectRoleModel(
	ctx: ExtensionContext,
	title: string,
	modelChoices: string[],
	recommendedEffort: ReasoningEffort,
): Promise<RoleModelConfig | null> {
	const model = await selectModel(ctx, title, modelChoices);
	if (!model) return null;
	const reasoningEfforts = supportedReasoningEfforts(ctx, model);
	const fallback = nearestSupportedReasoningEffort(
		recommendedEffort,
		reasoningEfforts,
	);
	if (!fallback) {
		ctx.ui.notify(
			`Model ${model} does not support any selectable reasoning effort.`,
			"error",
		);
		return null;
	}
	const reasoningEffort = await selectReasoningEffort(
		ctx,
		`${title} reasoning effort (recommended: ${fallback})`,
		fallback,
		reasoningEfforts,
	);
	return reasoningEffort ? { model, reasoningEffort } : null;
}

function skillBody(): string {
	const content = readFileSync(
		join(packageRoot, "skills", "parallel-issues", "SKILL.md"),
		"utf8",
	);
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

function readiness(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: ParallelIssuesConfig | null,
) {
	return checkRuntimeReadiness({
		toolNames: pi.getAllTools().map((tool) => tool.name),
		availableModels: modelRefs(ctx),
		availableReasoningEfforts: reasoningEffortsByModel(ctx),
		config,
	});
}

export function formatRoleRouting(config: ParallelIssuesConfig): string {
	return [
		"User-approved model routing:",
		`- writer jobs: model=${config.models.writer.model}, thinking=${config.models.writer.reasoningEffort}`,
		`- review jobs: model=${config.models.reviewer.model}, thinking=${config.models.reviewer.reasoningEffort}`,
	].join("\n");
}

export function parseImplementParallelArguments(args: string): {
	selection: string;
	mode: AgentLaunchMode;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const verbose = tokens.includes("--verbose");
	return {
		selection: tokens.filter((token) => token !== "--verbose").join(" "),
		mode: verbose ? "interactive" : "background",
	};
}

function inferredSuiteCommand(
	cwd: string,
	config: ParallelIssuesConfig,
): string | null {
	if (config.fullSuiteCommand) return config.fullSuiteCommand;
	const packageFile = join(cwd, "package.json");
	if (!existsSync(packageFile)) return null;
	try {
		const packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as {
			scripts?: Record<string, string>;
		};
		if (packageJson.scripts?.verify) return "npm run verify";
		if (packageJson.scripts?.test) return "npm test";
	} catch {
		return null;
	}
	return null;
}

const receiptSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("implementation"),
		issue: Type.Number({ minimum: 1 }),
		outcome: Type.Union([
			Type.Literal("ready"),
			Type.Literal("needs_decision"),
			Type.Literal("failed"),
		]),
		commit: Type.Optional(Type.String()),
		focusedChecks: Type.Optional(Type.Array(Type.String())),
		blocker: Type.Optional(Type.String()),
	}),
	Type.Object({
		kind: Type.Literal("review"),
		tree: Type.String(),
		verdict: Type.Union([Type.Literal("clean"), Type.Literal("findings")]),
		findings: Type.Array(Type.String()),
	}),
	Type.Object({
		kind: Type.Literal("repair"),
		previousTree: Type.String(),
		commit: Type.String(),
		focusedChecks: Type.Array(Type.String(), { minItems: 1 }),
	}),
]);

export default function parallelIssuesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "parallel_issue_run",
		label: "Parallel issue run controller",
		description:
			"Open and advance an immutable deterministic issue implementation run.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("open"),
				Type.Literal("inspect"),
				Type.Literal("next"),
				Type.Literal("submit"),
				Type.Literal("status"),
				Type.Literal("cleanup"),
			]),
			repo: Type.String({ description: "Absolute local checkout root" }),
			run: Type.String(),
			repository: Type.Optional(
				Type.String({ description: "GitHub owner/repository; open only" }),
			),
			issues: Type.Optional(
				Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 }),
			),
			fullSuiteCommand: Type.Optional(Type.String()),
			mode: Type.Optional(
				Type.Union([Type.Literal("background"), Type.Literal("interactive")]),
			),
			jobId: Type.Optional(Type.String()),
			receipt: Type.Optional(receiptSchema),
		}),
		async execute(_toolCallId, params) {
			let result: unknown;
			if (params.action === "open") {
				if (
					!params.repository ||
					!params.issues?.length ||
					!params.fullSuiteCommand
				) {
					throw new Error(
						"open requires repository, issues, and fullSuiteCommand",
					);
				}
				const config = readConfig(agentDir);
				if (!config)
					throw new Error("run /parallel-issues-setup before opening a run");
				result = await openRun({
					repo: params.repo,
					repository: params.repository,
					issues: params.issues,
					run: params.run,
					fullSuiteCommand: params.fullSuiteCommand,
					models: config.models,
					...(params.mode ? { mode: params.mode } : {}),
				});
			} else if (params.action === "inspect") {
				result = inspectRun({ repo: params.repo, run: params.run });
			} else if (params.action === "next") {
				result = nextRun({ repo: params.repo, run: params.run });
			} else if (params.action === "submit") {
				if (!params.jobId || !params.receipt)
					throw new Error("submit requires jobId and receipt");
				result = submitRun({
					repo: params.repo,
					run: params.run,
					jobId: params.jobId,
					receipt: params.receipt as RunReceipt,
				});
			} else if (params.action === "status") {
				result = statusRun({ repo: params.repo, run: params.run });
			} else {
				result = cleanupRun({ repo: params.repo, run: params.run });
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerCommand("parallel-issues-setup", {
		description: "Choose writer and independent reviewer models",
		handler: async (_args, ctx) => {
			const choices = modelRefs(ctx);
			if (!ctx.hasUI || choices.length < 2) {
				ctx.ui.notify(
					"Setup needs interactive UI and at least two available models.",
					"error",
				);
				return;
			}
			const writer = await selectRoleModel(
				ctx,
				"Writer model",
				choices,
				ROLE_REASONING_DEFAULTS.writer,
			);
			if (!writer) return;
			const reviewer = await selectRoleModel(
				ctx,
				"Independent reviewer model (must differ from writer)",
				choices.filter((choice) => choice !== writer.model),
				ROLE_REASONING_DEFAULTS.reviewer,
			);
			if (!reviewer) return;
			const path = writeConfig(
				{ version: 4, models: { writer, reviewer } },
				agentDir,
			);
			ctx.ui.notify(`Saved writer/reviewer routing to ${path}`, "info");
		},
	});

	pi.registerCommand("parallel-issues-doctor", {
		description: "Check controller, models, and subagent runtime",
		handler: async (_args, ctx) => {
			let config: ParallelIssuesConfig | null = null;
			let configError: string | null = null;
			try {
				config = readConfig(agentDir);
			} catch (error) {
				configError = error instanceof Error ? error.message : String(error);
			}
			const result = readiness(pi, ctx, config);
			if (configError) {
				const modelsLine = result.lines.findIndex((line) =>
					line.startsWith("FAIL models:"),
				);
				if (modelsLine !== -1)
					result.lines.splice(
						modelsLine,
						1,
						`FAIL models invalid: ${configError}`,
					);
			}
			ctx.ui.notify(
				result.lines.join("\n"),
				result.ok && !configError ? "info" : "error",
			);
		},
	});

	pi.registerCommand("implement-parallel", {
		description:
			"Implement an exact issue frontier with deterministic assembly and one review",
		handler: async (args, ctx) => {
			let config: ParallelIssuesConfig | null;
			try {
				config = readConfig(agentDir);
			} catch (error) {
				ctx.ui.notify(
					`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			if (!config) {
				ctx.ui.notify("Run /parallel-issues-setup first.", "error");
				return;
			}
			const ready = readiness(pi, ctx, config);
			if (!ready.ok) {
				ctx.ui.notify(ready.lines.join("\n"), "error");
				return;
			}
			const { selection, mode } = parseImplementParallelArguments(args);
			const parsed = parseIssueSelection(selection);
			if (!selection || parsed.hasUnparsedText || !parsed.numbers.length) {
				ctx.ui.notify(
					"Usage: /implement-parallel [--verbose] <exact issue numbers or URLs>",
					"error",
				);
				return;
			}
			try {
				const [repository, checkout] = await Promise.all([
					resolveGitHubRepository(ctx.cwd),
					readCheckoutSnapshot(ctx.cwd),
				]);
				if (checkout.porcelain) {
					ctx.ui.notify(
						`Parent checkout is not clean:\n${checkout.porcelain}`,
						"error",
					);
					return;
				}
				if (!checkout.branch) {
					ctx.ui.notify("Parent checkout is in detached HEAD state.", "error");
					return;
				}
				if (
					parsed.repository &&
					parsed.repository.toLowerCase() !== repository.toLowerCase()
				) {
					ctx.ui.notify(
						`Selected issues belong to ${parsed.repository}, but this checkout is ${repository}.`,
						"error",
					);
					return;
				}
				const suiteCommand = inferredSuiteCommand(ctx.cwd, config);
				const suiteDirective = suiteCommand
					? `Use fullSuiteCommand=${JSON.stringify(suiteCommand)} when opening the run.`
					: "Before opening the run, read repository instructions/package metadata and choose its documented full-suite command.";
				pi.sendUserMessage(
					[
						skillBody(),
						formatRoleRouting(config),
						`Execution mode: ${mode}. Pass mode=${mode} when opening the run.`,
						`Deterministic run input:\n${JSON.stringify({ checkout, repository, issues: parsed.numbers }, null, 2)}`,
						suiteDirective,
					].join("\n\n"),
				);
			} catch (error) {
				ctx.ui.notify(
					`Could not prepare run input: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("parallel-issues-uninstall", {
		description:
			"Remove generated agents managed by this package before uninstalling it",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const confirmed = await ctx.ui.confirm(
				"Remove managed agents?",
				"This removes generated pi-parallel-issues agent files. Worktrees, manifests, and branches are preserved.",
			);
			if (!confirmed) return;
			const removed = removeManagedAgents(installedAgentsDir);
			ctx.ui.notify(`Removed ${removed.length} managed agent file(s).`, "info");
		},
	});
}
