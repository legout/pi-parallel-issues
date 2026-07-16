import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getPiAgentDir,
	type ParallelIssuesConfig,
	type RoleModelConfig,
} from "./config.ts";
import {
	bindAgentToCwd,
	removeManagedAgent,
	writeManagedAgent,
	type AgentLaunchMode,
} from "./managed-agents.ts";
import {
	buildIssueDependencyGraph,
	resolveGitHubRepository,
	type IssueDependencyGraph,
	type IssueGraphNode,
} from "./issue-graph.ts";

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_FILES = [
	"agents/writer.md",
	"agents/reviewer.md",
	"skills/parallel-issue-implement/SKILL.md",
	"skills/parallel-issues/SKILL.md",
] as const;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_REVIEW_ATTEMPTS = 3;
const FULL_SUITE_TIMEOUT_MS = 30 * 60 * 1_000;
const STALE_LOCK_MS = 2 * 60 * 60 * 1_000;

export type RunState =
	| "IMPLEMENTING"
	| "BLOCKED"
	| "INTEGRATION_CONFLICT"
	| "REVIEW_PENDING"
	| "REVIEW_FINDINGS"
	| "REVIEW_EXHAUSTED"
	| "REVIEW_CLEAN"
	| "SUITE_FAILED"
	| "SUITE_PASSED"
	| "PARENT_CHANGED"
	| "LANDED"
	| "CLEANED";

export interface RunPaths {
	agentDir: string;
	runsDir: string;
	worktreesDir: string;
}

export interface RunIssue {
	number: number;
	title: string;
	url: string;
	body: string;
	worktree: string;
	branch: string;
	writerAgent: string;
	agentFile: string;
	status: "pending" | "ready" | "blocked";
	commit?: string;
	focusedChecks?: string[];
	blocker?: string;
}

export interface SuiteEvidence {
	command: string;
	tree: string;
	passed: boolean;
	exitCode: number | null;
	output: string;
}

export interface RunManifest {
	version: 4;
	revision: number;
	repo: string;
	repoKey: string;
	repository: string;
	run: string;
	baseline: string;
	parentBranch: string;
	agentMode: AgentLaunchMode;
	workflowTemplateHash: string;
	fullSuiteCommand: string;
	models: ParallelIssuesConfig["models"];
	state: RunState;
	graph: IssueDependencyGraph;
	issues: Record<string, RunIssue>;
	integration: {
		worktree: string;
		branch: string;
		repairAgent: string;
		reviewerAgent: string;
		agentFiles: string[];
		head?: string;
		tree?: string;
	};
	reviewAttempts: number;
	landedIssues?: number[];
	findings?: string[];
	suite?: SuiteEvidence;
	blocker?: string;
	receipts: Record<string, unknown>;
}

export interface RunJob {
	id: string;
	kind: "implementation" | "review" | "repair";
	agent: string;
	title: string;
	cwd: string;
	parallelGroup: string;
	model: string;
	thinking: string;
	task: string;
}

export interface RunSnapshot {
	run: string;
	revision: number;
	state: RunState;
	baseline: string;
	landedIssues: number[];
	reviewAttempts: number;
	branches: {
		parent: string;
		integration: string;
		issues: Record<string, string>;
	};
	integrationTree?: string;
	jobs: RunJob[];
	blocker?: string;
	deferred: Array<{ number: number; reasons: string[] }>;
	suite?: SuiteEvidence;
}

export interface RunInspection {
	run: string;
	manifestPath: string;
	manifestVersion: unknown;
	compatible: boolean;
	repoMatches: boolean;
	manifestRepo?: string;
	baseline?: string;
	state?: string;
	branches: string[];
	worktrees: string[];
	agents: string[];
	guidance: string[];
}

export type RunReceipt = ImplementationReceipt | ReviewReceipt | RepairReceipt;

export interface ImplementationReceipt {
	kind: "implementation";
	issue: number;
	outcome: "ready" | "needs_decision" | "failed";
	commit?: string;
	focusedChecks?: string[];
	blocker?: string;
}

export interface ReviewReceipt {
	kind: "review";
	tree: string;
	verdict: "clean" | "findings";
	findings: string[];
}

export interface RepairReceipt {
	kind: "repair";
	previousTree: string;
	commit: string;
	focusedChecks: string[];
}

export function defaultRunPaths(agentDir = getPiAgentDir()): RunPaths {
	const piHome = dirname(agentDir);
	return {
		agentDir,
		runsDir: join(piHome, "parallel-runs"),
		worktreesDir: join(piHome, "worktrees"),
	};
}

export function currentWorkflowTemplateHash(): string {
	const snapshot = TEMPLATE_FILES.map(
		(file) => `${file}\0${readFileSync(join(PACKAGE_ROOT, file), "utf8")}`,
	).join("\0");
	return createHash("sha256").update(snapshot).digest("hex").slice(0, 16);
}

function validateToken(value: string, label: string): string {
	if (!SAFE_TOKEN.test(value))
		throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
	return value;
}

