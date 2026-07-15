import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BLOCKED_LABELS = new Set(["needs-triage", "needs-info", "ready-for-human", "wontfix"]);

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
    return JSON.parse(stdout);
  }

  async list(path: string): Promise<unknown[]> {
    const separator = path.includes("?") ? "&" : "?";
    const { stdout } = await execFileAsync("gh", ["api", "--paginate", "--slurp", `${path}${separator}per_page=100`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const pages = JSON.parse(stdout) as unknown[];
    return flattenPaginatedPages(pages, path);
  }
}

export function flattenPaginatedPages(pages: unknown, path: string): unknown[] {
    if (!Array.isArray(pages)) throw new Error(`GitHub returned an invalid paginated payload for ${path}`);
    return pages.flatMap((page) => {
      if (!Array.isArray(page)) throw new Error(`GitHub returned a non-array page for ${path}`);
      return page;
    });
}

export async function mapWithConcurrency<T, U>(
  values: T[],
  limit: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency limit must be positive");
  const results = new Array<U>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
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
    blocked_by: number;
    blocking: number;
    total_blocked_by: number;
    total_blocking: number;
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
  pathHints: string[];
  hasAcceptanceCriteria: boolean;
  openBlockers: number[];
  deterministicDeferrals: string[];
}

export interface IssueDependencyGraph {
  repository: string;
  requested: number[];
  nodes: IssueGraphNode[];
  externalBlockers: Array<{ number: number; title: string; state: string; url: string }>;
  edges: Array<{ blocker: number; blocked: number }>;
  frontier: number[];
  waves: number[][];
  deferred: Array<{ number: number; reasons: string[] }>;
  semanticUncertainties: string[];
  requiresSemanticPlanner: boolean;
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
  let remainder = selection;
  const urlPattern = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/gi;
  remainder = remainder.replace(urlPattern, (_match, owner: string, repo: string, number: string) => {
    repositories.add(`${owner}/${repo}`);
    numbers.add(Number(number));
    return " ";
  });
  remainder = remainder.replace(/#(\d+)/g, (_match, number: string) => {
    numbers.add(Number(number));
    return " ";
  });
  remainder = remainder.replace(/(?:^|[\s,])(\d+)(?=$|[\s,])/g, (match, number: string) => {
    numbers.add(Number(number));
    return match.replace(number, " ");
  });
  const residue = remainder.replace(/[\s,;]+/g, "").trim();
  if (repositories.size > 1) throw new Error("issue selection spans multiple GitHub repositories");
  return {
    numbers: [...numbers].sort((a, b) => a - b),
    repository: [...repositories][0] ?? null,
    hasUnparsedText: residue.length > 0,
  };
}

export async function resolveGitHubRepository(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const remote = stdout.trim();
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`origin is not a GitHub repository: ${remote}`);
  return `${match[1]}/${match[2]}`;
}

export async function readCheckoutSnapshot(cwd: string): Promise<CheckoutSnapshot> {
  const run = async (...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  })).stdout.trimEnd();
  return {
    root: await run("rev-parse", "--show-toplevel"),
    branch: await run("branch", "--show-current"),
    baseline: await run("rev-parse", "HEAD"),
    porcelain: await run("status", "--porcelain"),
  };
}

function asIssue(value: unknown): ApiIssue {
  const issue = value as Partial<ApiIssue>;
  if (!Number.isInteger(issue.number) || !issue.title || !issue.state || !issue.html_url) {
    throw new Error("GitHub returned an invalid issue payload");
  }
  return issue as ApiIssue;
}

function extractPathHints(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1]!.trim();
    if (/^(?:[.\w-]+\/)+[.\w*-]+$/.test(value) || /\.(?:py|ts|tsx|js|jsx|go|rs|java|rb|md|json|ya?ml|toml)$/.test(value)) {
      paths.add(value);
    }
  }
  return [...paths].sort();
}

function hasAcceptanceCriteria(body: string): boolean {
  return /^#{1,6}\s+(?:acceptance criteria|requirements|definition of done)\s*$/im.test(body)
    || (body.match(/^\s*[-*]\s+\[[ xX]\]/gm)?.length ?? 0) >= 2;
}

