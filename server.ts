// Session Summary — backend entry.
//
// Two reads serve both surfaces, the header popover in app.tsx and the
// `bb session-summary` command: `session_summary` (bb's own data) and
// `work_item_statuses` (live GitHub state through the host entry's `gh`).
// While a popover is open on a thread, the server follows that thread's
// realtime changes and invalidates both, so the popover stays current.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  formatTokens,
  hasConversation,
  isTaskActive,
  lineageTree,
  NO_DETAILS,
  taskFacts,
  hostContract,
  rpcContract,
  summaryInputSchema,
  threadTag,
  workItemKey,
  type ItemStatuses,
  type BackgroundTask,
  type SessionSummary,
  type ThreadPort,
  type ThreadRef,
  type TranscriptDetails,
} from "./contract.ts";
import { WorkItemStatuses } from "./statuses.ts";
import { buildSessionSummary, readThreadPlace, TimelineCache } from "./summary.ts";
import { subagentConversation } from "./transcript.ts";

/** Event types that can change what the summary shows. Deltas are ignored. */
const RELEVANT_EVENT_TYPES = new Set<string>([
  "item/completed",
  "turn/completed",
  "turn/diff/updated",
  "thread/contextWindowUsage/updated",
  "thread/compacted",
  "thread/context/cleared",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
]);
const REFRESH_DEBOUNCE_MS = 1_000;
const MAX_CACHED_DETAILS = 200;
/** A transcript that has not named its model yet is read again after this long. */
const DETAILS_RETRY_MS = 15_000;

