import { spawnSync } from "node:child_process";
import type { ParallelIssuesConfig } from "./config.ts";

export interface RuntimeReadiness {
  ok: boolean;
  lines: string[];
}

export function checkRuntimeReadiness(input: {
  toolNames: string[];
  availableModels: string[];
  config: ParallelIssuesConfig | null;
  agentConflicts: string[];
  checkGitHub?: boolean;
}): RuntimeReadiness {
  const lines: string[] = [];
  const missingTools = ["subagent", "subagent_resume"].filter(
    (name) => !input.toolNames.includes(name),
  );
  lines.push(missingTools.length ? `FAIL runtime tools: missing ${missingTools.join(", ")}` : "OK runtime tools");
  lines.push(
    input.agentConflicts.length
      ? `FAIL agent conflicts: ${input.agentConflicts.join(", ")}`
      : "OK managed agents",
  );

  if (!input.config) {
    lines.push("FAIL models: not configured");
  } else {
    const missingModels = Object.values(input.config.models).filter(
      (model) => !input.availableModels.includes(model),
    );
    lines.push(
      missingModels.length
        ? `FAIL models unavailable: ${[...new Set(missingModels)].join(", ")}`
        : "OK configured models",
    );
  }

  if (input.checkGitHub !== false) {
    const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    lines.push(gh.status === 0 ? "OK GitHub CLI authentication" : "FAIL GitHub CLI authentication");
  }
  lines.push("INFO required external package: git:github.com/edxeth/pi-subagents@v2.5.3");
  lines.push("INFO optional enhancements: npm:pi-lens, npm:@ff-labs/pi-fff");
  return { ok: lines.every((line) => !line.startsWith("FAIL")), lines };
}
