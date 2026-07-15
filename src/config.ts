import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ParallelIssuesRole = "planner" | "worktreeManager" | "implementer" | "reviewer" | "integrator";

export const ROLE_REASONING_DEFAULTS: Record<ParallelIssuesRole, ReasoningEffort> = {
  planner: "high",
  worktreeManager: "low",
  implementer: "high",
  reviewer: "medium",
  integrator: "high",
};

export interface RoleModelConfig {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface ParallelIssuesConfig {
  version: 3;
  models: Record<ParallelIssuesRole, RoleModelConfig>;
}

const ROLES: ParallelIssuesRole[] = ["planner", "worktreeManager", "implementer", "reviewer", "integrator"];

type LegacyModels = Record<ParallelIssuesRole, string>;
type LegacyConfig =
  | { version: 1; models: Omit<LegacyModels, "worktreeManager"> }
  | { version: 2; models: LegacyModels };

function migrateLegacyConfig(config: LegacyConfig): ParallelIssuesConfig {
  const models: LegacyModels = config.version === 1
    ? { ...config.models, worktreeManager: config.models.planner }
    : config.models;
  return {
    version: 3,
    models: Object.fromEntries(
      ROLES.map((role) => [role, { model: models[role], reasoningEffort: ROLE_REASONING_DEFAULTS[role] }]),
    ) as ParallelIssuesConfig["models"],
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
  let raw: ParallelIssuesConfig | LegacyConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as ParallelIssuesConfig | LegacyConfig;
  } catch (error) {
    throw new Error(`could not read configuration at ${path}`, { cause: error });
  }
  const parsed: ParallelIssuesConfig = raw.version === 3 ? raw : migrateLegacyConfig(raw);
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
  if (config.version !== 3 || !config.models) {
    throw new Error("unsupported pi-parallel-issues configuration");
  }
  for (const role of ROLES) {
    if (!config.models[role]?.model?.includes("/")) {
      throw new Error(`models.${role} must be a provider/model reference`);
    }
    if (!REASONING_EFFORTS.includes(config.models[role].reasoningEffort)) {
      throw new Error(`models.${role}.reasoningEffort must be a supported reasoning effort`);
    }
  }
  if (config.models.implementer.model === config.models.reviewer.model) {
    throw new Error("implementer and reviewer models must differ");
  }
}
