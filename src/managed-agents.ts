import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export const MANAGED_MARKER = "managed-by: pi-parallel-issues";
export const WORKFLOW_TEMPLATE_HASH_KEY = "parallel-issues-template-hash";
export type AgentLaunchMode = "background" | "interactive";

export function writeManagedAgent(path: string, content: string): void {
	if (!content.startsWith("---\n") || !content.includes(MANAGED_MARKER)) {
		throw new Error(`refusing to write invalid managed agent: ${path}`);
	}
	mkdirSync(join(path, ".."), { recursive: true });
	if (
		existsSync(path) &&
		!readFileSync(path, "utf8").includes(MANAGED_MARKER)
	) {
		throw new Error(`refusing to overwrite unmanaged agent: ${path}`);
	}
	writeFileSync(path, content);
}

function replaceFrontmatterLine(
	template: string,
	key: string,
	value: string,
): string {
	const lines = template.split("\n");
	const index = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (index === -1)
		throw new Error(`agent template is missing ${key} frontmatter`);
	lines[index] = `${key}: ${value}`;
	return lines.join("\n");
}

export interface BoundAgentInput {
	template: string;
	name: string;
	cwd: string;
	mode?: AgentLaunchMode;
	workflowTemplateHash?: string;
}

export function bindAgentToCwd(input: BoundAgentInput): string {
	const mode = input.mode ?? "background";
	if (!/^[A-Za-z0-9._-]+$/.test(input.name)) {
		throw new Error(`invalid generated agent name: ${input.name}`);
	}
	if (/[\r\n]/.test(input.cwd)) {
		throw new Error(
			`agent cwd cannot contain line breaks: ${JSON.stringify(input.cwd)}`,
		);
	}
	if (mode !== "background" && mode !== "interactive") {
		throw new Error(`invalid agent mode: ${JSON.stringify(mode)}`);
	}
	if (
		!input.template.startsWith("---\n") ||
		!input.template.includes(MANAGED_MARKER)
	) {
		throw new Error("agent template must start with managed frontmatter");
	}
	let bound = replaceFrontmatterLine(input.template, "name", input.name);
	bound = replaceFrontmatterLine(bound, "mode", mode);
	// edxeth/pi-subagents reads these values with a line regex. Keep cwd unquoted.
	bound = bound.replace(/^(name:\s*.+)$/m, `$1\ncwd: ${input.cwd}`);
	return input.workflowTemplateHash
		? bound.replace(
				/^(cwd:\s*.+)$/m,
				`$1\n${WORKFLOW_TEMPLATE_HASH_KEY}: ${input.workflowTemplateHash}`,
			)
		: bound;
}

export function removeManagedAgent(path: string): boolean {
	if (!existsSync(path)) return false;
	if (!readFileSync(path, "utf8").includes(MANAGED_MARKER)) return false;
	rmSync(path);
	return true;
}

export function removeManagedAgents(targetDir: string): string[] {
	if (!existsSync(targetDir)) return [];
	const removed: string[] = [];
	for (const file of readdirSync(targetDir).filter((name) =>
		name.endsWith(".md"),
	)) {
		const path = join(targetDir, file);
		if (!readFileSync(path, "utf8").includes(MANAGED_MARKER)) continue;
		rmSync(path);
		removed.push(basename(path));
	}
	return removed;
}
