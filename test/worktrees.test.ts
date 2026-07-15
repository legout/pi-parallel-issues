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
    assert.match(item.implementerAgent, /-implementer$/);
    assert.match(item.reviewerAgent, /-reviewer$/);
    assert.equal(item.agentFiles.every(existsSync), true);
    const generated = readFileSync(item.agentFiles[0]!, "utf8");
    assert.equal(generated.startsWith("---\n"), true);
    assert.equal(generated.match(/^cwd:\s*(.+)$/m)?.[1], item.worktree);
    assert.equal(generated.match(/^name:\s*(.+)$/m)?.[1], item.implementerAgent);
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
  prepareRun({ repo, baseline, run: "incremental", issues: ["1"], paths });
  git(repo, "branch", "pi/incremental/issue-3", baseline);

  assert.throws(
    () => prepareRun({ repo, baseline, run: "incremental", issues: ["2", "3"], paths }),
    /refusing to overwrite existing worktree or branch/,
  );
  const status = runStatus({ repo, run: "incremental", paths });
  assert.deepEqual(Object.keys(status.issues as object), ["1"]);
  assert.notEqual(
    spawnSync("git", ["-C", repo, "show-ref", "--verify", "refs/heads/pi/incremental/issue-2"]).status,
    0,
  );
  cleanupRun({ repo, run: "incremental", paths });
});

test("interactive preparation binds every generated agent to foreground mode", () => {
  const { repo, paths, baseline } = fixture();
  const manifest = prepareRun({
    repo,
    baseline,
    run: "interactive",
    issues: ["1"],
    mode: "interactive",
    paths,
  });
  assert.equal(manifest.agentMode, "interactive");
  const item = manifest.issues["1"]!;
  for (const agentFile of item.agentFiles) {
    assert.match(readFileSync(agentFile, "utf8"), /^mode: interactive$/m);
  }
  assert.throws(
    () => prepareRun({ repo, baseline, run: "interactive", issues: ["1"], paths }),
    /existing run manifest has a different agent mode/,
  );
  cleanupRun({ repo, run: "interactive", paths });
});

test("repository keys sanitize pathological repository names", () => {
  const { repo, paths, baseline } = fixture("repo #1");
  const manifest = prepareRun({ repo, baseline, run: "safe", issues: ["5"], paths });
  assert.match(manifest.repoKey, /^repo-1-[a-f0-9]{10}$/);
  const item = manifest.issues["5"]!;
  assert.match(item.implementerAgent, /^p-repo-1-[a-f0-9]{10}-safe-issue-5-implementer$/);
  cleanupRun({ repo, run: "safe", paths });
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
