import { spawnSync } from "node:child_process";
import type { ParallelIssuesConfig, ReasoningEffort } from "./config.ts";

export interface RuntimeReadiness {
	ok: boolean;
	lines: string[];
}

export function checkRuntimeReadiness(input: {
	toolNames: string[];
	availableModels: string[];
	availableReasoningEfforts?: Readonly<
		Record<string, readonly ReasoningEffort[]>
	>;
	config: ParallelIssuesConfig | null;
	checkGitHub?: boolean;
}): RuntimeReadiness {
	const lines: string[] = [];
	lines.push(
		input.toolNames.includes("subagent")
			? "OK runtime tools"
			: "FAIL runtime tools: missing subagent",
	);

	if (!input.config) {
		lines.push("FAIL models: not configured");
	} else {
		const missingModels = Object.values(input.config.models)
			.map(({ model }) => model)
			.filter((model) => !input.availableModels.includes(model));
		lines.push(
			missingModels.length
				? `FAIL models unavailable: ${[...new Set(missingModels)].join(", ")}`
				: "OK configured models",
		);
		const unavailableEfforts = Object.entries(input.config.models).flatMap(
			([role, config]) => {
				const supported = input.availableReasoningEfforts?.[config.model];
				return supported && !supported.includes(config.reasoningEffort)
					? [`${role}=${config.model}:${config.reasoningEffort}`]
					: [];
			},
		);
		lines.push(
			unavailableEfforts.length
				? `FAIL reasoning efforts unavailable: ${unavailableEfforts.join(", ")}`
				: "OK configured reasoning efforts",
		);
	}

	if (input.checkGitHub !== false) {
		const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
		lines.push(
			gh.status === 0
				? "OK GitHub CLI authentication"
				: "FAIL GitHub CLI authentication",
		);
	}
	lines.push(
		"INFO required external package: git:github.com/edxeth/pi-subagents@v2.5.3",
	);
	lines.push(
		"INFO workflow: deterministic controller + writer + independent reviewer",
	);
	return { ok: lines.every((line) => !line.startsWith("FAIL")), lines };
}
