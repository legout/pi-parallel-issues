import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  buildIssueDependencyGraph,
  type CheckoutSnapshot,
  type IssueDependencyGraph,
  parseIssueSelection,
  readCheckoutSnapshot,
  resolveGitHubRepository,
} from "../src/issue-graph.ts";
import {
  removeManagedAgents,
  syncStaticAgents,
  verboseAgentName,
  type AgentLaunchMode,
  type SyncAgentsResult,
} from "../src/managed-agents.ts";
import { selectModel, selectReasoningEffort } from "../src/model-selector.ts";
import { cleanupRun, prepareRun, runStatus } from "../src/worktrees.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = getPiAgentDir();
const installedAgentsDir = join(agentDir, "agents");
let syncResult: SyncAgentsResult = syncStaticAgents(join(packageRoot, "agents"), installedAgentsDir);

function modelRefs(ctx: ExtensionContext): string[] {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
  const refs = [...new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`))];
  refs.sort((a, b) => a.localeCompare(b));
  return current ? [current, ...refs.filter((ref) => ref !== current)] : refs;
}

export function supportedReasoningEfforts(ctx: ExtensionContext, modelRef: string): ReasoningEffort[] {
  const model = ctx.modelRegistry.getAvailable().find(
    (candidate) => `${candidate.provider}/${candidate.id}` === modelRef,
  ) ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}` === modelRef ? ctx.model : undefined);
  if (!model?.reasoning) return ["off"];
  return REASONING_EFFORTS.filter((effort) => {
    const mapped = model.thinkingLevelMap?.[effort];
    if (mapped === null) return false;
    return effort !== "xhigh" && effort !== "max" || mapped !== undefined;
  });
}

