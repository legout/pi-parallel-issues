import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	cleanupRun,
	nextRun,
	openRun,
	statusRun,
	submitRun,
	type RunPaths,
} from "../src/run.ts";
import type { IssueDependencyGraph } from "../src/issue-graph.ts";

const models = {
	writer: { model: "provider/writer", reasoningEffort: "high" as const },
	reviewer: { model: "provider/reviewer", reasoningEffort: "medium" as const },
};

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
	}).trim();
}

function fixture(): { repo: string; paths: RunPaths } {
	const root = mkdtempSync(join(tmpdir(), "pi-parallel-run-"));
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-b", "main", repo]);
	git(repo, "config", "user.name", "Test User");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "remote", "add", "origin", "git@github.com:acme/repo.git");
	writeFileSync(join(repo, "README.md"), "baseline\n");
	writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
	git(repo, "add", "README.md", ".gitignore");
	git(repo, "commit", "-m", "chore: initialize fixture");
	return {
		repo,
		paths: {
			agentDir: join(root, "agent"),
			runsDir: join(root, "runs"),
			worktreesDir: join(root, "worktrees"),
		},
	};
}

function graph(numbers: number[]): IssueDependencyGraph {
	return {
		repository: "acme/repo",
		requested: numbers,
		nodes: numbers.map((number) => ({
			number,
			title: `Issue ${number}`,
			state: "open",
			url: `https://github.com/acme/repo/issues/${number}`,
			body: `Implement feature ${number}.`,
			labels: ["ready-for-agent"],
			assignees: [],
			openBlockers: [],
			deterministicDeferrals: [],
		})),
		externalBlockers: [],
		edges: [],
		frontier: numbers,
		waves: [numbers],
		deferred: [],
		source: "github-rest",
	};
}

function implement(job: { cwd: string }, issue: number): string {
	writeFileSync(join(job.cwd, `feature-${issue}.txt`), `feature ${issue}\n`);
	git(job.cwd, "add", `feature-${issue}.txt`);
	git(job.cwd, "commit", "-m", `feat: implement issue ${issue}`);
	return git(job.cwd, "rev-parse", "HEAD");
}

test("uniform one-issue run implements, assembles, reviews, verifies, lands, and cleans", async () => {
	const { repo, paths } = fixture();
	let snapshot = await openRun({
		repo,
		repository: "acme/repo",
		issues: [1],
		run: "single",
		fullSuiteCommand: "test -f feature-1.txt",
		graph: graph([1]),
		models,
		paths,
	});
	assert.equal(snapshot.state, "IMPLEMENTING");
	assert.equal(snapshot.jobs.length, 1);
	assert.equal(snapshot.jobs[0]?.model, models.writer.model);
	assert.equal(snapshot.jobs[0]?.thinking, models.writer.reasoningEffort);
	const generatedWriter = readFileSync(
		join(paths.agentDir, "agents", `${snapshot.jobs[0]?.agent}.md`),
		"utf8",
	);
	assert.match(generatedWriter, /^model: provider\/writer$/m);
	assert.match(generatedWriter, /^thinking: high$/m);
	assert.throws(
		() => cleanupRun({ repo, run: "single", paths }),
		/refusing to clean active run/,
	);
	const implementation = snapshot.jobs[0]!;
	const commit = implement(implementation, 1);
	const repoKey = readdirSync(paths.runsDir)[0];
	assert.ok(repoKey);
	writeFileSync(
		join(paths.runsDir, repoKey, "single", "controller.lock"),
		"99999999\n",
	);
	snapshot = submitRun({
		repo,
		run: "single",
		jobId: implementation.id,
		receipt: {
			kind: "implementation",
			issue: 1,
			outcome: "ready",
			commit,
			focusedChecks: ["focused: pass"],
		},
		paths,
	});
	assert.equal(snapshot.state, "IMPLEMENTING");

	snapshot = nextRun({ repo, run: "single", paths });
	assert.equal(snapshot.state, "REVIEW_PENDING");
	assert.equal(snapshot.jobs[0]?.kind, "review");
	assert.equal(snapshot.jobs[0]?.model, models.reviewer.model);
	const review = snapshot.jobs[0]!;
	assert.throws(
		() =>
			submitRun({
				repo,
				run: "single",
				jobId: review.id,
				receipt: {
					kind: "review",
					tree: snapshot.integrationTree,
					verdict: "findings",
					findings: "not-an-array",
				},
				paths,
			}),
		/invalid review receipt/,
	);
	writeFileSync(join(review.cwd, "stray.txt"), "unreviewed\n");
	assert.throws(
		() =>
			submitRun({
				repo,
				run: "single",
				jobId: review.id,
				receipt: {
					kind: "review",
					tree: snapshot.integrationTree,
					verdict: "clean",
					findings: [],
				},
				paths,
			}),
		/no longer matches its recorded clean tree/,
	);
	rmSync(join(review.cwd, "stray.txt"));
	snapshot = submitRun({
		repo,
		run: "single",
		jobId: review.id,
		receipt: {
			kind: "review",
			tree: snapshot.integrationTree!,
			verdict: "clean",
			findings: [],
		},
		paths,
	});
	assert.equal(snapshot.state, "REVIEW_CLEAN");

	snapshot = nextRun({ repo, run: "single", paths });
	assert.equal(snapshot.state, "SUITE_PASSED");
	assert.equal(snapshot.suite?.passed, true);
	snapshot = nextRun({ repo, run: "single", paths });
	assert.equal(snapshot.state, "LANDED");
	assert.equal(existsSync(join(repo, "feature-1.txt")), true);
	snapshot = nextRun({ repo, run: "single", paths });
	assert.equal(snapshot.state, "CLEANED");
	assert.deepEqual(
		existsSync(join(paths.agentDir, "agents"))
			? readdirSync(join(paths.agentDir, "agents"))
			: [],
		[],
	);
});

