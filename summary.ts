// Builds one thread's session summary from bb's SDK: environment (machine,
// project, folder, branch), context usage and where it comes from, connectors,
// and changes (the branch's PR plus PRs and issues found in the timeline).
//
// Every source is optional. A missing machine, a non-git folder, a provider
// without a context breakdown, or a disabled PR plugin leaves that part null
// instead of failing the whole summary.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SessionSummary } from "./contract.ts";
import { createTimelineScan, scanItem, type TimelineScan } from "./timeline.ts";


const MAX_ENTRIES = 8;
const MAX_TOOLS = 40;
/** The server's cap on `threads.events.list`. */
const EVENTS_PAGE = 100;
/** Pages read per summary; a longer backlog continues on the next refresh. */
const MAX_PAGES_PER_READ = 50;
const MAX_CACHED_THREADS = 100;

/** Incremental timeline scans, so a refresh only reads new events. */
export class TimelineCache {
  private readonly entries = new Map<string, { afterSeq: number | null; scan: TimelineScan }>();
  private readonly inFlight = new Map<string, Promise<TimelineScan>>();

  private readonly sdk: PluginBbSdk;

  constructor(sdk: PluginBbSdk) {
    this.sdk = sdk;
  }

  /** Forget a thread's scan, e.g. after its history was rewritten. */
  reset(threadId: string): void {
    this.entries.delete(threadId);
  }

  read(threadId: string): Promise<TimelineScan> {
    // Serialize per thread so two reads never feed the same events twice.
    const previous = this.inFlight.get(threadId) ?? Promise.resolve(undefined);
    const next = previous.catch(() => undefined).then(() => this.advance(threadId));
    this.inFlight.set(threadId, next);
    void next.finally(() => {
      if (this.inFlight.get(threadId) === next) this.inFlight.delete(threadId);
    });
    return next;
  }