function git(repo: string, args: string[], allowFailure = false): string {
	const result = spawnSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
	});
	if (result.status !== 0 && !allowFailure) {
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

function resolveRepo(repoArg: string): { root: string; key: string } {
	const repo = resolve(repoArg);
	if (!existsSync(repo)) {
		throw new Error(
			`repository path does not exist: ${repo}; pass the local checkout root`,
		);
	}
	const root = resolve(git(repo, ["rev-parse", "--show-toplevel"]).trim());
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 10);
	const slug =
		basename(root)
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "repo";
	return { root, key: `${slug}-${digest}` };
}

function manifestPath(paths: RunPaths, repoKey: string, run: string): string {
	return join(paths.runsDir, repoKey, run, "manifest.json");
}

function inspectionManifestPath(
	paths: RunPaths,
	repoKey: string,
	run: string,
): string {
	const direct = manifestPath(paths, repoKey, run);
	if (existsSync(direct)) return direct;
	const matches: string[] = [];
	if (existsSync(paths.runsDir)) {
		for (const entry of readdirSync(paths.runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = manifestPath(paths, entry.name, run);
			if (existsSync(candidate)) matches.push(candidate);
		}
	}
	if (!matches.length) throw new Error(`run manifest not found: ${direct}`);
	if (matches.length > 1) {
		throw new Error(
			`run id is ambiguous across stored checkouts: ${matches.join(", ")}`,
		);
	}
	const match = matches[0];
	if (!match) throw new Error(`run manifest not found: ${direct}`);
	return match;
}

function saveManifest(paths: RunPaths, manifest: RunManifest): void {
	const file = manifestPath(paths, manifest.repoKey, manifest.run);
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function processIdentity(pid: number): string | null {
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
	});
	return result.status === 0 && result.stdout.trim()
		? result.stdout.trim()
		: null;
}

function acquireRunLock(
	paths: RunPaths,
	repoKey: string,
	run: string,
): () => void {
	const lock = join(paths.runsDir, repoKey, run, "controller.lock");
	mkdirSync(dirname(lock), { recursive: true });
	const openLock = () => openSync(lock, "wx");
	let descriptor: number | undefined;
	try {
		descriptor = openLock();
	} catch {
		let stale = false;
		try {
			const rawOwner = readFileSync(lock, "utf8").trim();
			const parsedOwner = JSON.parse(rawOwner) as
				| number
				| { pid?: number; processIdentity?: string };
			const owner =
				typeof parsedOwner === "number" ? parsedOwner : parsedOwner.pid;
			if (typeof owner === "number" && Number.isInteger(owner) && owner > 0) {
				const alive = processIsAlive(owner);
				const recordedIdentity =
					typeof parsedOwner === "number" ? null : parsedOwner.processIdentity;
				const currentIdentity = alive ? processIdentity(owner) : null;
				stale =
					!alive ||
					Boolean(
						recordedIdentity &&
							currentIdentity &&
							recordedIdentity !== currentIdentity,
					);
			} else {
				stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
			}
		} catch {
			try {
				stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
			} catch {
				stale = false;
			}
		}
		if (!stale) throw new Error(`run is already being advanced: ${lock}`);
		rmSync(lock, { force: true });
		descriptor = openLock();
	}
	const token = randomUUID();
	try {
		writeFileSync(
			descriptor,
			`${JSON.stringify({
				pid: process.pid,
				processIdentity: processIdentity(process.pid),
				token,
				acquiredAt: new Date().toISOString(),
			})}\n`,
		);
	} catch (error) {
		closeSync(descriptor);
		rmSync(lock, { force: true });
		throw error;
	}
	const openDescriptor = descriptor;
	return () => {
		closeSync(openDescriptor);
		try {
			const owner = JSON.parse(readFileSync(lock, "utf8")) as {
				token?: string;
			};
			if (owner.token === token) rmSync(lock, { force: true });
		} catch {
			// A missing/replaced lock is owned by another recovery path; never remove it blindly.
		}
	};
}

function withRunLock<T>(
	paths: RunPaths,
	repo: string,
	run: string,
	operation: () => T,
): T {
	const { key } = resolveRepo(repo);
	const release = acquireRunLock(paths, key, validateToken(run, "run id"));
	try {
		return operation();
	} finally {
		release();
	}
}

function loadManifest(paths: RunPaths, repo: string, run: string): RunManifest {
	const { root, key } = resolveRepo(repo);
	const file = manifestPath(paths, key, validateToken(run, "run id"));
	if (!existsSync(file)) throw new Error(`run manifest not found: ${file}`);
	let manifest: RunManifest;
	try {
		manifest = JSON.parse(readFileSync(file, "utf8")) as RunManifest;
	} catch {
		throw new Error(`run manifest is not valid JSON: ${file}`);
	}
	if (manifest.version !== 4 || manifest.repo !== root) {
		throw new Error(
			`unsupported or mismatched run manifest: ${file}; use action=inspect for read-only diagnostics and recovery guidance`,
		);
	}
	return manifest;
}

function uniqueStrings(values: unknown[]): string[] {
	return [
		...new Set(values.filter((value): value is string => typeof value === "string")),
	];
}