function reasoningEffortsByModel(ctx: ExtensionContext): Record<string, ReasoningEffort[]> {
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
  for (let candidate = index; candidate < REASONING_EFFORTS.length; candidate++) {
    const effort = REASONING_EFFORTS[candidate]!;
    if (supported.includes(effort)) return effort;
  }
  for (let candidate = index - 1; candidate >= 0; candidate--) {
    const effort = REASONING_EFFORTS[candidate]!;
    if (supported.includes(effort)) return effort;
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
  const fallback = nearestSupportedReasoningEffort(recommendedEffort, reasoningEfforts);
  if (!fallback) {
    ctx.ui.notify(`Model ${model} does not support any selectable reasoning effort.`, "error");
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
  const content = readFileSync(join(packageRoot, "skills", "parallel-issues", "SKILL.md"), "utf8");
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

function readiness(pi: ExtensionAPI, ctx: ExtensionContext, config: ParallelIssuesConfig | null) {
  return checkRuntimeReadiness({
    toolNames: pi.getAllTools().map((tool) => tool.name),
    availableModels: modelRefs(ctx),
    availableReasoningEfforts: reasoningEffortsByModel(ctx),
    config,
    agentConflicts: syncResult.conflicts,
  });
}

export function formatRoleRouting(config: ParallelIssuesConfig): string {
  return [
    "User-approved role model routing:",
    `- planner: model=${config.models.planner.model}, thinking=${config.models.planner.reasoningEffort}`,
    `- worktree manager: model=${config.models.worktreeManager.model}, thinking=${config.models.worktreeManager.reasoningEffort}`,
    `- implementer: model=${config.models.implementer.model}, thinking=${config.models.implementer.reasoningEffort}`,
    `- reviewer: model=${config.models.reviewer.model}, thinking=${config.models.reviewer.reasoningEffort}`,
    `- integrator: model=${config.models.integrator.model}, thinking=${config.models.integrator.reasoningEffort}`,
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

export function formatExecutionRouting(mode: AgentLaunchMode): string {
  const agent = (name: string) => mode === "interactive" ? verboseAgentName(name) : name;
  return [
    `Subagent execution mode: ${mode}.`,
    mode === "interactive"
      ? "This invocation requested --verbose. Every subagent must use an interactive foreground pane; do not launch a background agent."
      : "Use background agents for this invocation.",
    "Use these exact static agent definitions:",
    `- planner: ${agent("issue-planner")}`,
    `- worktree manager: ${agent("worktree-manager")}`,
    `- integrator: ${agent("integrator")}`,
    `- final reviewers: ${agent("code-reviewer")}`,
    `When preparing worktrees, pass mode=${mode} to parallel_issue_worktrees. Use only the generated implementer and reviewer definitions it returns; they are bound to the same execution mode.`,
  ].join("\n");
}

export function formatDeterministicIssueContext(
  checkout: CheckoutSnapshot,
  graph: IssueDependencyGraph | null,
): string {
  if (!graph) {
    return [
      `Deterministic checkout snapshot:\n${JSON.stringify(checkout, null, 2)}`,
      "Issue graph unavailable because the selection is not an exact list of issue numbers or URLs. The planner must resolve the selection.",
    ].join("\n\n");
  }
  const fastPath = graph.requested.length === 1
    ? [
      "Single-issue fast path directive:",
      "- Exactly one issue was requested, so do not launch the semantic planner just to restate the issue.",
      "- If the graph node is eligible, launch the implementer directly with the issue body, acceptance criteria, and semantic uncertainties as risks.",
      "- Ask the user only for a genuine product/architecture decision that cannot be inferred from the issue, repo standards, or existing behavior.",
      "- Do not request a full suite from the implementer; the integrator owns the final full-suite gate.",
      "- If the graph node is ineligible, report the deterministic deferral or stop condition.",
    ].join("\n")
    : null;
  const deterministic = `Deterministic checkout snapshot and issue graph (GitHub REST; no LLM used):\n${JSON.stringify({ checkout, graph }, null, 2)}`;
  return fastPath ? `${fastPath}\n\n${deterministic}` : deterministic;
}

export default function parallelIssuesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "parallel_issue_graph",
    label: "Parallel issue dependency graph",
    description: "Build a deterministic GitHub issue dependency graph without an LLM call.",
    parameters: Type.Object({
      repository: Type.String({ description: "GitHub owner/repository" }),
      issues: Type.Array(Type.Number({ minimum: 1 }), { minItems: 1, maxItems: 50 }),
    }),
    async execute(_toolCallId, params) {
      const graph = await buildIssueDependencyGraph({
        repository: params.repository,
        numbers: params.issues,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(graph, null, 2) }],
        details: graph,
      };
    },
  });

  pi.registerTool({
    name: "parallel_issue_worktrees",
    label: "Parallel issue worktrees",
    description: "Create, inspect, or clean persistent issue worktrees managed by pi-parallel-issues.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("prepare"), Type.Literal("status"), Type.Literal("cleanup")]),
      repo: Type.String(),
      run: Type.String(),
      baseline: Type.Optional(Type.String()),
      issues: Type.Optional(Type.Array(Type.String())),
      mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("interactive")])),
      force: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      let result: unknown;
      if (params.action === "prepare") {
        if (!params.baseline || !params.issues?.length) {
          throw new Error("prepare requires baseline and at least one issue");
        }
        result = prepareRun({
          repo: params.repo,
          baseline: params.baseline,
          run: params.run,
          issues: params.issues,
          ...(params.mode === undefined ? {} : { mode: params.mode }),
        });
      } else if (params.action === "status") {
        result = runStatus({ repo: params.repo, run: params.run });
      } else {
        result = cleanupRun({
          repo: params.repo,
          run: params.run,
          ...(params.force === undefined ? {} : { force: params.force }),
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerCommand("parallel-issues-setup", {
    description: "Choose role models and reasoning effort for parallel issue implementation",
    handler: async (_args, ctx) => {
      const choices = modelRefs(ctx);
      if (!ctx.hasUI || choices.length < 2) {
        ctx.ui.notify("Setup needs interactive UI and at least two available models.", "error");
        return;
      }
      const planner = await selectRoleModel(
        ctx, "Semantic planner agent model", choices, ROLE_REASONING_DEFAULTS.planner,
      );
      if (!planner) return;
      const worktreeManager = await selectRoleModel(
        ctx,
        "Worktree manager agent model (small/cheap is sufficient)",
        choices,
        ROLE_REASONING_DEFAULTS.worktreeManager,
      );
      if (!worktreeManager) return;
      const implementer = await selectRoleModel(
        ctx, "Implementer agent model", choices, ROLE_REASONING_DEFAULTS.implementer,
      );
      if (!implementer) return;
      const reviewer = await selectRoleModel(
        ctx,
        "Code reviewer agent model (must differ from implementer)",
        choices.filter((choice) => choice !== implementer.model),
        ROLE_REASONING_DEFAULTS.reviewer,
      );
      if (!reviewer) return;
      const integrator = await selectRoleModel(
        ctx, "Integrator agent model", choices, ROLE_REASONING_DEFAULTS.integrator,
      );
      if (!integrator) return;

      const config: ParallelIssuesConfig = {
        version: 3,
        models: { planner, worktreeManager, implementer, reviewer, integrator },
      };
      const path = writeConfig(config, agentDir);
      ctx.ui.notify(`Saved role models and reasoning effort to ${path}`, "info");
    },
  });

  pi.registerCommand("parallel-issues-doctor", {
    description: "Check package, agents, models, and subagent runtime",
    handler: async (_args, ctx) => {
      let config: ParallelIssuesConfig | null = null;
      let configError: string | null = null;
      try {
        config = readConfig(agentDir);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
      const result = readiness(pi, ctx, config);
      if (configError) result.lines.splice(2, 1, `FAIL models invalid: ${configError}`);
      ctx.ui.notify(result.lines.join("\n"), result.ok && !configError ? "info" : "error");
    },
  });

  pi.registerCommand("implement-parallel", {
    description: "Implement independent issues concurrently; add --verbose for foreground agent panes",
    handler: async (args, ctx) => {
      let config: ParallelIssuesConfig | null;
      try {
        config = readConfig(agentDir);
      } catch (error) {
        ctx.ui.notify(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!config) {
        ctx.ui.notify("Run /parallel-issues-setup first.", "error");
        return;
      }
      const result = readiness(pi, ctx, config);
      if (!result.ok) {
        ctx.ui.notify(result.lines.join("\n"), "error");
        return;
      }
      const { selection, mode } = parseImplementParallelArguments(args);
      if (!selection) {
        ctx.ui.notify("Usage: /implement-parallel [--verbose] <issue numbers, URLs, or selection>", "error");
        return;
      }
      let graphContext: string;
      try {
        const parsed = parseIssueSelection(selection);
        const [currentRepository, checkout] = await Promise.all([
          resolveGitHubRepository(ctx.cwd),
          readCheckoutSnapshot(ctx.cwd),
        ]);
        if (checkout.porcelain) {
          ctx.ui.notify(`Parent checkout is not clean:\n${checkout.porcelain}`, "error");
          return;
        }
        if (!checkout.branch) {
          ctx.ui.notify("Parent checkout is in detached HEAD state.", "error");
          return;
        }
        if (parsed.repository && parsed.repository.toLowerCase() !== currentRepository.toLowerCase()) {
          ctx.ui.notify(
            `Selected issues belong to ${parsed.repository}, but this checkout is ${currentRepository}.`,
            "error",
          );
          return;
        }
        const graph = parsed.numbers.length && !parsed.hasUnparsedText
          ? await buildIssueDependencyGraph({ repository: currentRepository, numbers: parsed.numbers })
          : null;
        graphContext = formatDeterministicIssueContext(checkout, graph);
      } catch (error) {
        ctx.ui.notify(
          `Could not build deterministic issue context: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      const routing = formatRoleRouting(config);
      const execution = formatExecutionRouting(mode);
      pi.sendUserMessage(`${skillBody()}\n\n${routing}\n\n${execution}\n\n${graphContext}\n\nUser issue selection:\n${selection}`);
    },
  });

  pi.registerCommand("parallel-issues-uninstall", {
    description: "Remove agent files managed by this package before uninstalling it",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const confirmed = await ctx.ui.confirm(
        "Remove managed agents?",
        "This removes only agent files marked as managed by pi-parallel-issues. Active worktrees and branches are preserved.",
      );
      if (!confirmed) return;
      const removed = removeManagedAgents(installedAgentsDir);
      ctx.ui.notify(`Removed ${removed.length} managed agent file(s). Now run pi remove for the package.`, "info");
    },
  });

  pi.registerCommand("parallel-issues-refresh-agents", {
    description: "Refresh managed agent definitions from the installed package",
    handler: async (_args, ctx) => {
      syncResult = syncStaticAgents(join(packageRoot, "agents"), installedAgentsDir);
      ctx.ui.notify(JSON.stringify(syncResult, null, 2), syncResult.conflicts.length ? "error" : "info");
    },
  });
}
