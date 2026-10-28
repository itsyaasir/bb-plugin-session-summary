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
  hostContract,
  rpcContract,
  summaryInputSchema,
  threadTag,
  workItemKey,
  type ItemStatuses,
  type SessionSummary,
} from "./contract.ts";
import { repositoryWebUrl } from "./github.ts";
import { WorkItemStatuses } from "./statuses.ts";
import { buildSessionSummary, TimelineCache } from "./summary.ts";

/** Event types that can change what the summary shows. Deltas are ignored. */
const RELEVANT_EVENT_TYPES = new Set<string>([
  "item/completed",
  "turn/completed",
  "turn/diff/updated",
  "thread/contextWindowUsage/updated",
  "thread/compacted",
  "thread/context/cleared",
]);
const REFRESH_DEBOUNCE_MS = 1_000;

export default async function plugin(bb: BbPluginApi) {
  const timeline = new TimelineCache(bb.sdk);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const statuses = new WorkItemStatuses(bb.sdk, timeline, (hostId, input) =>
    host.call("github_items", input, { hostId, timeoutMs: 60_000 }),
  );

  /** The machine and folder a thread runs in, when it has both. */
  const threadFolder = async (threadId: string) => {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return environment.hostId === null || environment.path === null
      ? null
      : { hostId: environment.hostId, path: environment.path, isGitRepo: environment.isGitRepo };
  };

  bb.rpc.register(rpcContract, {
    session_summary: ({ threadId }) => buildSessionSummary(bb.sdk, timeline, threadId),
    work_item_statuses: ({ threadId }) => statuses.read(threadId),
    repository: async ({ threadId }) => {
      const folder = await threadFolder(threadId);
      if (folder === null || !folder.isGitRepo) return { url: null };
      const { remote } = await host.call("origin_url", { path: folder.path }, { hostId: folder.hostId });
      return { url: remote === null ? null : repositoryWebUrl(remote) };
    },
    reveal_folder: async ({ threadId }) => {
      const folder = await threadFolder(threadId);
      if (folder === null) throw new Error("This thread has no folder.");
      return host.call("reveal", { path: folder.path }, { hostId: folder.hostId });
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
            eventTypes.some((type) => RELEVANT_EVENT_TYPES.has(type))
          ) {
            refresh();
          }
        },
      }),
    );
    // Git status (branch switch, new commits, edited files) lives on the environment.
    bb.sdk.threads.get({ threadId }).then(
      (thread) => {
        if (signal.aborted || thread.environmentId === null) return;
        unsubscribers.push(
          bb.sdk.subscribe({
            event: "environment:changed",
            environmentId: thread.environmentId,
            callback: refresh,
          }),
        );
      },
      (error: unknown) => bb.log.warn(`could not watch ${threadId}'s environment: ${String(error)}`),
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
    summary: "Summarize a thread's environment, context, connectors, and changes (bb session-summary [thread-id] [--json])",
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
      const [summary, itemStatuses] = await Promise.all([
        buildSessionSummary(bb.sdk, timeline, threadId),
        statuses.read(threadId).catch((): ItemStatuses => ({})),
      ]);
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify({ ...summary, statuses: itemStatuses }) : formatSummary(summary, itemStatuses),
      };
    },
  });
}

function formatSummary(summary: SessionSummary, statuses: ItemStatuses): string {
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