function objectRecords(value: unknown): Record<string, unknown>[] {
	if (!value || typeof value !== "object") return [];
	return Object.values(value).filter(
		(item): item is Record<string, unknown> =>
			Boolean(item) && typeof item === "object",
	);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function inspectionGuidance(
	compatible: boolean,
	repoMatches: boolean,
): string[] {
	if (compatible) {
		return [
			"This manifest is compatible with the current controller; use action=status to view resumable state.",
		];
	}
	const mismatch = repoMatches
		? ""
		: " because it belongs to a different checkout";
	return [
		`This immutable manifest cannot be resumed by the current version 4 controller${mismatch}.`,
		"Do not treat legacy generated agents as evidence that the current workflow ran.",
		"Inspect the reported branches and worktrees before choosing manual recovery or cleanup; nothing was modified by this inspection.",
		"Start a new run to use the current deterministic workflow.",
	];
}

export function inspectRun(input: {
	repo: string;
	run: string;
	paths?: RunPaths;
}): RunInspection {
	const paths = input.paths ?? defaultRunPaths();
	const { root, key } = resolveRepo(input.repo);
	const run = validateToken(input.run, "run id");
	const file = inspectionManifestPath(paths, key, run);
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`run manifest is not valid JSON: ${file}`);
	}
	const manifestRepo = typeof raw.repo === "string" ? raw.repo : undefined;
	const repoMatches = manifestRepo === root;
	const compatible = raw.version === 4 && repoMatches;
	const issues = objectRecords(raw.issues);
	const integration = optionalRecord(raw.integration);
	const branches = uniqueStrings([
		...issues.map((issue) => issue.branch),
		integration?.branch,
	]);
	const worktrees = uniqueStrings([
		...issues.map((issue) => issue.worktree),
		integration?.worktree,
	]);
	const agents = uniqueStrings([
		...issues.flatMap((issue) => [
			issue.writerAgent,
			issue.implementerAgent,
			issue.reviewerAgent,
		]),
		integration?.repairAgent,
		integration?.reviewerAgent,
	]);
	const guidance = inspectionGuidance(compatible, repoMatches);
	return {
		run,
		manifestPath: file,
		manifestVersion: raw.version,
		compatible,
		repoMatches,
		...(manifestRepo ? { manifestRepo } : {}),
		...(typeof raw.baseline === "string" ? { baseline: raw.baseline } : {}),
		...(typeof raw.state === "string" ? { state: raw.state } : {}),
		branches,
		worktrees,
		agents,
		guidance,
	};
}

function treeAt(worktree: string, revision = "HEAD"): string {
	return git(worktree, ["rev-parse", `${revision}^{tree}`]).trim();
}

