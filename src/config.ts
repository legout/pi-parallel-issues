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
export type ParallelIssuesRole = "writer" | "reviewer";

export const ROLE_REASONING_DEFAULTS: Record<
	ParallelIssuesRole,
	ReasoningEffort
> = {
	writer: "high",
	reviewer: "medium",
};

export interface RoleModelConfig {
	model: string;
	reasoningEffort: ReasoningEffort;
}

export interface ParallelIssuesConfig {
	version: 4;
	models: Record<ParallelIssuesRole, RoleModelConfig>;
	/** Optional repository-independent default. A run may supply a different command. */
	fullSuiteCommand?: string;
}

type LegacyRoleConfig = string | RoleModelConfig;
type LegacyConfig = {
	version: 1 | 2 | 3;
	models: Record<string, LegacyRoleConfig>;
	fullSuiteCommand?: string;
};

function asRoleConfig(
	value: LegacyRoleConfig | undefined,
	fallbackEffort: ReasoningEffort,
): RoleModelConfig {
	if (typeof value === "string")
		return { model: value, reasoningEffort: fallbackEffort };
	if (value?.model) return value;
	throw new Error(
		"legacy configuration is missing implementer or reviewer model routing",
	);
}

function migrateLegacyConfig(config: LegacyConfig): ParallelIssuesConfig {
	const migrated: ParallelIssuesConfig = {
		version: 4,
		models: {
			writer: asRoleConfig(
				config.models.implementer,
				ROLE_REASONING_DEFAULTS.writer,
			),
			reviewer: asRoleConfig(
				config.models.reviewer,
				ROLE_REASONING_DEFAULTS.reviewer,
			),
		},
		...(config.fullSuiteCommand
			? { fullSuiteCommand: config.fullSuiteCommand }
			: {}),
	};
	return migrated;
}

export function getPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getConfigPath(agentDir = getPiAgentDir()): string {
	return join(agentDir, "pi-parallel-issues.json");
}

export function readConfig(
	agentDir = getPiAgentDir(),
): ParallelIssuesConfig | null {
	const path = getConfigPath(agentDir);
	if (!existsSync(path)) return null;
	let raw: ParallelIssuesConfig | LegacyConfig;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as
			| ParallelIssuesConfig
			| LegacyConfig;
	} catch (error) {
		throw new Error(`could not read configuration at ${path}`, {
			cause: error,
		});
	}
	if (![1, 2, 3, 4].includes(raw.version)) {
		throw new Error(
			`unsupported pi-parallel-issues configuration version: ${String(raw.version)}`,
		);
	}
	const parsed = raw.version === 4 ? raw : migrateLegacyConfig(raw);
	validateConfig(parsed);
	return parsed;
}

export function writeConfig(
	config: ParallelIssuesConfig,
	agentDir = getPiAgentDir(),
): string {
	validateConfig(config);
	const path = getConfigPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return path;
}

export function validateConfig(config: ParallelIssuesConfig): void {
	if (config.version !== 4 || !config.models) {
		throw new Error("unsupported pi-parallel-issues configuration");
	}
	for (const role of ["writer", "reviewer"] as const) {
		if (!/^[^\s/]+\/[^\s]+$/.test(config.models[role]?.model ?? "")) {
			throw new Error(`models.${role} must be a provider/model reference`);
		}
		if (!REASONING_EFFORTS.includes(config.models[role].reasoningEffort)) {
			throw new Error(
				`models.${role}.reasoningEffort must be a supported reasoning effort`,
			);
		}
	}
	if (config.models.writer.model === config.models.reviewer.model) {
		throw new Error("writer and reviewer models must differ");
	}
	if (
		config.fullSuiteCommand !== undefined &&
		!config.fullSuiteCommand.trim()
	) {
		throw new Error("fullSuiteCommand cannot be empty");
	}
}
