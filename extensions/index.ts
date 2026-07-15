import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPiAgentDir, readConfig, writeConfig, type ParallelIssuesConfig } from "../src/config.ts";
import { checkRuntimeReadiness } from "../src/doctor.ts";
import { removeManagedAgents, syncStaticAgents, type SyncAgentsResult } from "../src/managed-agents.ts";
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

async function selectModel(ctx: ExtensionContext, title: string, choices: string[]): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return (await ctx.ui.select(title, choices)) ?? null;
}

function skillBody(): string {
  const content = readFileSync(join(packageRoot, "skills", "parallel-issues", "SKILL.md"), "utf8");
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

function readiness(pi: ExtensionAPI, ctx: ExtensionContext, config: ParallelIssuesConfig | null) {
  return checkRuntimeReadiness({
    toolNames: pi.getAllTools().map((tool) => tool.name),
    availableModels: modelRefs(ctx),
    config,
    agentConflicts: syncResult.conflicts,
  });
}

export default function parallelIssuesExtension(pi: ExtensionAPI) {
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
    description: "Choose role models for parallel issue implementation",
    handler: async (_args, ctx) => {
      const choices = modelRefs(ctx);
      if (!ctx.hasUI || choices.length < 2) {
        ctx.ui.notify("Setup needs interactive UI and at least two available models.", "error");
        return;
      }
      const planner = await selectModel(ctx, "Planner model", choices);
      if (!planner) return;
      const implementer = await selectModel(ctx, "Implementer model", choices);
      if (!implementer) return;
      const reviewer = await selectModel(
        ctx,
        "Reviewer model (must differ from implementer)",
        choices.filter((choice) => choice !== implementer),
      );
      if (!reviewer) return;
      const integrator = await selectModel(ctx, "Integrator model", choices);
      if (!integrator) return;

      const config: ParallelIssuesConfig = {
        version: 1,
        models: { planner, implementer, reviewer, integrator },
      };
      const path = writeConfig(config, agentDir);
      ctx.ui.notify(`Saved role models to ${path}`, "info");
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
    description: "Implement independent issues concurrently with worktrees and independent review",
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
      if (!args.trim()) {
        ctx.ui.notify("Usage: /implement-parallel <issue numbers, URLs, or selection>", "error");
        return;
      }
      const routing = [
        "User-approved role model routing:",
        `- planner: ${config.models.planner}`,
        `- implementer: ${config.models.implementer}`,
        `- reviewer: ${config.models.reviewer}`,
        `- integrator: ${config.models.integrator}`,
      ].join("\n");
      pi.sendUserMessage(`${skillBody()}\n\n${routing}\n\nUser issue selection:\n${args.trim()}`);
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