function verifyAssemblyTree(manifest: RunManifest): void {
	const expectedHead = manifest.integration.head;
	const expectedTree = manifest.integration.tree;
	if (!expectedHead || !expectedTree)
		throw new Error("assembly has no recorded head and tree");
	const actualHead = git(manifest.integration.worktree, [
		"rev-parse",
		"HEAD",
	]).trim();
	const actualTree = treeAt(manifest.integration.worktree);
	const status = git(manifest.integration.worktree, [
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	if (actualHead !== expectedHead || actualTree !== expectedTree || status) {
		throw new Error(
			"assembly worktree no longer matches its recorded clean tree",
		);
	}
}

function verifyCleanCandidate(
	issue: RunIssue,
	baseline: string,
	commit: string,
): void {
	const head = git(issue.worktree, ["rev-parse", "HEAD"]).trim();
	if (
		head !== git(issue.worktree, ["rev-parse", `${commit}^{commit}`]).trim()
	) {
		throw new Error(
			`issue #${issue.number} receipt commit is not the worktree HEAD`,
		);
	}
	if (git(issue.worktree, ["status", "--porcelain"])) {
		throw new Error(`issue #${issue.number} worktree is not clean`);
	}
	if (
		spawnSync("git", [
			"-C",
			issue.worktree,
			"merge-base",
			"--is-ancestor",
			baseline,
			head,
		]).status !== 0
	) {
		throw new Error(
			`issue #${issue.number} head does not descend from the baseline`,
		);
	}
	if (treeAt(issue.worktree, baseline) === treeAt(issue.worktree, head)) {
		throw new Error(`issue #${issue.number} produced an empty tree diff`);
	}
}

function createBoundAgent(input: {
	template: "writer.md" | "reviewer.md";
	name: string;
	cwd: string;
	mode: AgentLaunchMode;
	hash: string;
	path: string;
	role: RoleModelConfig;
}): void {
	if (/[\r\n]/.test(input.role.model)) {
		throw new Error(
			`agent model cannot contain line breaks: ${JSON.stringify(input.role.model)}`,
		);
	}
	let template = readFileSync(
		join(PACKAGE_ROOT, "agents", input.template),
		"utf8",
	);
	template = template.replace(/^model:\s*.+$/m, `model: ${input.role.model}`);
	template = template.replace(
		/^thinking:\s*.+$/m,
		`thinking: ${input.role.reasoningEffort}`,
	);
	writeManagedAgent(
		input.path,
		bindAgentToCwd({
			template,
			name: input.name,
			cwd: input.cwd,
			mode: input.mode,
			workflowTemplateHash: input.hash,
		}),
	);
}

function issueJob(manifest: RunManifest, issue: RunIssue): RunJob {
	return {
		id: `implementation:${issue.number}`,
		kind: "implementation",
		agent: issue.writerAgent,
		title: `Implement issue ${issue.number}`,
		cwd: issue.worktree,
		parallelGroup: "implementation",
		model: manifest.models.writer.model,
		thinking: manifest.models.writer.reasoningEffort,
		task: [
			`Implement GitHub issue #${issue.number}: ${issue.title}`,
			`Baseline: ${manifest.baseline}`,
			`Worktree: ${issue.worktree}`,
			`Issue URL: ${issue.url}`,
			"",
			issue.body,
			"",
			"Run focused validation only; never run the full suite.",
			"Return JSON only:",
			`{"kind":"implementation","issue":${issue.number},"outcome":"ready|needs_decision|failed","commit":"<sha when ready>","focusedChecks":["command: result"],"blocker":"<optional>"}`,
		].join("\n"),
	};
}

function reviewJob(manifest: RunManifest): RunJob {
	const specs = Object.values(manifest.issues)
		.sort((a, b) => a.number - b.number)
		.map((issue) => `## Issue #${issue.number}: ${issue.title}\n${issue.body}`)
		.join("\n\n");
	return {
		id: `review:${manifest.reviewAttempts + 1}`,
		kind: "review",
		agent: manifest.integration.reviewerAgent,
		title: "Review assembled candidate",
		cwd: manifest.integration.worktree,
		parallelGroup: "review",
		model: manifest.models.reviewer.model,
		thinking: manifest.models.reviewer.reasoningEffort,
		task: [
			`Review the exact diff ${manifest.baseline}...${manifest.integration.head}.`,
			`Required tree: ${manifest.integration.tree}`,
			"Perform Standards, Spec-per-issue, and Interactions passes in one review.",
			"Run focused or static checks only when needed to validate a finding; never run the repository full suite. The controller owns that gate.",
			"",
			specs,
			"",
			"Return JSON only:",
			`{"kind":"review","tree":"${manifest.integration.tree}","verdict":"clean|findings","findings":["actionable finding with requirement and file/line"]}`,
		].join("\n"),
	};
}

function repairJob(manifest: RunManifest): RunJob {
	return {
		id: `repair:${manifest.reviewAttempts}:${manifest.integration.tree}`,
		kind: "repair",
		agent: manifest.integration.repairAgent,
		title: "Repair assembled candidate",
		cwd: manifest.integration.worktree,
		parallelGroup: "repair",
		model: manifest.models.writer.model,
		thinking: manifest.models.writer.reasoningEffort,
		task: [
			`Repair the assembled candidate at tree ${manifest.integration.tree}.`,
			`Baseline: ${manifest.baseline}`,
			"Address only these findings:",
			...(manifest.findings ?? []).map((finding) => `- ${finding}`),
			"",
			"Run focused regression checks only; never run the full suite.",
			"Return JSON only:",
			`{"kind":"repair","previousTree":"${manifest.integration.tree}","commit":"<new HEAD sha>","focusedChecks":["command: result"]}`,
		].join("\n"),
	};
}

function snapshot(manifest: RunManifest, jobs: RunJob[] = []): RunSnapshot {
	return {
		run: manifest.run,
		revision: manifest.revision,
		state: manifest.state,
		baseline: manifest.baseline,
		landedIssues: manifest.landedIssues ?? [],
		reviewAttempts: manifest.reviewAttempts,
		branches: {
			parent: manifest.parentBranch,
			integration: manifest.integration.branch,
			issues: Object.fromEntries(
				Object.values(manifest.issues)
					.sort((a, b) => a.number - b.number)
					.map((issue) => [String(issue.number), issue.branch]),
			),
		},
		...(manifest.integration.tree
			? { integrationTree: manifest.integration.tree }
			: {}),
		jobs,
		...(manifest.blocker ? { blocker: manifest.blocker } : {}),
		deferred: manifest.graph.deferred,
		...(manifest.suite ? { suite: manifest.suite } : {}),
	};
}

type CreatedArtifact = {
	worktree: string;
	branch: string;
	agentFiles: string[];
};

function refExists(repo: string, branch: string): boolean {
	return (
		spawnSync("git", [
			"-C",
			repo,
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		]).status === 0
	);
}

function rollbackArtifact(repo: string, artifact: CreatedArtifact): void {
	git(repo, ["worktree", "remove", "--force", artifact.worktree], true);
	git(repo, ["branch", "-D", artifact.branch], true);
	for (const agentFile of artifact.agentFiles) removeManagedAgent(agentFile);
}

function prepareIssue(input: {
	node: IssueGraphNode;
	root: string;
	key: string;
	run: string;
	baseline: string;
	mode: AgentLaunchMode;
	hash: string;
	paths: RunPaths;
	writer: RoleModelConfig;
}): { issue: RunIssue; created: CreatedArtifact } {
	const number = input.node.number;
	const worktree = join(
		input.paths.worktreesDir,
		input.key,
		input.run,
		`issue-${number}`,
	);
	const branch = `pi/${input.run}/issue-${number}`;
	if (existsSync(worktree) || refExists(input.root, branch)) {
		throw new Error(
			`refusing to overwrite existing worktree or branch for issue ${number}`,
		);
	}
	mkdirSync(dirname(worktree), { recursive: true });
	git(input.root, ["worktree", "add", "-b", branch, worktree, input.baseline]);
	const writerAgent = `p-${input.key}-${input.run}-issue-${number}-writer`;
	const agentFile = join(input.paths.agentDir, "agents", `${writerAgent}.md`);
	const created = { worktree, branch, agentFiles: [agentFile] };
	try {
		createBoundAgent({
			template: "writer.md",
			name: writerAgent,
			cwd: worktree,
			mode: input.mode,
			hash: input.hash,
			path: agentFile,
			role: input.writer,
		});
	} catch (error) {
		rollbackArtifact(input.root, created);
		throw error;
	}
	return {
		issue: {
			number,
			title: input.node.title,
			url: input.node.url,
			body: input.node.body,
			worktree,
			branch,
			writerAgent,
			agentFile,
			status: "pending",
		},
		created,
	};
}

function prepareIntegration(input: {
	root: string;
	key: string;
	run: string;
	baseline: string;
	mode: AgentLaunchMode;
	hash: string;
	paths: RunPaths;
	models: ParallelIssuesConfig["models"];
}): { integration: RunManifest["integration"]; created: CreatedArtifact } {
	const worktree = join(
		input.paths.worktreesDir,
		input.key,
		input.run,
		"integration",
	);
	const branch = `pi/${input.run}/integration`;
	if (existsSync(worktree) || refExists(input.root, branch)) {
		throw new Error(
			"refusing to overwrite existing integration worktree or branch",
		);
	}
	mkdirSync(dirname(worktree), { recursive: true });
	git(input.root, ["worktree", "add", "-b", branch, worktree, input.baseline]);
	const repairAgent = `p-${input.key}-${input.run}-assembly-writer`;
	const reviewerAgent = `p-${input.key}-${input.run}-reviewer`;
	const repairAgentFile = join(
		input.paths.agentDir,
		"agents",
		`${repairAgent}.md`,
	);
	const reviewerAgentFile = join(
		input.paths.agentDir,
		"agents",
		`${reviewerAgent}.md`,
	);
	const agentFiles = [repairAgentFile, reviewerAgentFile];
	const created = { worktree, branch, agentFiles };
	try {
		createBoundAgent({
			template: "writer.md",
			name: repairAgent,
			cwd: worktree,
			mode: input.mode,
			hash: input.hash,
			path: repairAgentFile,
			role: input.models.writer,
		});
		createBoundAgent({
			template: "reviewer.md",
			name: reviewerAgent,
			cwd: worktree,
			mode: input.mode,
			hash: input.hash,
			path: reviewerAgentFile,
			role: input.models.reviewer,
		});
	} catch (error) {
		rollbackArtifact(input.root, created);
		throw error;
	}
	return {
		integration: { worktree, branch, repairAgent, reviewerAgent, agentFiles },
		created,
	};
}

export async function openRun(input: {
	repo: string;
	repository: string;
	issues: number[];
	run: string;
	fullSuiteCommand: string;
	mode?: AgentLaunchMode;
	models: ParallelIssuesConfig["models"];
	paths?: RunPaths;
	graph?: IssueDependencyGraph;
}): Promise<RunSnapshot> {
	const paths = input.paths ?? defaultRunPaths();
	const { root, key } = resolveRepo(input.repo);
	const run = validateToken(input.run, "run id");
	const mode = input.mode ?? "background";
	const release = acquireRunLock(paths, key, run);
	try {
		if (!input.fullSuiteCommand.trim())
			throw new Error("fullSuiteCommand is required");
		const baseline = git(root, ["rev-parse", "HEAD"]).trim();
		const parentBranch = git(root, ["branch", "--show-current"]).trim();
		if (!parentBranch)
			throw new Error("parent checkout is in detached HEAD state");
		if (git(root, ["status", "--porcelain"]))
			throw new Error("parent checkout is not clean");
		const file = manifestPath(paths, key, run);
		if (existsSync(file)) throw new Error(`run already exists: ${file}`);
		const localRepository = await resolveGitHubRepository(root);
		if (localRepository.toLowerCase() !== input.repository.toLowerCase()) {
			throw new Error(
				`repository mismatch: checkout is ${localRepository}, run requested ${input.repository}`,
			);
		}

		const graph =
			input.graph ??
			(await buildIssueDependencyGraph({
				repository: input.repository,
				numbers: input.issues,
			}));
		if (!graph.frontier.length) {
			throw new Error(
				`no eligible frontier issues: ${JSON.stringify(graph.deferred)}`,
			);
		}
		const hash = currentWorkflowTemplateHash();
		const created: CreatedArtifact[] = [];
		const issues: Record<string, RunIssue> = {};
		try {
			for (const number of [...graph.frontier].sort((a, b) => a - b)) {
				const node = graph.nodes.find(
					(candidate) => candidate.number === number,
				);
				if (!node)
					throw new Error(`graph frontier references missing issue #${number}`);
				const prepared = prepareIssue({
					node,
					root,
					key,
					run,
					baseline,
					mode,
					hash,
					paths,
					writer: input.models.writer,
				});
				issues[String(number)] = prepared.issue;
				created.push(prepared.created);
			}
			const preparedIntegration = prepareIntegration({
				root,
				key,
				run,
				baseline,
				mode,
				hash,
				paths,
				models: input.models,
			});
			created.push(preparedIntegration.created);

			const manifest: RunManifest = {
				version: 4,
				revision: 1,
				repo: root,
				repoKey: key,
				repository: input.repository,
				run,
				baseline,
				parentBranch,
				agentMode: mode,
				workflowTemplateHash: hash,
				fullSuiteCommand: input.fullSuiteCommand,
				models: input.models,
				state: "IMPLEMENTING",
				graph,
				issues,
				integration: preparedIntegration.integration,
				reviewAttempts: 0,
				receipts: {},
			};
			saveManifest(paths, manifest);
			return snapshot(
				manifest,
				Object.values(issues).map((issue) => issueJob(manifest, issue)),
			);
		} catch (error) {
			for (let index = created.length - 1; index >= 0; index -= 1) {
				const item = created[index];
				if (item) rollbackArtifact(root, item);
			}
			throw error;
		}
	} finally {
		release();
	}
}

function applyCandidate(manifest: RunManifest, issue: RunIssue): void {
	if (!issue.commit)
		throw new Error(`issue #${issue.number} has no verified commit`);
	const patch = spawnSync(
		"git",
		[
			"-C",
			issue.worktree,
			"diff",
			"--binary",
			"--full-index",
			manifest.baseline,
			issue.commit,
		],
		{ encoding: null, maxBuffer: MAX_BUFFER },
	);
	if (patch.status !== 0)
		throw new Error(`could not create patch for issue #${issue.number}`);
	const applied = spawnSync(
		"git",
		[
			"-C",
			manifest.integration.worktree,
			"apply",
			"--index",
			"--whitespace=nowarn",
			"-",
		],
		{ input: patch.stdout, encoding: null, maxBuffer: MAX_BUFFER },
	);
	if (applied.status !== 0) {
		throw new Error(
			`issue #${issue.number}: ${applied.stderr.toString().trim() || "patch conflict"}`,
		);
	}
}

function assemble(manifest: RunManifest): boolean {
	try {
		for (const issue of Object.values(manifest.issues).sort(
			(a, b) => a.number - b.number,
		)) {
			applyCandidate(manifest, issue);
		}
		git(manifest.integration.worktree, [
			"commit",
			"-m",
			`chore: integrate issues ${Object.values(manifest.issues)
				.map((issue) => `#${issue.number}`)
				.join(", ")}`,
		]);
		manifest.integration.head = git(manifest.integration.worktree, [
			"rev-parse",
			"HEAD",
		]).trim();
		manifest.integration.tree = treeAt(manifest.integration.worktree);
		manifest.state = "REVIEW_PENDING";
		return true;
	} catch (error) {
		manifest.state = "INTEGRATION_CONFLICT";
		manifest.blocker = error instanceof Error ? error.message : String(error);
		return false;
	}
}

function runFullSuite(manifest: RunManifest): boolean {
	verifyAssemblyTree(manifest);
	if (!manifest.integration.tree)
		throw new Error("cannot verify an assembly without a tree");
	const result = spawnSync("sh", ["-lc", manifest.fullSuiteCommand], {
		cwd: manifest.integration.worktree,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		timeout: FULL_SUITE_TIMEOUT_MS,
	});
	const output =
		`${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`.trim();
	let treeError: string | null = null;
	try {
		verifyAssemblyTree(manifest);
	} catch (error) {
		treeError = error instanceof Error ? error.message : String(error);
	}
	manifest.suite = {
		command: manifest.fullSuiteCommand,
		tree: manifest.integration.tree,
		passed: result.status === 0 && treeError === null,
		exitCode: result.status,
		output: [output, treeError].filter(Boolean).join("\n").slice(-8_000),
	};
	if (manifest.suite.passed) {
		manifest.state = "SUITE_PASSED";
		delete manifest.findings;
		return true;
	}
	manifest.state = "SUITE_FAILED";
	manifest.findings = [
		`Full suite failed (${manifest.fullSuiteCommand}): ${manifest.suite.output}`,
	];
	return false;
}

function land(manifest: RunManifest): void {
	const parentHead = git(manifest.repo, ["rev-parse", "HEAD"]).trim();
	const parentBranch = git(manifest.repo, ["branch", "--show-current"]).trim();
	const parentStatus = git(manifest.repo, ["status", "--porcelain"]);
	if (
		parentHead !== manifest.baseline ||
		parentBranch !== manifest.parentBranch ||
		parentStatus
	) {
		manifest.state = "PARENT_CHANGED";
		manifest.blocker = "parent checkout changed after the run opened";
		return;
	}
	if (!manifest.integration.head)
		throw new Error("cannot land an assembly without a head");
	git(manifest.repo, ["merge", "--ff-only", manifest.integration.head]);
	manifest.landedIssues = Object.values(manifest.issues)
		.map((issue) => issue.number)
		.sort((a, b) => a - b);
	manifest.state = "LANDED";
}

function cleanup(manifest: RunManifest): void {
	const failures: string[] = [];
	const worktrees = [
		...Object.values(manifest.issues).map((issue) => issue.worktree),
		manifest.integration.worktree,
	];
	for (const worktree of worktrees) {
		if (!existsSync(worktree)) continue;
		const disposableStatus = git(worktree, [
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--ignored",
		]);
		if (disposableStatus) {
			failures.push(
				`worktree with tracked, untracked, or ignored artifacts retained: ${worktree}`,
			);
			continue;
		}
		const removed = spawnSync(
			"git",
			["-C", manifest.repo, "worktree", "remove", worktree],
			{
				encoding: "utf8",
			},
		);
		if (removed.status !== 0)
			failures.push(removed.stderr.trim() || `could not remove ${worktree}`);
	}
	if (failures.length) {
		manifest.blocker = failures.join("; ");
		return;
	}
	for (const issue of Object.values(manifest.issues))
		removeManagedAgent(issue.agentFile);
	for (const agentFile of manifest.integration.agentFiles)
		removeManagedAgent(agentFile);
	git(manifest.repo, ["worktree", "prune"]);
	manifest.state = "CLEANED";
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function parseReceipt(value: unknown): RunReceipt {
	if (!value || typeof value !== "object")
		throw new Error("receipt must be an object");
	const receipt = value as Record<string, unknown>;
	if (receipt.kind === "implementation") {
		if (
			!Number.isInteger(receipt.issue) ||
			!["ready", "needs_decision", "failed"].includes(String(receipt.outcome))
		) {
			throw new Error("invalid implementation receipt");
		}
		if (receipt.commit !== undefined && typeof receipt.commit !== "string")
			throw new Error("invalid implementation commit");
		if (
			receipt.focusedChecks !== undefined &&
			!isStringArray(receipt.focusedChecks)
		)
			throw new Error("invalid implementation focusedChecks");
		if (receipt.blocker !== undefined && typeof receipt.blocker !== "string")
			throw new Error("invalid implementation blocker");
		return receipt as unknown as ImplementationReceipt;
	}
	if (receipt.kind === "review") {
		if (
			typeof receipt.tree !== "string" ||
			!["clean", "findings"].includes(String(receipt.verdict)) ||
			!isStringArray(receipt.findings)
		) {
			throw new Error("invalid review receipt");
		}
		return receipt as unknown as ReviewReceipt;
	}
	if (receipt.kind === "repair") {
		if (
			typeof receipt.previousTree !== "string" ||
			typeof receipt.commit !== "string" ||
			!isStringArray(receipt.focusedChecks) ||
			!receipt.focusedChecks.length
		) {
			throw new Error("invalid repair receipt");
		}
		return receipt as unknown as RepairReceipt;
	}
	throw new Error("unknown receipt kind");
}

function acceptImplementation(
	manifest: RunManifest,
	jobId: string,
	receipt: ImplementationReceipt,
): void {
	if (manifest.state !== "IMPLEMENTING") {
		throw new Error(
			`run is not accepting implementation receipts: ${manifest.state}`,
		);
	}
	const issue = manifest.issues[String(receipt.issue)];
	if (!issue || jobId !== `implementation:${issue.number}`) {
		throw new Error("implementation receipt does not match its job");
	}
	if (receipt.outcome !== "ready") {
		issue.status = "blocked";
		issue.blocker = receipt.blocker ?? receipt.outcome;
		manifest.state = "BLOCKED";
		manifest.blocker = `issue #${issue.number}: ${issue.blocker}`;
		return;
	}
	if (!receipt.commit || !receipt.focusedChecks?.length) {
		throw new Error("ready implementation requires commit and focusedChecks");
	}
	verifyCleanCandidate(issue, manifest.baseline, receipt.commit);
	issue.status = "ready";
	issue.commit = receipt.commit;
	issue.focusedChecks = receipt.focusedChecks;
}

function acceptReview(
	manifest: RunManifest,
	jobId: string,
	receipt: ReviewReceipt,
): void {
	if (manifest.state !== "REVIEW_PENDING") {
		throw new Error(`run is not accepting review receipts: ${manifest.state}`);
	}
	if (jobId !== `review:${manifest.reviewAttempts + 1}`) {
		throw new Error("review receipt does not match its job");
	}
	if (receipt.tree !== manifest.integration.tree) {
		throw new Error("review receipt is for a different tree");
	}
	verifyAssemblyTree(manifest);
	manifest.reviewAttempts += 1;
	if (receipt.verdict === "clean") {
		if (receipt.findings.length)
			throw new Error("clean review cannot contain findings");
		manifest.state = "REVIEW_CLEAN";
		delete manifest.findings;
		return;
	}
	if (!receipt.findings.length)
		throw new Error("findings verdict requires findings");
	manifest.findings = receipt.findings;
	manifest.state =
		manifest.reviewAttempts >= MAX_REVIEW_ATTEMPTS
			? "REVIEW_EXHAUSTED"
			: "REVIEW_FINDINGS";
}

function acceptRepair(
	manifest: RunManifest,
	jobId: string,
	receipt: RepairReceipt,
): void {
	if (
		manifest.state !== "REVIEW_FINDINGS" &&
		manifest.state !== "SUITE_FAILED"
	) {
		throw new Error(`run is not accepting repair receipts: ${manifest.state}`);
	}
	const expectedJobId = `repair:${manifest.reviewAttempts}:${manifest.integration.tree}`;
	if (jobId !== expectedJobId)
		throw new Error("repair receipt does not match its job");
	if (receipt.previousTree !== manifest.integration.tree) {
		throw new Error("repair receipt started from a different tree");
	}
	const previousHead = manifest.integration.head;
	if (!previousHead) throw new Error("repair has no assembled parent commit");
	const head = git(manifest.integration.worktree, ["rev-parse", "HEAD"]).trim();
	if (
		head !==
		git(manifest.integration.worktree, [
			"rev-parse",
			`${receipt.commit}^{commit}`,
		]).trim()
	) {
		throw new Error(
			"repair receipt commit is not the integration worktree HEAD",
		);
	}
	if (git(manifest.integration.worktree, ["status", "--porcelain"])) {
		throw new Error("integration worktree is not clean after repair");
	}
	if (
		spawnSync("git", [
			"-C",
			manifest.integration.worktree,
			"merge-base",
			"--is-ancestor",
			previousHead,
			head,
		]).status !== 0
	) {
		throw new Error(
			"repair commit does not descend from the reviewed candidate",
		);
	}
	const newTree = treeAt(manifest.integration.worktree);
	if (newTree === receipt.previousTree)
		throw new Error("repair produced no tree change");
	manifest.integration.head = head;
	manifest.integration.tree = newTree;
	manifest.state = "REVIEW_PENDING";
	delete manifest.findings;
	delete manifest.suite;
}

export function submitRun(input: {
	repo: string;
	run: string;
	jobId: string;
	receipt: unknown;
	paths?: RunPaths;
}): RunSnapshot {
	const paths = input.paths ?? defaultRunPaths();
	return withRunLock(paths, input.repo, input.run, () => {
		const manifest = loadManifest(paths, input.repo, input.run);
		const receipt = parseReceipt(input.receipt);
		if (manifest.receipts[input.jobId]) {
			if (
				JSON.stringify(manifest.receipts[input.jobId]) !==
				JSON.stringify(receipt)
			) {
				throw new Error(`job ${input.jobId} already has a different receipt`);
			}
			return snapshot(manifest);
		}

		if (receipt.kind === "implementation") {
			acceptImplementation(manifest, input.jobId, receipt);
		} else if (receipt.kind === "review") {
			acceptReview(manifest, input.jobId, receipt);
		} else {
			acceptRepair(manifest, input.jobId, receipt);
		}

		manifest.receipts[input.jobId] = receipt;
		manifest.revision += 1;
		saveManifest(paths, manifest);
		return snapshot(manifest);
	});
}

export function nextRun(input: {
	repo: string;
	run: string;
	paths?: RunPaths;
}): RunSnapshot {
	const paths = input.paths ?? defaultRunPaths();
	return withRunLock(paths, input.repo, input.run, () => {
		const manifest = loadManifest(paths, input.repo, input.run);
		let jobs: RunJob[] = [];
		switch (manifest.state) {
			case "IMPLEMENTING": {
				const pending = Object.values(manifest.issues).filter(
					(issue) => issue.status === "pending",
				);
				if (pending.length)
					jobs = pending.map((issue) => issueJob(manifest, issue));
				else if (assemble(manifest)) jobs = [reviewJob(manifest)];
				break;
			}
			case "REVIEW_PENDING":
				jobs = [reviewJob(manifest)];
				break;
			case "REVIEW_FINDINGS":
			case "SUITE_FAILED":
				jobs = [repairJob(manifest)];
				break;
			case "REVIEW_CLEAN":
				if (!runFullSuite(manifest)) jobs = [repairJob(manifest)];
				break;
			case "SUITE_PASSED":
				land(manifest);
				break;
			case "LANDED":
				cleanup(manifest);
				break;
			default:
				break;
		}
		manifest.revision += 1;
		saveManifest(paths, manifest);
		return snapshot(manifest, jobs);
	});
}

export function statusRun(input: {
	repo: string;
	run: string;
	paths?: RunPaths;
}): RunSnapshot {
	const paths = input.paths ?? defaultRunPaths();
	return snapshot(loadManifest(paths, input.repo, input.run));
}

export function cleanupRun(input: {
	repo: string;
	run: string;
	paths?: RunPaths;
}): RunSnapshot {
	const paths = input.paths ?? defaultRunPaths();
	return withRunLock(paths, input.repo, input.run, () => {
		const manifest = loadManifest(paths, input.repo, input.run);
		const cleanable: RunState[] = [
			"BLOCKED",
			"INTEGRATION_CONFLICT",
			"REVIEW_EXHAUSTED",
			"SUITE_FAILED",
			"PARENT_CHANGED",
			"LANDED",
			"CLEANED",
		];
		if (!cleanable.includes(manifest.state)) {
			throw new Error(
				`refusing to clean active run in state ${manifest.state}`,
			);
		}
		cleanup(manifest);
		manifest.revision += 1;
		saveManifest(paths, manifest);
		return snapshot(manifest);
	});
}
