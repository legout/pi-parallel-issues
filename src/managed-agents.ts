import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const MANAGED_MARKER = "<!-- managed-by: pi-parallel-issues -->";

const STATIC_AGENT_FILES = [
  "parallel-issues-planner.md",
  "parallel-issues-worktree-manager.md",
  "parallel-issues-code-reviewer.md",
  "parallel-issues-integrator.md",
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
  if (!content.includes(MANAGED_MARKER)) {
    throw new Error(`refusing to write unmarked managed agent: ${path}`);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MANAGED_MARKER)) {
    throw new Error(`refusing to overwrite unmanaged agent: ${path}`);
  }
  writeFileSync(path, content);
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

function frontmatterPath(path: string): string {
  if (/[\r\n]/.test(path)) {
    throw new Error(`agent cwd cannot contain line breaks: ${JSON.stringify(path)}`);
  }
  return path;
}

export function implementerAgentText(name: string, cwd: string): string {
  return `${MANAGED_MARKER}\n---\nname: ${name}\ndescription: Implement one issue in its persistent worktree.\ncwd: ${frontmatterPath(cwd)}\nmode: background\nasync: false\nauto-exit: true\nsession-mode: lineage-only\nsystem-prompt: append\nallow-model-override: true\nextensions: all\ntools: read,bash,grep,find,ls,edit,write,lsp_diagnostics,lens_diagnostics,lsp_navigation,ast_grep_search,ffgrep,fffind\nskills: parallel-issue-implement\ninject-skills: parallel-issue-implement\nflags: --approve\n---\n\nImplement exactly one assigned issue in this pre-created worktree. The parent owns independent review. Never switch branches, create or remove worktrees, or run git clean. Commit only intended tracked changes. When resumed with findings, remediate every actionable item, validate, and commit again.\n`;
}

export function reviewerAgentText(name: string, cwd: string): string {
  return `${MANAGED_MARKER}\n---\nname: ${name}\ndescription: Review one issue axis in its persistent worktree.\ncwd: ${frontmatterPath(cwd)}\nmode: background\nasync: false\nauto-exit: true\nsession-mode: lineage-only\nsystem-prompt: replace\nallow-model-override: true\nextensions: none\ntools: read,bash,grep,find,ls\nskills: none\nflags: --approve\n---\n\nReview only the assigned Standards or Spec axis against the supplied baseline. This is strictly read-only. Ground every finding in the committed diff, a cited repository standard, or a quoted specification requirement. End with VERDICT=clean or VERDICT=findings and a numbered actionable list.\n`;
}
