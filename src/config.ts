import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ParallelIssuesConfig {
  version: 2;
  models: {
    planner: string;
    worktreeManager: string;
    implementer: string;
    reviewer: string;
    integrator: string;
  };
}

export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getConfigPath(agentDir = getPiAgentDir()): string {
  return join(agentDir, "pi-parallel-issues.json");
}

export function readConfig(agentDir = getPiAgentDir()): ParallelIssuesConfig | null {
  const path = getConfigPath(agentDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as
    | ParallelIssuesConfig
    | { version: 1; models: Omit<ParallelIssuesConfig["models"], "worktreeManager"> };
  const parsed: ParallelIssuesConfig = raw.version === 1
    ? { version: 2, models: { ...raw.models, worktreeManager: raw.models.planner } }
    : raw;
  validateConfig(parsed);
  return parsed;
}

export function writeConfig(config: ParallelIssuesConfig, agentDir = getPiAgentDir()): string {
  validateConfig(config);
  const path = getConfigPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function validateConfig(config: ParallelIssuesConfig): void {
  if (config.version !== 2 || !config.models) {
    throw new Error("unsupported pi-parallel-issues configuration");
  }
  for (const role of ["planner", "worktreeManager", "implementer", "reviewer", "integrator"] as const) {
    if (!config.models[role]?.includes("/")) {
      throw new Error(`models.${role} must be a provider/model reference`);
    }
  }
  if (config.models.implementer === config.models.reviewer) {
    throw new Error("implementer and reviewer models must differ");
  }
}