test("review findings route to one assembly writer and invalidate old evidence", async () => {
	const { repo, paths } = fixture();
	let snapshot = await openRun({
		repo,
		repository: "acme/repo",
		issues: [2],
		run: "repair",
		fullSuiteCommand: "test -f repaired.txt",
		graph: graph([2]),
		models,
		paths,
	});
	const implementation = snapshot.jobs[0]!;
	const commit = implement(implementation, 2);
	submitRun({
		repo,
		run: "repair",
		jobId: implementation.id,
		receipt: {
			kind: "implementation",
			issue: 2,
			outcome: "ready",
			commit,
			focusedChecks: ["focused: pass"],
		},
		paths,
	});
	snapshot = nextRun({ repo, run: "repair", paths });
	const firstTree = snapshot.integrationTree!;
	const review = snapshot.jobs[0]!;
	snapshot = submitRun({
		repo,
		run: "repair",
		jobId: review.id,
		receipt: {
			kind: "review",
			tree: firstTree,
			verdict: "findings",
			findings: ["Add repaired.txt"],
		},
		paths,
	});
	assert.equal(snapshot.state, "REVIEW_FINDINGS");
	snapshot = nextRun({ repo, run: "repair", paths });
	const repair = snapshot.jobs[0]!;
	assert.throws(
		() =>
			submitRun({
				repo,
				run: "repair",
				jobId: `${repair.id}:forged`,
				receipt: {
					kind: "repair",
					previousTree: firstTree,
					commit,
					focusedChecks: ["forged"],
				},
				paths,
			}),
		/does not match its job/,
	);
	writeFileSync(join(repair.cwd, "repaired.txt"), "fixed\n");
	git(repair.cwd, "add", "repaired.txt");
	git(repair.cwd, "commit", "-m", "fix: address integrated review");
	const repairCommit = git(repair.cwd, "rev-parse", "HEAD");
	snapshot = submitRun({
		repo,
		run: "repair",
		jobId: repair.id,
		receipt: {
			kind: "repair",
			previousTree: firstTree,
			commit: repairCommit,
			focusedChecks: ["repair: pass"],
		},
		paths,
	});
	assert.equal(snapshot.state, "REVIEW_PENDING");
	assert.notEqual(snapshot.integrationTree, firstTree);
	assert.equal(snapshot.suite, undefined);
	snapshot = nextRun({ repo, run: "repair", paths });
	const repairedReview = snapshot.jobs[0]!;
	snapshot = submitRun({
		repo,
		run: "repair",
		jobId: repairedReview.id,
		receipt: {
			kind: "review",
			tree: snapshot.integrationTree!,
			verdict: "clean",
			findings: [],
		},
		paths,
	});
	snapshot = nextRun({ repo, run: "repair", paths });
	assert.equal(snapshot.state, "SUITE_PASSED");
	assert.equal(snapshot.suite?.tree, snapshot.integrationTree);
});

