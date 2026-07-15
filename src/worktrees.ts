import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiAgentDir } from "./config.ts";
import { bindAgentToCwd, removeManagedAgent, writeManagedAgent } from "./managed-agents.ts";

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const AGENT_TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

export interface IssueManifestEntry {
  worktree: string;
  branch: string;
  implementerAgent: string;
  reviewerAgent: string;
  agentFiles: string[];
}

export interface RunManifest {
  version: 1;
  repo: string;
  repoKey: string;
  run: string;
  baseline: string;
  issues: Record<string, IssueManifestEntry>;
}

export interface WorktreePaths {
  agentDir: string;
  runsDir: string;
  worktreesDir: string;
}

export function defaultWorktreePaths(agentDir = getPiAgentDir()): WorktreePaths {
  const piHome = dirname(agentDir);
  return {
    agentDir,
    runsDir: join(piHome, "parallel-runs"),
    worktreesDir: join(piHome, "worktrees"),
  };
}

export function validateToken(value: string, label: string): string {
  if (!SAFE_TOKEN.test(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

export function validateIssue(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`invalid issue id: ${JSON.stringify(value)}`);
  }
  return value;
}

function git(repo: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function resolveRepo(repoArg: string): { root: string; key: string } {
  const repo = resolve(repoArg);
  const root = resolve(git(repo, ["rev-parse", "--show-toplevel"]).trim());
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 10);
  const slug = basename(root)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "repo";
  return { root, key: `${slug}-${digest}` };
}

function manifestPath(paths: WorktreePaths, repoKey: string, run: string): string {
  return join(paths.runsDir, repoKey, run, "manifest.json");
}

function loadManifest(paths: WorktreePaths, repoKey: string, run: string): RunManifest {
  const path = manifestPath(paths, repoKey, run);
  if (!existsSync(path)) throw new Error(`run manifest not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as RunManifest;
}

export function prepareRun(input: {
  repo: string;
  baseline: string;
  run: string;
  issues: string[];
  paths?: WorktreePaths;
}): RunManifest {
  const paths = input.paths ?? defaultWorktreePaths();
  const { root, key } = resolveRepo(input.repo);
  const run = validateToken(input.run, "run id");
  const issues = [...new Set(input.issues.map(validateIssue))].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );
  if (issues.length === 0) throw new Error("at least one issue is required");
  const baseline = git(root, ["rev-parse", `${input.baseline}^{commit}`]).trim();
  if (git(root, ["status", "--porcelain"])) {
    throw new Error(`parent working tree is not clean: ${root}`);
  }

  const file = manifestPath(paths, key, run);
  mkdirSync(dirname(file), { recursive: true });
  const previousManifest = existsSync(file) ? readFileSync(file, "utf8") : null;
  const manifest: RunManifest = previousManifest
    ? (JSON.parse(previousManifest) as RunManifest)
    : { version: 1, repo: root, repoKey: key, run, baseline, issues: {} };
  if (manifest.repo !== root || manifest.baseline !== baseline) {
    throw new Error("existing run manifest has a different repository or baseline");
  }

  const created: Array<{ worktree: string; branch: string; agentFiles: string[] }> = [];
  try {
    for (const issue of issues) {
      if (manifest.issues[issue]) continue;
      const worktree = join(paths.worktreesDir, key, run, `issue-${issue}`);
      const branch = `pi/${run}/issue-${issue}`;
      const branchExists = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
      if (existsSync(worktree) || branchExists) {
        throw new Error(`refusing to overwrite existing worktree or branch for issue ${issue}`);
      }
      mkdirSync(dirname(worktree), { recursive: true });
      git(root, ["worktree", "add", "-b", branch, worktree, baseline]);
      const createdItem = { worktree, branch, agentFiles: [] as string[] };
      created.push(createdItem);

      const prefix = `p-${key}-${run}-issue-${issue}`;
      const implementerAgent = `${prefix}-implementer`;
      const reviewerAgent = `${prefix}-reviewer`;
      const agentFiles = [
        join(paths.agentDir, "agents", `${implementerAgent}.md`),
        join(paths.agentDir, "agents", `${reviewerAgent}.md`),
      ];
      const implementerTemplate = readFileSync(join(AGENT_TEMPLATES_DIR, "implementer.md"), "utf8");
      const reviewerTemplate = readFileSync(join(AGENT_TEMPLATES_DIR, "code-reviewer.md"), "utf8");
      writeManagedAgent(agentFiles[0]!, bindAgentToCwd(implementerTemplate, implementerAgent, worktree));
      createdItem.agentFiles.push(agentFiles[0]!);
      writeManagedAgent(agentFiles[1]!, bindAgentToCwd(reviewerTemplate, reviewerAgent, worktree));
      createdItem.agentFiles.push(agentFiles[1]!);
      manifest.issues[issue] = { worktree, branch, implementerAgent, reviewerAgent, agentFiles };
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return manifest;
  } catch (error) {
    for (const item of created.reverse()) {
      git(root, ["worktree", "remove", "--force", item.worktree], true);
      git(root, ["branch", "-D", item.branch], true);
      for (const agentFile of item.agentFiles) removeManagedAgent(agentFile);
    }
    if (previousManifest === null) rmSync(file, { force: true });
    else writeFileSync(file, previousManifest);
    throw error;
  }
}

export function runStatus(input: { repo: string; run: string; paths?: WorktreePaths }): Record<string, unknown> {
  const paths = input.paths ?? defaultWorktreePaths();
  const { root, key } = resolveRepo(input.repo);
  const manifest = loadManifest(paths, key, validateToken(input.run, "run id"));
  const issues = Object.fromEntries(
    Object.entries(manifest.issues).map(([issue, item]) => [
      issue,
      {
        ...item,
        exists: existsSync(item.worktree),
        ...(existsSync(item.worktree)
          ? {
              head: git(item.worktree, ["rev-parse", "HEAD"]).trim(),
              status: git(item.worktree, ["status", "--porcelain"]),
            }
          : {}),
      },
    ]),
  );
  return {
    ...manifest,
    issues,
    parentHead: git(root, ["rev-parse", "HEAD"]).trim(),
    parentStatus: git(root, ["status", "--porcelain"]),
  };
}

export function cleanupRun(input: {
  repo: string;
  run: string;
  force?: boolean;
  paths?: WorktreePaths;
}): { cleaned: true; run: string; branchesRetained: string[]; retainedAgentFiles: string[] } {
  const paths = input.paths ?? defaultWorktreePaths();
  const { root, key } = resolveRepo(input.repo);
  const run = validateToken(input.run, "run id");
  const manifest = loadManifest(paths, key, run);
  const failures: string[] = [];
  const retainedAgentFiles: string[] = [];

  for (const [issue, item] of Object.entries(manifest.issues)) {
    if (existsSync(item.worktree)) {
      const dirty = git(item.worktree, ["status", "--porcelain"]);
      if (dirty && !input.force) {
        failures.push(`issue ${issue}: dirty worktree ${item.worktree}`);
        continue;
      }
      const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), item.worktree];
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      if (result.status !== 0) {
        failures.push(`issue ${issue}: ${result.stderr.trim()}`);
        continue;
      }
    }
    for (const agentFile of item.agentFiles) {
      if (existsSync(agentFile) && !removeManagedAgent(agentFile)) retainedAgentFiles.push(agentFile);
    }
  }
  git(root, ["worktree", "prune"]);
  if (failures.length) {
    throw new Error(
      `cleanup incomplete: ${JSON.stringify({ failures, retainedAgentFiles }, null, 2)}`,
    );
  }
  rmSync(manifestPath(paths, key, run), { force: true });
  return {
    cleaned: true,
    run,
    branchesRetained: Object.values(manifest.issues).map((item) => item.branch),
    retainedAgentFiles,
  };
}