  private async advance(threadId: string): Promise<TimelineScan> {
    let entry = this.entries.get(threadId);
    if (entry === undefined) {
      entry = { afterSeq: null, scan: createTimelineScan() };
    }
    // Re-insert to keep Map order as least-recently-used first.
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    while (this.entries.size > MAX_CACHED_THREADS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    for (let page = 0; page < MAX_PAGES_PER_READ; page += 1) {
      const rows = await this.sdk.threads.events.list({
        threadId,
        types: ["item/completed"],
        order: "asc",
        limit: String(EVENTS_PAGE),
        ...(entry.afterSeq === null ? {} : { afterSeq: String(entry.afterSeq) }),
      });
      for (const row of rows) {
        if (row.type === "item/completed") scanItem(entry.scan, row.data.item);
        entry.afterSeq = row.seq;
      }
      if (rows.length < EVENTS_PAGE) break;
    }
    return entry.scan;
  }
}

export async function buildSessionSummary(
  sdk: PluginBbSdk,
  timeline: TimelineCache,
  threadId: string,
): Promise<SessionSummary> {
  const thread = await sdk.threads.get({ threadId });
  const [environment, context, scan] = await Promise.all([
    readEnvironment(sdk, thread.environmentId, thread.projectId),
    sdk.threads.context({ threadId }).then((result) => result.usage, () => null),
    timeline.read(threadId),
  ]);
  const pullRequest =
    thread.environmentId === null ? null : await readBranchPullRequest(sdk, thread.environmentId);

  return {
    threadId,
    providerId: thread.providerId,
    environment,
    context: context === null ? null : summarizeContext(context),
    connectors: summarizeConnectors(context?.snapshot?.categories ?? [], scan),
    changes: {
      pullRequest,
      workItems: [...scan.workItems.values()],
    },
    itemsScanned: scan.itemsScanned,
  };
}

async function readEnvironment(
  sdk: PluginBbSdk,
  environmentId: string | null,
  projectId: string,
): Promise<SessionSummary["environment"]> {
  if (environmentId === null) return null;
  const environment = await sdk.environments.get({ environmentId });
  const [host, project, status] = await Promise.all([
    environment.hostId === null
      ? null
      : sdk.hosts.get({ hostId: environment.hostId }).catch(() => null),
    sdk.projects.get({ projectId }).catch(() => null),
    environment.isGitRepo
      ? sdk.environments.status({ environmentId }).catch(() => null)
      : null,
  ]);
  const workspace = status?.outcome === "available" ? status.workspace : null;
  const checkout = workspace?.checkout;
  return {
    machine: host?.name ?? null,
    project: project?.name ?? null,
    folder: environment.path,
    kind: environment.isWorktree ? "worktree" : environment.isGitRepo ? "checkout" : "folder",
    branch: (checkout?.kind === "branch" ? checkout.branchName : null) ?? environment.branchName,
    defaultBranch: workspace?.branch?.defaultBranch ?? environment.defaultBranch,
    headSha: checkout !== undefined && "headSha" in checkout ? (checkout.headSha ?? null) : null,
    workingTree:
      workspace === null
        ? null
        : {
            fileCount: workspace.workingTree.fileCount,
            insertions: workspace.workingTree.insertions,
            deletions: workspace.workingTree.deletions,
          },
  };
}

type ContextUsage = NonNullable<Awaited<ReturnType<PluginBbSdk["threads"]["context"]>>["usage"]>;
type ContextCategory = NonNullable<ContextUsage["snapshot"]>["categories"][number];

function summarizeContext(usage: ContextUsage): NonNullable<SessionSummary["context"]> {
  const snapshot = usage.snapshot;
  return {
    usedTokens: usage.usedTokens ?? snapshot?.usedTokens ?? null,
    windowTokens: usage.modelContextWindow ?? snapshot?.contextWindowTokens ?? null,
    estimated: usage.estimated,
    cost: usage.cost ?? null,
    autoCompactAtTokens: snapshot?.autoCompactAtTokens ?? null,
    capturedAt: snapshot?.capturedAt ?? null,
    categories: (snapshot?.categories ?? []).map((category) => {
      const entries = [...category.entries].sort((a, b) => b.tokens - a.tokens);
      return {
        label: category.label,
        kind: category.kind,
        tokens: category.tokens,
        entries: entries.slice(0, MAX_ENTRIES).map(({ label, tokens }) => ({ label, tokens })),
        more: Math.max(0, entries.length - MAX_ENTRIES),
      };
    }),
  };
}

/**
 * Claude Code labels each MCP tool in the context breakdown
 * "server: mcp__server__tool". Timeline tool calls name the server their own
 * way ("bb" for "bb-bridge"), so calls are matched to a loaded server by tool
 * name first and fall back to the call's own server name.
 */
export function summarizeConnectors(
  categories: readonly ContextCategory[],
  scan: TimelineScan,
): SessionSummary["connectors"] {
  const loaded = new Map<string, Set<string>>();
  const serverByTool = new Map<string, string>();
  for (const category of categories) {
    if (!/^MCP tools/i.test(category.label)) continue;
    for (const entry of category.entries) {
      const parsed = parseMcpToolLabel(entry.label);
      if (parsed === null) continue;
      const tools = loaded.get(parsed.server) ?? new Set<string>();
      tools.add(parsed.tool);
      loaded.set(parsed.server, tools);
      serverByTool.set(parsed.tool, parsed.server);
    }
  }

  // server -> tool -> calls
  const calls = new Map<string, Map<string, number>>();
  for (const use of scan.toolUses.values()) {
    const server = serverByTool.get(use.tool) ?? use.server;
    const tools = calls.get(server) ?? new Map<string, number>();
    tools.set(use.tool, (tools.get(use.tool) ?? 0) + use.calls);
    calls.set(server, tools);
  }

  const servers = new Set([...loaded.keys(), ...calls.keys()]);
  return [...servers]
    .map((server) => {
      const called = calls.get(server) ?? new Map<string, number>();
      const names = new Set([...(loaded.get(server) ?? []), ...called.keys()]);
      const tools = [...names]
        .map((name) => ({ name, calls: called.get(name) ?? 0 }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
      return {
        server,
        toolCount: loaded.get(server)?.size ?? null,
        calls: [...called.values()].reduce((sum, count) => sum + count, 0),
        tools: tools.slice(0, MAX_TOOLS),
        moreTools: Math.max(0, tools.length - MAX_TOOLS),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

export function parseMcpToolLabel(label: string): { server: string; tool: string } | null {
  const qualified = /^(.+?):\s*mcp__(.+?)__(.+)$/.exec(label);
  if (qualified !== null) return { server: qualified[1]!, tool: qualified[3]! };
  const bare = /^mcp__(.+?)__(.+)$/.exec(label);
  if (bare !== null) return { server: bare[1]!, tool: bare[2]! };
  return null;
}

// Owned by the bundled GitHub PR Status plugin; this is the part we read.
const GITHUB_PR_STATUS = "bb--github-pr-status";
const pullRequestRowsSchema = z.record(
  z.string(),
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("available"),
      pullRequest: z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        state: z.enum(["draft", "open", "merged", "closed"]),
        baseRefName: z.string(),
        headRefName: z.string(),
        checks: z.object({
          state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
          totalCount: z.number(),
          passedCount: z.number(),
          failedCount: z.number(),
          pendingCount: z.number(),
        }),
        review: z.object({
          state: z.enum(["approved", "changes_requested", "review_required", "review_requested", "none"]),
        }),
      }),
    }),
    z.object({ outcome: z.literal("absent") }),
    z.object({ outcome: z.literal("unavailable"), message: z.string() }),
  ]),
);

async function readBranchPullRequest(
  sdk: PluginBbSdk,
  environmentId: string,
): Promise<SessionSummary["changes"]["pullRequest"]> {
  try {
    const rows = await sdk.plugins.callRpc({
      pluginId: GITHUB_PR_STATUS,
      method: "pullRequests",
      input: { keys: [environmentId] },
      outputSchema: pullRequestRowsSchema,
    });
    const row = rows[environmentId];
    if (row?.outcome !== "available") return null;
    const pr = row.pullRequest;
    return {
      kind: "pullRequest",
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      // "review_requested" means reviewers are asked but none has answered.
      review: pr.review.state === "review_requested" ? "review_required" : pr.review.state,
      checks: {
        state: pr.checks.state === "no_checks" ? "none" : pr.checks.state,
        passed: pr.checks.passedCount,
        failed: pr.checks.failedCount,
        pending: pr.checks.pendingCount,
        total: pr.checks.totalCount,
      },
    };
  } catch {
    // Plugin disabled, no `gh`, or the machine is offline: nothing to show.
    return null;
  }
}