function deterministicReasons(issue: ApiIssue, labels: string[], openBlockers: number[]): string[] {
  const reasons: string[] = [];
  if (issue.pull_request) reasons.push("selection is a pull request, not an issue");
  if (issue.state !== "open") reasons.push("issue is not open");
  if (!labels.includes("ready-for-agent")) reasons.push("missing ready-for-agent label");
  const blocked = labels.filter((label) => BLOCKED_LABELS.has(label));
  if (blocked.length) reasons.push(`blocked by workflow labels: ${blocked.join(", ")}`);
  if (issue.assignees.length) reasons.push(`already assigned: ${issue.assignees.map((item) => item.login).join(", ")}`);
  if (openBlockers.length) reasons.push(`open blockers: ${openBlockers.map((number) => `#${number}`).join(", ")}`);
  return reasons;
}

function dependencyWaves(requested: number[], edges: Array<{ blocker: number; blocked: number }>): number[][] {
  const requestedSet = new Set(requested);
  const remaining = new Set(requested);
  const waves: number[][] = [];
  while (remaining.size) {
    const wave = [...remaining]
      .filter((number) => !edges.some((edge) => edge.blocked === number && requestedSet.has(edge.blocker) && remaining.has(edge.blocker)))
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
  if (!/^[^/]+\/[^/]+$/.test(input.repository)) throw new Error("repository must be owner/name");
  if (!input.numbers.length) throw new Error("at least one issue number is required");
  if (input.numbers.length > 50) throw new Error("at most 50 issues may be graphed in one run");
  const client = input.client ?? new GhCliClient();
  const requested = [...new Set(input.numbers)].sort((a, b) => a - b);
  const issues = await mapWithConcurrency(
    requested,
    6,
    async (number) => asIssue(await client.get(`repos/${input.repository}/issues/${number}`)),
  );
  const dependencyLists = await mapWithConcurrency(
    issues,
    6,
    async (issue) => {
      if (!(issue.issue_dependencies_summary?.total_blocked_by ?? 0)) return [] as ApiIssue[];
      const payload = await client.list(`repos/${input.repository}/issues/${issue.number}/dependencies/blocked_by`);
      return payload.map(asIssue);
    },
  );

  const edges: Array<{ blocker: number; blocked: number }> = [];
  const external = new Map<number, { number: number; title: string; state: string; url: string }>();
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
    const openBlockers = blockers.filter((blocker) => blocker.state === "open").map((blocker) => blocker.number);
    const body = issue.body ?? "";
    const labels = issue.labels.map((label) => label.name).sort();
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      body,
      labels,
      assignees: issue.assignees.map((assignee) => assignee.login).sort(),
      pathHints: extractPathHints(body),
      hasAcceptanceCriteria: hasAcceptanceCriteria(body),
      openBlockers,
      deterministicDeferrals: deterministicReasons(issue, labels, openBlockers),
    };
  });

  const semanticUncertainties: string[] = [];
  const semanticCandidates = nodes.filter((node) => node.deterministicDeferrals.length === 0);
  for (const node of semanticCandidates) {
    if (!node.body.trim()) semanticUncertainties.push(`#${node.number} has no specification body`);
    else if (!node.hasAcceptanceCriteria) semanticUncertainties.push(`#${node.number} has no machine-detectable acceptance criteria`);
  }
  if (semanticCandidates.length > 1) {
    const missingHints = semanticCandidates.filter((node) => node.pathHints.length === 0).map((node) => `#${node.number}`);
    if (missingHints.length) {
      semanticUncertainties.push(`code overlap is unknown because ${missingHints.join(", ")} declare no path hints`);
    }
    for (let left = 0; left < semanticCandidates.length; left += 1) {
      for (let right = left + 1; right < semanticCandidates.length; right += 1) {
        const a = semanticCandidates[left]!;
        const b = semanticCandidates[right]!;
        const overlap = a.pathHints.filter((path) => b.pathHints.includes(path));
        if (overlap.length) semanticUncertainties.push(`#${a.number} and #${b.number} declare overlapping paths: ${overlap.join(", ")}`);
      }
    }
  }

  const deferred = nodes
    .filter((node) => node.deterministicDeferrals.length > 0)
    .map((node) => ({ number: node.number, reasons: node.deterministicDeferrals }));
  return {
    repository: input.repository,
    requested,
    nodes,
    externalBlockers: [...external.values()].sort((a, b) => a.number - b.number),
    edges: edges.sort((a, b) => a.blocked - b.blocked || a.blocker - b.blocker),
    frontier: nodes.filter((node) => node.deterministicDeferrals.length === 0).map((node) => node.number),
    waves: dependencyWaves(requested, edges),
    deferred,
    semanticUncertainties,
    requiresSemanticPlanner: semanticUncertainties.length > 0,
    source: "github-rest",
  };
}
