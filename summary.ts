// Builds one thread's session summary from bb's SDK: environment (machine,
// project, folder, branch), context usage and where it comes from, connectors,
// and changes (the branch's PR plus PRs and issues found in the timeline).
//
// Every source is optional. A missing machine, a non-git folder, a provider
// without a context breakdown, or a disabled PR plugin leaves that part null
// instead of failing the whole summary.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BACKGROUND_EVENT_TYPES, finishBackground, scanBackgroundEvent } from "./background.ts";
import { GIT_PLUGIN, gitContract, gitView, type SessionSummary, type ThreadRef } from "./contract.ts";
import { repositoryWebUrl } from "./github.ts";
import { createTimelineScan, isRecord, scanItem, type TimelineScan } from "./timeline.ts";
import { addStep } from "./transcript.ts";


const MAX_ENTRIES = 8;
const MAX_TOOLS = 40;
const MAX_BACKGROUND = 30;
/** The server's cap on `threads.events.list`. */
const EVENTS_PAGE = 100;
/** Pages read per summary; a longer backlog continues on the next refresh. */
const MAX_PAGES_PER_READ = 50;
const MAX_CACHED_THREADS = 100;
const MAX_ANCESTORS = 10;
/** Levels of descendants read below a thread. */
const MAX_DEPTH = 6;
const MAX_DESCENDANTS = 200;

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
        types: ["item/completed", "thread/identity", ...BACKGROUND_EVENT_TYPES],
        order: "asc",
        limit: String(EVENTS_PAGE),
        ...(entry.afterSeq === null ? {} : { afterSeq: String(entry.afterSeq) }),
      });
      for (const row of rows) {
        entry.afterSeq = row.seq;
        if (row.type === "thread/identity") entry.scan.sessionId = row.data.providerThreadId ?? entry.scan.sessionId;
        if (!("item" in row.data)) continue;
        const item = row.data.item;
        // A subagent's step belongs to its conversation, not to this thread's counts.
        const parentId = subagentParent(item);
        if (row.type === "item/completed" && parentId !== null) {
          addStep(entry.scan.steps, parentId, item);
          continue;
        }
        if (row.type === "item/completed") scanItem(entry.scan, item);
        scanBackgroundEvent(entry.scan.background, item, row.createdAt);
      }
      if (rows.length < EVENTS_PAGE) break;
    }
    return entry.scan;
  }
}

/** The delegation a subagent's step belongs to. A background task names its delegation the same way but is the agent's own. */
function subagentParent(item: unknown): string | null {
  if (!isRecord(item) || item.type === "backgroundTask") return null;
  return typeof item.parentToolCallId === "string" ? item.parentToolCallId : null;
}

export async function buildSessionSummary(
  sdk: PluginBbSdk,
  timeline: TimelineCache,
  threadId: string,
): Promise<SessionSummary> {
  // These need only the id, so they start before the thread is read.
  const reads = Promise.all([
    sdk.threads.context({ threadId }).then((result) => result.usage, () => null),
    timeline.read(threadId),
    readActiveTasks(sdk, threadId),
  ]);
  reads.catch(() => {});
  const { thread, environment: place, hostName } = await readThreadPlace(sdk, threadId);
  const [[context, scan, activity], environment, pullRequest, lineage] = await Promise.all([
    reads,
    readEnvironment(sdk, place, hostName, thread.projectId),
    thread.environmentId === null ? null : readBranchPullRequest(sdk, thread.environmentId),
    readLineage(sdk, threadId, thread.parentThreadId, thread.originKind === "fork"),
  ]);
  const background = finishBackground(scan.background, activity, MAX_BACKGROUND);

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
    background: background.tasks,
    moreBackground: background.more,
    lineage,
    itemsScanned: scan.itemsScanned,
  };
}

type ThreadRow = Awaited<ReturnType<PluginBbSdk["threads"]["list"]>>[number];

function threadRef(row: ThreadRow): ThreadRef {
  return {
    id: row.id,
    parentId: row.parentThreadId,
    environmentId: row.environmentId,
    title: row.title ?? row.titleFallback ?? "Untitled thread",
    providerId: row.providerId,
    status: row.status,
    archived: row.archivedAt !== null,
    fork: row.originKind === "fork",
    createdAt: row.createdAt,
  };
}

/**
 * A thread's events never change its parents or children, but a summary is
 * rebuilt on each one, so lineage is read at most this often. The panel adds
 * newly spawned threads live.
 */
const LINEAGE_TTL_MS = 30_000;
const lineageCache = new Map<string, { at: number; lineage: SessionSummary["lineage"] }>();

export type ListThreads = (args: Parameters<PluginBbSdk["threads"]["list"]>[0]) => Promise<ThreadRow[]>;

/** The threads above and below this one, archived ones too; a part bb cannot read is left out. */
async function readLineage(
  sdk: PluginBbSdk,
  threadId: string,
  parentId: string | null,
  fork: boolean,
): Promise<SessionSummary["lineage"]> {
  const cached = lineageCache.get(threadId);
  if (cached !== undefined && Date.now() - cached.at < LINEAGE_TTL_MS) return cached.lineage;

  const list: ListThreads = (args) => sdk.threads.list(args).catch(() => []);
  const [ancestors, below] = await Promise.all([readAncestors(list, threadId, parentId), readDescendants(list, threadId)]);
  const lineage = { fork, ancestors, ...below };
  lineageCache.delete(threadId);
  lineageCache.set(threadId, { at: Date.now(), lineage });
  if (lineageCache.size > MAX_CACHED_THREADS) lineageCache.delete(lineageCache.keys().next().value!);
  return lineage;
}

