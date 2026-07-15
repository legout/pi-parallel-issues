import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const MANAGED_MARKER = "managed-by: pi-parallel-issues";
export type AgentLaunchMode = "background" | "interactive";

export function verboseAgentName(name: string): string {
  return `${name}-verbose`;
}

const STATIC_AGENT_FILES = [
  "issue-planner.md",
  "worktree-manager.md",
  "implementer.md",
  "code-reviewer.md",
  "integrator.md",
] as const;

export interface SyncAgentsResult {
  installed: string[];
  updated: string[];
  conflicts: string[];
}

export function syncStaticAgents(sourceDir: string, targetDir: string): SyncAgentsResult {
  mkdirSync(targetDir, { recursive: true });
  const result: SyncAgentsResult = { installed: [], updated: [], conflicts: [] };

  for (const file of STATIC_AGENT_FILES) {
    const source = join(sourceDir, file);
    const content = readFileSync(source, "utf8");
    if (!content.includes(MANAGED_MARKER)) {
      throw new Error(`bundled agent is missing managed marker: ${source}`);
    }

    const name = basename(file, ".md");
    const variants = [
      { file, content },
      {
        file: `${verboseAgentName(name)}.md`,
        content: setAgentMode(renameAgent(content, verboseAgentName(name)), "interactive"),
      },
    ];
    for (const variant of variants) {
      const target = join(targetDir, variant.file);
      if (!existsSync(target)) {
        writeFileSync(target, variant.content);
        result.installed.push(target);
        continue;
      }
      const existing = readFileSync(target, "utf8");
      if (!existing.includes(MANAGED_MARKER)) {
        result.conflicts.push(target);
        continue;
      }
      if (existing !== variant.content) {
        writeFileSync(target, variant.content);
        result.updated.push(target);
      }
    }
  }
  return result;
}

export function writeManagedAgent(path: string, content: string): void {
  if (!content.startsWith("---\n") || !content.includes(MANAGED_MARKER)) {
    throw new Error(`refusing to write invalid managed agent: ${path}`);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MANAGED_MARKER)) {
    throw new Error(`refusing to overwrite unmanaged agent: ${path}`);
  }
  writeFileSync(path, content);
}

function replaceFrontmatterLine(template: string, key: string, value: string): string {
  const lines = template.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) {
    throw new Error(`agent template is missing ${key} frontmatter`);
  }
  lines[index] = `${key}: ${value}`;
  return lines.join("\n");
}

function renameAgent(template: string, name: string): string {
  return replaceFrontmatterLine(template, "name", name);
}

export function setAgentMode(template: string, mode: AgentLaunchMode): string {
  if (mode !== "background" && mode !== "interactive") {
    throw new Error(`invalid agent mode: ${JSON.stringify(mode)}`);
  }
  return replaceFrontmatterLine(template, "mode", mode);
}

export function bindAgentToCwd(
  template: string,
  name: string,
  cwd: string,
  mode: AgentLaunchMode = "background",
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid generated agent name: ${name}`);
  if (/[\r\n]/.test(cwd)) throw new Error(`agent cwd cannot contain line breaks: ${JSON.stringify(cwd)}`);
  if (!template.startsWith("---\n") || !template.includes(MANAGED_MARKER)) {
    throw new Error("agent template must start with managed frontmatter");
  }
  const named = setAgentMode(renameAgent(template, name), mode);
  // edxeth/pi-subagents v2.5.3 reads frontmatter values with a line regex,
  // not a YAML decoder. Keep the absolute path unquoted: quotes become literal
  // path characters, while `#` remains part of the regex-captured value.
  return named.replace(/^(name:\s*.+)$/m, `$1\ncwd: ${cwd}`);
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
  for (const file of readdirSync(targetDir).filter((name) => name.endsWith(".md"))) {
    const path = join(targetDir, file);
    if (!readFileSync(path, "utf8").includes(MANAGED_MARKER)) continue;
    rmSync(path);
    removed.push(basename(path));
  }
  return removed;
}
