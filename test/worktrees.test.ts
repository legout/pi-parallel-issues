import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupRun,
  prepareRun,
  runStatus,
  validateIssue,
  type WorktreePaths,
} from "../src/worktrees.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture(repoName = "repo"): { repo: string; paths: WorktreePaths; baseline: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-parallel-worktrees-"));
  const repo = join(root, repoName);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "chore: initialize fixture");
  return {
    repo,
    baseline: git(repo, "rev-parse", "HEAD"),
    paths: {
      agentDir: join(root, "agent"),
      runsDir: join(root, "parallel-runs"),
      worktreesDir: join(root, "worktrees"),
    },
  };
}

test("prepare, status, and cleanup preserve issue branches", () => {
  const { repo, paths, baseline } = fixture();
  const manifest = prepareRun({ repo, baseline, run: "test-12", issues: ["12", "7"], paths });
  assert.deepEqual(Object.keys(manifest.issues), ["7", "12"]);

  for (const item of Object.values(manifest.issues)) {
    assert.equal(existsSync(item.worktree), true);
    assert.equal(item.agentFiles.every(existsSync), true);
    const agentText = readFileSync(item.agentFiles[0]!, "utf8");
    assert.match(agentText, /managed-by: pi-parallel-issues/);
    assert.equal(agentText.match(/^cwd:\s*(.+)$/m)?.[1], item.worktree);
  }

  const status = runStatus({ repo, run: "test-12", paths });
  assert.equal(status.parentHead, baseline);
  assert.equal(status.parentStatus, "");

  const result = cleanupRun({ repo, run: "test-12", paths });
  assert.equal(result.cleaned, true);
  assert.deepEqual(result.branchesRetained, ["pi/test-12/issue-7", "pi/test-12/issue-12"]);
  for (const branch of result.branchesRetained) {
    assert.equal(git(repo, "show-ref", "--verify", `refs/heads/${branch}`).length > 0, true);
  }
});

test("prepare restores an existing manifest and rolls back only new issues", () => {
  const { repo, paths, baseline } = fixture();
  const existing = prepareRun({ repo, baseline, run: "incremental", issues: ["1"], paths });
  const collisionName = `parallel-${existing.repoKey}-incremental-issue-3-implementer.md`;
  const collision = join(paths.agentDir, "agents", collisionName);
  writeFileSync(collision, "user owned\n");

  assert.throws(
    () => prepareRun({ repo, baseline, run: "incremental", issues: ["2", "3"], paths }),
    /refusing to overwrite unmanaged agent/,
  );
  const status = runStatus({ repo, run: "incremental", paths });
  assert.deepEqual(Object.keys(status.issues as object), ["1"]);
  assert.notEqual(
    spawnSync("git", ["-C", repo, "show-ref", "--verify", "refs/heads/pi/incremental/issue-2"]).status,
    0,
  );
  assert.equal(readFileSync(collision, "utf8"), "user owned\n");
  cleanupRun({ repo, run: "incremental", paths });
});

test("cleanup preserves an unmarked replacement agent", () => {
  const { repo, paths, baseline } = fixture();
  const manifest = prepareRun({ repo, baseline, run: "replacement", issues: ["4"], paths });
  const replacement = manifest.issues["4"]!.agentFiles[0]!;
  writeFileSync(replacement, "user replacement\n");

  const result = cleanupRun({ repo, run: "replacement", paths });
  assert.deepEqual(result.retainedAgentFiles, [replacement]);
  assert.equal(readFileSync(replacement, "utf8"), "user replacement\n");
});

test("generated identities sanitize repository names and preserve the exact worktree cwd", () => {
  const { repo, paths, baseline } = fixture("repo #1");
  const manifest = prepareRun({ repo, baseline, run: "safe", issues: ["5"], paths });
  assert.match(manifest.repoKey, /^repo-1-[a-f0-9]{10}$/);
  const item = manifest.issues["5"]!;
  assert.match(item.implementerAgent, /^[A-Za-z0-9._-]+$/);
  const text = readFileSync(item.agentFiles[0]!, "utf8");
  const cwd = text.match(/^cwd:\s*(.+)$/m)?.[1];
  assert.equal(cwd, item.worktree);
  cleanupRun({ repo, run: "safe", paths });
});

test("partial cleanup errors report retained replacement agents", () => {
  const { repo, paths, baseline } = fixture();
  const manifest = prepareRun({ repo, baseline, run: "partial", issues: ["6", "7"], paths });
  const replacement = manifest.issues["6"]!.agentFiles[0]!;
  writeFileSync(replacement, "user replacement\n");
  writeFileSync(join(manifest.issues["7"]!.worktree, "dirty.txt"), "dirty\n");

  assert.throws(
    () => cleanupRun({ repo, run: "partial", paths }),
    (error: unknown) => error instanceof Error && error.message.includes(replacement),
  );
  assert.equal(readFileSync(replacement, "utf8"), "user replacement\n");

  git(manifest.issues["7"]!.worktree, "clean", "-f");
  cleanupRun({ repo, run: "partial", paths });
});

test("issue IDs are canonical positive decimal numbers", () => {
  assert.equal(validateIssue("42"), "42");
  for (const invalid of ["0", "01", "abc", "1e2", "-1"]) {
    assert.throws(() => validateIssue(invalid), /invalid issue id/);
  }
});

test("prepare refuses a dirty parent checkout", () => {
  const { repo, paths, baseline } = fixture();
  writeFileSync(join(repo, "README.md"), "dirty\n");
  assert.throws(
    () => prepareRun({ repo, baseline, run: "dirty-test", issues: ["1"], paths }),
    /parent working tree is not clean/,
  );
});