export default async function plugin(bb: BbPluginApi) {
  const timeline = new TimelineCache(bb.sdk);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const statuses = new WorkItemStatuses(bb.sdk, timeline, (hostId, input) =>
    host.call("github_items", input, { hostId, timeoutMs: 60_000 }),
  );

  /** The machine and folder a thread runs in, when it has both. */
  const threadFolder = async (threadId: string) => {
    const { environment } = await readThreadPlace(bb.sdk, threadId);
    return environment === null || environment.path === null ? null : { hostId: environment.hostId, path: environment.path };
  };
  const requireFolder = async (threadId: string) => {
    const folder = await threadFolder(threadId);
    if (folder === null) throw new Error("This thread has no folder on a machine.");
    return folder;
  };

  /**
   * What only the provider's file says. Best effort: the steps show without
   * it. Kept once the model is known, since it never changes after that.
   */
  const details = new Map<string, { read: TranscriptDetails; at: number }>();
  const readDetails = async (threadId: string, task: BackgroundTask, sessionId: string | null): Promise<TranscriptDetails> => {
    const key = `${threadId}\u0000${task.id}`;
    const known = details.get(key);
    if (known !== undefined && (known.read.model !== null || Date.now() - known.at < DETAILS_RETRY_MS)) return known.read;
    const { thread, environment } = await readThreadPlace(bb.sdk, threadId).catch(() => ({ thread: null, environment: null }));
    if (thread === null || environment === null || environment.path === null) return NO_DETAILS;
    // The path comes from the thread's own events, never from the caller.
    const read = await host
      .call(
        "transcript_details",
        {
          providerId: thread.providerId,
          path: task.outputFile,
          agentId: task.agentId,
          sessionId,
          childRef: task.childRef,
          folder: environment.path,
        },
        { hostId: environment.hostId, timeoutMs: 30_000 },
      )
      .catch(() => NO_DETAILS);
    details.delete(key);
    details.set(key, { read, at: Date.now() });
    if (details.size > MAX_CACHED_DETAILS) details.delete(details.keys().next().value!);
    return read;
  };

  const threadPorts = async (threadId: string) => {
    const folder = await threadFolder(threadId);
    return folder === null ? null : host.call("ports", { path: folder.path }, { hostId: folder.hostId });
  };

  bb.rpc.register(rpcContract, {
    session_summary: ({ threadId }) => buildSessionSummary(bb.sdk, timeline, threadId),
    work_item_statuses: ({ threadId }) => statuses.read(threadId),
    reveal_folder: async ({ threadId }) => {
      const folder = await requireFolder(threadId);
      return host.call("reveal", { path: folder.path }, { hostId: folder.hostId });
    },
    thread_ports: ({ threadId }) => threadPorts(threadId),
    stop_port: async ({ threadId, port }) => {
      const folder = await requireFolder(threadId);
      return host.call("stop_port", { path: folder.path, port }, { hostId: folder.hostId, timeoutMs: 40_000 });
    },
    subagent_transcript: async ({ threadId, taskId }) => {
      const scan = await timeline.read(threadId);
      const task = scan.background.tasks.get(taskId);
      if (task === undefined) throw new Error("This thread has no such background task.");
      if (!hasConversation(task)) throw new Error("This task has no conversation to show.");
      const { model, effort, prompt } = await readDetails(threadId, task, scan.sessionId);
      const conversation = subagentConversation(scan.steps.get(task.delegationId!), prompt, !isTaskActive(task.state));
      return { model, effort, ...conversation };
    },
  });

  bb.rpc.experimental_whileWatched("session_summary", (read, signal) => {
    if (!("input" in read)) return;
    const parsed = summaryInputSchema.safeParse(read.input);
    if (!parsed.success) return;
    const { threadId } = parsed.data;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => bb.rpc.experimental_invalidate([threadTag(threadId)]), REFRESH_DEBOUNCE_MS);
    };

    const unsubscribers: Array<() => void> = [];
    unsubscribers.push(
      bb.sdk.subscribe({
        event: "thread:changed",
        threadId,
        callback: (event) => {
          if (event.changes.includes("history-rewritten")) {
            // An edited message replays from that point: rescan from scratch.
            timeline.reset(threadId);
            refresh();
            return;
          }
          const eventTypes = event.metadata?.eventTypes ?? [];
          if (
            event.changes.includes("environment-changed") ||
            event.changes.includes("history-compacted") ||
            event.metadata?.backgroundActivityChanged === true ||
            eventTypes.some((type) => RELEVANT_EVENT_TYPES.has(type))
          ) {
            refresh();
          }
        },
      }),
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        for (const unsubscribe of unsubscribers) unsubscribe();
      },
      { once: true },
    );
  });

  const usage = "Usage: bb session-summary [thread-id] [--json]";
  bb.cli.register({
    name: "session-summary",
    summary: "Summarize a thread's environment, context, connectors, background tasks, lineage, and changes (bb session-summary [thread-id] [--json])",
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
        return { exitCode: 0, stdout: usage };
      }
      if (args.length > 1) return { exitCode: 1, stderr: usage };
      const threadId = args[0] ?? ctx.threadId;
      if (threadId === undefined) {
        return { exitCode: 1, stderr: `No thread. Pass a thread id or run inside a thread.\n${usage}` };
      }
      const [summary, itemStatuses, ports] = await Promise.all([
        buildSessionSummary(bb.sdk, timeline, threadId),
        statuses.read(threadId).catch((): ItemStatuses => ({})),
        threadPorts(threadId).then((result) => result?.ports ?? [], (): ThreadPort[] => []),
      ]);
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify({ ...summary, statuses: itemStatuses, ports })
          : formatSummary(summary, itemStatuses, ports),
      };
    },
  });
}

