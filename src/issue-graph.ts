import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BLOCKED_LABELS = new Set([
	"needs-triage",
	"needs-info",
	"ready-for-human",
	"wontfix",
]);

function parseGitHubJson(stdout: string, path: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`GitHub returned invalid JSON for ${path}`);
	}
}

export interface GitHubClient {
	get(path: string): Promise<unknown>;
	list(path: string): Promise<unknown[]>;
}

export class GhCliClient implements GitHubClient {
	async get(path: string): Promise<unknown> {
		const { stdout } = await execFileAsync("gh", ["api", path], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		return parseGitHubJson(stdout, path);
	}

	async list(path: string): Promise<unknown[]> {
		const separator = path.includes("?") ? "&" : "?";
		const { stdout } = await execFileAsync(
			"gh",
			["api", "--paginate", "--slurp", `${path}${separator}per_page=100`],
			{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
		);
		return flattenPaginatedPages(parseGitHubJson(stdout, path), path);
	}
}

export function flattenPaginatedPages(pages: unknown, path: string): unknown[] {
	if (!Array.isArray(pages))
		throw new Error(`GitHub returned an invalid paginated payload for ${path}`);
	return pages.flatMap((page) => {
		if (!Array.isArray(page))
			throw new Error(`GitHub returned a non-array page for ${path}`);
		return page;
	});
}

export async function mapWithConcurrency<T, U>(
	values: T[],
	limit: number,
	operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
	if (!Number.isInteger(limit) || limit < 1)
		throw new Error("concurrency limit must be positive");
	const results = new Array<U>(values.length);
	const queue = values.map((value, index) => ({ value, index }));
	const worker = async () => {
		let item = queue.shift();
		while (item) {
			results[item.index] = await operation(item.value, item.index);
			item = queue.shift();
		}
	};
	const workers = Array.from({ length: Math.min(limit, values.length) }, () =>
		worker(),
	);
	await Promise.all(workers);
	return results;
}

interface ApiIssue {
	number: number;
	title: string;
	state: "open" | "closed";
	html_url: string;
	body: string | null;
	labels: Array<{ name: string }>;
	assignees: Array<{ login: string }>;
	pull_request?: unknown;
	issue_dependencies_summary?: {
		total_blocked_by: number;
	};
}

export interface IssueGraphNode {
	number: number;
	title: string;
	state: "open" | "closed";
	url: string;
	body: string;
	labels: string[];
	assignees: string[];
	openBlockers: number[];
	deterministicDeferrals: string[];
}

export interface IssueDependencyGraph {
	repository: string;
	requested: number[];
	nodes: IssueGraphNode[];
	externalBlockers: Array<{
		number: number;
		title: string;
		state: string;
		url: string;
	}>;
	edges: Array<{ blocker: number; blocked: number }>;
	frontier: number[];
	waves: number[][];
	deferred: Array<{ number: number; reasons: string[] }>;
	source: "github-rest";
}

export interface ParsedSelection {
	numbers: number[];
	repository: string | null;
	hasUnparsedText: boolean;
}

export interface CheckoutSnapshot {
	root: string;
	branch: string;
	baseline: string;
	porcelain: string;
}

export function parseIssueSelection(selection: string): ParsedSelection {
	const repositories = new Set<string>();
	const numbers = new Set<number>();
	const addNumber = (value: string) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < 1) {
			throw new Error(`invalid issue number: ${JSON.stringify(value)}`);
		}
		numbers.add(number);
	};
	let remainder = selection;
	const urlPattern =
		/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/gi;
	remainder = remainder.replace(
		urlPattern,
		(_match, owner: string, repo: string, number: string) => {
			repositories.add(`${owner}/${repo}`);
			addNumber(number);
			return " ";
		},
	);
	remainder = remainder.replace(/#(\d+)/g, (_match, number: string) => {
		addNumber(number);
		return " ";
	});
	remainder = remainder.replace(
		/(?:^|[\s,])(\d+)(?=$|[\s,])/g,
		(match, number: string) => {
			addNumber(number);
			return match.replace(number, " ");
		},
	);
	const residue = remainder.replace(/[\s,;]+/g, "").trim();
	if (repositories.size > 1)
		throw new Error("issue selection spans multiple GitHub repositories");
	return {
		numbers: [...numbers].sort((a, b) => a - b),
		repository: [...repositories][0] ?? null,
		hasUnparsedText: residue.length > 0,
	};
}

export async function resolveGitHubRepository(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", cwd, "remote", "get-url", "origin"],
		{
			encoding: "utf8",
		},
	);
	const remote = stdout.trim();
	const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
	if (!match) throw new Error(`origin is not a GitHub repository: ${remote}`);
	return `${match[1]}/${match[2]}`;
}

export async function readCheckoutSnapshot(
	cwd: string,
): Promise<CheckoutSnapshot> {
	const run = async (...args: string[]) => {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
		});
		return result.stdout.trimEnd();
	};
	const [root, branch, baseline, porcelain] = await Promise.all([
		run("rev-parse", "--show-toplevel"),
		run("branch", "--show-current"),
		run("rev-parse", "HEAD"),
		run("status", "--porcelain"),
	]);
	return { root, branch, baseline, porcelain };
}