/** The chain of parents, root first; it stops at a thread bb cannot read or at a loop. */
export async function readAncestors(list: ListThreads, threadId: string, parentId: string | null): Promise<ThreadRef[]> {
  const chain: ThreadRef[] = [];
  const seen = new Set([threadId]);
  let next = parentId;
  while (next !== null && !seen.has(next) && chain.length < MAX_ANCESTORS) {
    seen.add(next);
    const id = next;
    const rows = await Promise.all([false, true].map((archived) => list({ threadIds: [id], includeHidden: true, archived })));
    const row = rows.flat()[0];
    if (row === undefined) break;
    chain.unshift(threadRef(row));
    next = row.parentThreadId;
  }
  return chain;
}

/** Every thread below this one, read a level at a time. */
export async function readDescendants(
  list: ListThreads,
  threadId: string,
): Promise<{ descendants: ThreadRef[]; truncated: boolean }> {
  const descendants: ThreadRef[] = [];
  const seen = new Set([threadId]);
  let level = [threadId];
  for (let depth = 0; level.length > 0; depth += 1) {
    const rows = await Promise.all(
      level.flatMap((id) => [list({ parentThreadId: id }), list({ parentThreadId: id, archived: true })]),
    );
    const found = rows.flat().filter((row) => !seen.has(row.id));
    if (found.length > 0 && depth === MAX_DEPTH) return { descendants: sortByAge(descendants), truncated: true };
    if (descendants.length + found.length > MAX_DESCENDANTS) {
      descendants.push(...found.slice(0, MAX_DESCENDANTS - descendants.length).map(threadRef));
      return { descendants: sortByAge(descendants), truncated: true };
    }
    for (const row of found) seen.add(row.id);
    descendants.push(...found.map(threadRef));
    level = found.map((row) => row.id);
  }
  return { descendants: sortByAge(descendants), truncated: false };
}

function sortByAge(threads: ThreadRef[]): ThreadRef[] {
  return threads.sort((a, b) => a.createdAt - b.createdAt);
}

/** The background tasks and workflows bb lists as still running, by item id; null when bb could not say. */
async function readActiveTasks(sdk: PluginBbSdk, threadId: string): Promise<Set<string> | null> {
  try {
    const timeline = await sdk.threads.timeline({ threadId, summaryOnly: "true", segmentLimit: "1" });
    return new Set([...timeline.activeBackgroundCommands, ...timeline.activeWorkflows].map((row) => row.itemId));
  } catch {
    return null;
  }
}

/** The panel's queries open together and each needs the thread, so one read is shared this long. */
const PLACE_SHARE_MS = 2_000;
const placeReads = new Map<string, { at: number; read: ReturnType<typeof fetchThreadPlace> }>();

/** A thread with its environment and machine name, in one call shared by reads close together. */
export function readThreadPlace(sdk: PluginBbSdk, threadId: string): ReturnType<typeof fetchThreadPlace> {
  const now = Date.now();
  for (const [id, entry] of placeReads) if (now - entry.at >= PLACE_SHARE_MS) placeReads.delete(id);
  const shared = placeReads.get(threadId);
  if (shared !== undefined) return shared.read;
  const read = fetchThreadPlace(sdk, threadId);
  placeReads.set(threadId, { at: now, read });
  read.catch(() => placeReads.delete(threadId));
  return read;
}

async function fetchThreadPlace(sdk: PluginBbSdk, threadId: string) {
  const thread = await sdk.threads.get({ threadId, include: "environment,host" });
  return {
    thread,
    environment: ("environment" in thread ? thread.environment : null) ?? null,
    hostName: ("environmentHostName" in thread ? thread.environmentHostName : null) ?? null,
  };
}
type ThreadEnvironment = NonNullable<Awaited<ReturnType<typeof readThreadPlace>>["environment"]>;

async function readEnvironment(
  sdk: PluginBbSdk,
  environment: ThreadEnvironment | null,
  hostName: string | null,
  projectId: string,
): Promise<SessionSummary["environment"]> {
  if (environment === null) return null;
  const [project, git] = await Promise.all([
    sdk.projects.get({ projectId }).catch(() => null),
    environment.isGitRepo ? readGitStatus(sdk, environment.id) : null,
  ]);
  const remote = environment.isGitRepo ? (project?.gitRemoteUrl ?? null) : null;
  return {
    id: environment.id,
    machine: hostName,
    project: project?.name ?? null,
    repositoryUrl: remote === null ? null : repositoryWebUrl(remote),
    folder: environment.path,
    kind: environment.isWorktree ? "worktree" : environment.isGitRepo ? "checkout" : "folder",
    branch: git?.branch ?? environment.branchName,
    headSha: git?.headSha ?? null,
    workingTree: git?.workingTree ?? null,
    branchChanges: git?.branchChanges ?? null,
  };
}

async function readGitStatus(sdk: PluginBbSdk, environmentId: string) {
  const row = await readKeyedRow(sdk, GIT_PLUGIN, "status", environmentId, gitContract.status.output);
  return row?.outcome === "available" ? gitView(row.workspace) : null;
}

/** One environment's row from another plugin's keyed RPC; null when the plugin is missing or fails. */
async function readKeyedRow<Row>(
  sdk: PluginBbSdk,
  pluginId: string,
  method: string,
  key: string,
  outputSchema: z.ZodType<Record<string, Row>>,
): Promise<Row | null> {
  try {
    const rows = await sdk.plugins.callRpc({ pluginId, method, input: { keys: [key] }, outputSchema });
    return rows[key] ?? null;
  } catch {
    return null;
  }
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
  const row = await readKeyedRow(sdk, GITHUB_PR_STATUS, "pullRequests", environmentId, pullRequestRowsSchema);
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
}