test("suite failure returns to the same assembly writer and requires review after repair", async () => {
	const { repo, paths } = fixture();
	let snapshot = await openRun({
		repo,
		repository: "acme/repo",
		issues: [4],
		run: "suite-failure",
		fullSuiteCommand: "printf 'mutated\\n' > feature-4.txt",
		graph: graph([4]),
		models,
		paths,
	});
	const implementation = snapshot.jobs[0]!;
	const commit = implement(implementation, 4);
	submitRun({
		repo,
		run: "suite-failure",
		jobId: implementation.id,
		receipt: {
			kind: "implementation",
			issue: 4,
			outcome: "ready",
			commit,
			focusedChecks: ["focused: pass"],
		},
		paths,
	});
	snapshot = nextRun({ repo, run: "suite-failure", paths });
	const review = snapshot.jobs[0]!;
	snapshot = submitRun({
		repo,
		run: "suite-failure",
		jobId: review.id,
		receipt: {
			kind: "review",
			tree: snapshot.integrationTree!,
			verdict: "clean",
			findings: [],
		},
		paths,
	});
	snapshot = nextRun({ repo, run: "suite-failure", paths });
	assert.equal(snapshot.state, "SUITE_FAILED");
	assert.equal(snapshot.jobs[0]?.kind, "repair");
	assert.match(
		snapshot.suite?.output ?? "",
		/no longer matches its recorded clean tree/,
	);
	git(snapshot.jobs[0]!.cwd, "checkout", "--", "feature-4.txt");
	const ignoredArtifact = join(snapshot.jobs[0]!.cwd, "ignored.log");
	writeFileSync(ignoredArtifact, "must not be deleted\n");
	const retained = cleanupRun({ repo, run: "suite-failure", paths });
	assert.equal(retained.state, "SUITE_FAILED");
	assert.match(retained.blocker ?? "", /ignored artifacts retained/);
	assert.equal(existsSync(ignoredArtifact), true);
	rmSync(ignoredArtifact);
	assert.equal(
		cleanupRun({ repo, run: "suite-failure", paths }).state,
		"CLEANED",
	);
});

test("controller rejects issues from a different GitHub repository", async () => {
	const { repo, paths } = fixture();
	await assert.rejects(
		() =>
			openRun({
				repo,
				repository: "other/repo",
				issues: [5],
				run: "wrong-repo",
				fullSuiteCommand: "true",
				graph: graph([5]),
				models,
				paths,
			}),
		/repository mismatch/,
	);
});

test("implementation ambiguity blocks rather than invoking a planner", async () => {
	const { repo, paths } = fixture();
	const opened = await openRun({
		repo,
		repository: "acme/repo",
		issues: [3],
		run: "blocked",
		fullSuiteCommand: "true",
		graph: graph([3]),
		models,
		paths,
	});
	const blocked = submitRun({
		repo,
		run: "blocked",
		jobId: opened.jobs[0]!.id,
		receipt: {
			kind: "implementation",
			issue: 3,
			outcome: "needs_decision",
			blocker: "Choose retention policy",
		},
		paths,
	});
	assert.equal(blocked.state, "BLOCKED");
	assert.match(blocked.blocker ?? "", /retention policy/);
	assert.equal(statusRun({ repo, run: "blocked", paths }).state, "BLOCKED");
});