function formatSummary(summary: SessionSummary, statuses: ItemStatuses, ports: ThreadPort[]): string {
  const lines: string[] = [`Thread ${summary.threadId} (${summary.providerId})`, ""];
  const env = summary.environment;
  lines.push("Environment");
  if (env === null) {
    lines.push("  No environment");
  } else {
    lines.push(`  Machine: ${env.machine ?? "unknown"}`);
    lines.push(`  Project: ${env.project ?? "unknown"}`);
    lines.push(`  Folder:  ${env.folder ?? "unknown"} (${env.kind})`);
    if (env.branch !== null) {
      const sha = env.headSha === null ? "" : ` @ ${env.headSha.slice(0, 7)}`;
      lines.push(`  Branch:  ${env.branch}${sha}`);
    }
    if (env.workingTree !== null) {
      const tree = env.workingTree;
      lines.push(`  Working tree: ${tree.fileCount} files, +${tree.insertions} -${tree.deletions}`);
    }
    if (env.branchChanges !== null) {
      const branch = env.branchChanges;
      lines.push(
        `  Branch vs ${branch.base}: ${branch.commits} commits, ${branch.fileCount} files, +${branch.insertions} -${branch.deletions}`,
      );
    }
  }

  lines.push("", "Servers");
  if (ports.length === 0) lines.push("  None running from this folder");
  for (const port of ports) {
    const role = port.role === "app" ? "" : ` (${port.role})`;
    lines.push(`  ${port.url}  ${port.name}${role}`);
  }

  lines.push("", "Context");
  const context = summary.context;
  if (context === null) {
    lines.push("  Not reported yet");
  } else {
    const used = context.usedTokens === null ? "?" : formatTokens(context.usedTokens);
    const window = context.windowTokens === null ? "?" : formatTokens(context.windowTokens);
    lines.push(`  ${context.estimated ? "~" : ""}${used} / ${window} tokens`);
    if (context.cost !== null) lines.push(`  Cost: ${context.cost.amount} ${context.cost.currency}`);
    for (const category of context.categories) {
      // Claude Code already names some kinds, e.g. "MCP tools (deferred)".
      const kind =
        category.kind === "used" || category.label.toLowerCase().includes(category.kind) ? "" : ` (${category.kind})`;
      lines.push(`  ${category.label}${kind}: ${formatTokens(category.tokens)}`);
    }
    if (context.categories.length === 0) lines.push("  No breakdown from this provider");
  }

  lines.push("", "Connectors");
  if (summary.connectors.length === 0) lines.push("  None seen");
  for (const connector of summary.connectors) {
    const tools = connector.toolCount === null ? "" : `${connector.toolCount} tools, `;
    lines.push(`  ${connector.server}: ${tools}${connector.calls} calls`);
  }

  lines.push("", "Lineage");
  const { fork, ancestors, descendants, truncated } = summary.lineage;
  if (ancestors.length === 0 && descendants.length === 0) lines.push("  No parent or children");
  ancestors.forEach((thread, depth) => {
    const direct = depth === ancestors.length - 1;
    const label = direct ? (fork ? "Forked from" : "Parent") : "Ancestor";
    lines.push(`  ${"  ".repeat(depth)}${label}: ${formatThreadRef(thread)}`);
  });
  const tree = lineageTree(descendants, summary.threadId, summary.environment?.id ?? null);
  const below = (parentId: string, depth: number): void => {
    for (const child of tree.get(parentId) ?? []) {
      const label = child.parentId !== parentId ? "Same folder" : child.fork ? "Fork" : "Child";
      lines.push(`  ${"  ".repeat(depth)}${label}: ${formatThreadRef(child)}`);
      below(child.id, depth + 1);
    }
  };
  below(summary.threadId, 0);
  if (truncated) lines.push("  …and more below");

  lines.push("", "Background");
  if (summary.background.length === 0) lines.push("  None");
  for (const task of summary.background) lines.push(`  ${formatBackgroundTask(task)}`);
  if (summary.moreBackground > 0) lines.push(`  …and ${summary.moreBackground} older`);

  lines.push("", "Changes");
  const pr = summary.changes.pullRequest;
  if (pr !== null) {
    lines.push(`  Branch PR #${pr.number} (${pr.state}, checks ${pr.checks.state}): ${pr.title} ${pr.url}`);
  }
  for (const item of summary.changes.workItems) {
    const kind = item.kind === "pullRequest" ? "PR" : "Issue";
    const row = statuses[workItemKey(item)];
    const status = row?.outcome === "available" ? row.status : null;
    const now =
      status === null
        ? ""
        : status.kind === "pullRequest"
          ? ` [now ${status.state}, checks ${status.checks.state}]`
          : ` [now ${status.state.replace("_", " ")}]`;
    const url = status?.url ?? item.url;
    lines.push(`  ${kind} ${item.action}: ${item.label}${now}${url === null ? "" : ` ${url}`}`);
  }
  if (pr === null && summary.changes.workItems.length === 0) lines.push("  None");
  return lines.join("\n");
}

function formatThreadRef(thread: ThreadRef): string {
  const archived = thread.archived ? ", archived" : "";
  return `${thread.title} (${thread.id}, ${thread.providerId}, ${thread.status}${archived})`;
}

function formatBackgroundTask(task: BackgroundTask): string {
  const kind = task.detail ?? task.kind;
  const facts = taskFacts(task);
  const after = facts.length === 0 ? "" : ` (${facts.join(", ")})`;
  const output = task.outputFile === null ? "" : `\n    ${task.outputFile}`;
  return `[${task.state}] ${task.title} — ${kind}${after}${output}`;
}
