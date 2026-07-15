import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const MANAGED_MARKER = "managed-by: pi-parallel-issues";

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
    const target = join(targetDir, file);
    const content = readFileSync(source, "utf8");
    if (!content.includes(MANAGED_MARKER)) {
      throw new Error(`bundled agent is missing managed marker: ${source}`);
    }
    if (!existsSync(target)) {
      writeFileSync(target, content);
      result.installed.push(target);
      continue;
    }
    const existing = readFileSync(target, "utf8");
    if (!existing.includes(MANAGED_MARKER)) {
      result.conflicts.push(target);
      continue;
    }
    if (existing !== content) {
      writeFileSync(target, content);
      result.updated.push(target);
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

export function bindAgentToCwd(template: string, name: string, cwd: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid generated agent name: ${name}`);
  if (/[\r\n]/.test(cwd)) throw new Error(`agent cwd cannot contain line breaks: ${JSON.stringify(cwd)}`);
  if (!template.startsWith("---\n") || !template.includes(MANAGED_MARKER)) {
    throw new Error("agent template must start with managed frontmatter");
  }
  const named = template.replace(/^name:\s*.+$/m, `name: ${name}`);
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