function asIssue(value: unknown): ApiIssue {
	const issue = value as Partial<ApiIssue>;
	if (
		!Number.isInteger(issue.number) ||
		!issue.title ||
		!issue.state ||
		!issue.html_url
	) {
		throw new Error("GitHub returned an invalid issue payload");
	}
	return issue as ApiIssue;
}

function deterministicReasons(
	issue: ApiIssue,
	labels: string[],
	openBlockers: number[],
): string[] {
	const reasons: string[] = [];
	if (issue.pull_request)
		reasons.push("selection is a pull request, not an issue");
	if (issue.state !== "open") reasons.push("issue is not open");
	if (!labels.includes("ready-for-agent"))
		reasons.push("missing ready-for-agent label");
	const blocked = labels.filter((label) => BLOCKED_LABELS.has(label));
	if (blocked.length)
		reasons.push(`blocked by workflow labels: ${blocked.join(", ")}`);
	if (issue.assignees.length)
		reasons.push(
			`already assigned: ${issue.assignees.map((item) => item.login).join(", ")}`,
		);
	if (openBlockers.length)
		reasons.push(
			`open blockers: ${openBlockers.map((number) => `#${number}`).join(", ")}`,
		);
	if (!issue.body?.trim()) reasons.push("issue has no specification body");
	return reasons;
}

function dependencyWaves(
	requested: number[],
	edges: Array<{ blocker: number; blocked: number }>,
): number[][] {
	const requestedSet = new Set(requested);
	const remaining = new Set(requested);
	const waves: number[][] = [];
	while (remaining.size) {
		const wave = [...remaining]
			.filter(
				(number) =>
					!edges.some(
						(edge) =>
							edge.blocked === number &&
							requestedSet.has(edge.blocker) &&
							remaining.has(edge.blocker),
					),
			)
			.sort((a, b) => a - b);
		if (!wave.length) break;
		waves.push(wave);
		for (const number of wave) remaining.delete(number);
	}
	if (remaining.size) waves.push([...remaining].sort((a, b) => a - b));
	return waves;
}

export async function buildIssueDependencyGraph(input: {
	repository: string;
	numbers: number[];
	client?: GitHubClient;
}): Promise<IssueDependencyGraph> {
	if (!/^[^/]+\/[^/]+$/.test(input.repository))
		throw new Error("repository must be owner/name");
	if (!input.numbers.length)
		throw new Error("at least one issue number is required");
	if (input.numbers.length > 50)
		throw new Error("at most 50 issues may be graphed in one run");
	if (
		input.numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
	) {
		throw new Error("issue numbers must be positive safe integers");
	}
	const client = input.client ?? new GhCliClient();
	const requested = [...new Set(input.numbers)].sort((a, b) => a - b);
	const issues = await mapWithConcurrency(requested, 6, async (number) =>
		asIssue(await client.get(`repos/${input.repository}/issues/${number}`)),
	);
	const dependencyLists = await mapWithConcurrency(issues, 6, async (issue) => {
		if (!(issue.issue_dependencies_summary?.total_blocked_by ?? 0))
			return [] as ApiIssue[];
		const payload = await client.list(
			`repos/${input.repository}/issues/${issue.number}/dependencies/blocked_by`,
		);
		return payload.map(asIssue);
	});

	const edges: Array<{ blocker: number; blocked: number }> = [];
	const external = new Map<
		number,
		{ number: number; title: string; state: string; url: string }
	>();
	const nodes = issues.map((issue, index): IssueGraphNode => {
		const blockers = dependencyLists[index] ?? [];
		for (const blocker of blockers) {
			edges.push({ blocker: blocker.number, blocked: issue.number });
			if (!requested.includes(blocker.number)) {
				external.set(blocker.number, {
					number: blocker.number,
					title: blocker.title,
					state: blocker.state,
					url: blocker.html_url,
				});
			}
		}
		const openBlockers = blockers.flatMap((blocker) =>
			blocker.state === "open" ? [blocker.number] : [],
		);
		const labels = issue.labels
			.map((label) => label.name)
			.sort((a, b) => a.localeCompare(b));
		return {
			number: issue.number,
			title: issue.title,
			state: issue.state,
			url: issue.html_url,
			body: issue.body ?? "",
			labels,
			assignees: issue.assignees
				.map((assignee) => assignee.login)
				.sort((a, b) => a.localeCompare(b)),
			openBlockers,
			deterministicDeferrals: deterministicReasons(issue, labels, openBlockers),
		};
	});
	const deferred = nodes.flatMap((node) =>
		node.deterministicDeferrals.length
			? [{ number: node.number, reasons: node.deterministicDeferrals }]
			: [],
	);
	return {
		repository: input.repository,
		requested,
		nodes,
		externalBlockers: [...external.values()].sort(
			(a, b) => a.number - b.number,
		),
		edges: edges.sort((a, b) => a.blocked - b.blocked || a.blocker - b.blocker),
		frontier: nodes.flatMap((node) =>
			node.deterministicDeferrals.length === 0 ? [node.number] : [],
		),
		waves: dependencyWaves(requested, edges),
		deferred,
		source: "github-rest",
	};
}
