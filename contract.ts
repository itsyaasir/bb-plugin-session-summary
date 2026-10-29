// The RPC contracts shared by server.ts, host.ts, and app.tsx. Kept free of
// server code so the frontend bundle imports only these schemas.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const workItemSchema = z.object({
  kind: z.enum(["pullRequest", "issue"]),
  action: z.enum(["opened", "merged", "closed"]),
  source: z.enum(["github", "linear"]),
  label: z.string(),
  url: z.string().nullable(),
});

const checksSchema = z.object({
  state: z.enum(["passing", "failing", "pending", "none", "unknown"]),
  passed: z.number(),
  failed: z.number(),
  pending: z.number(),
  total: z.number(),
});
export type Checks = z.infer<typeof checksSchema>;

const pullRequestStatusSchema = z.object({
  kind: z.literal("pullRequest"),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  review: z.enum(["approved", "changes_requested", "review_required", "none"]),
  checks: checksSchema,
});
export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;

const issueStatusSchema = z.object({
  kind: z.literal("issue"),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "completed", "not_planned"]),
  labels: z.array(z.string()),
});
export type IssueStatus = z.infer<typeof issueStatusSchema>;

const itemStatusRowSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    status: z.discriminatedUnion("kind", [pullRequestStatusSchema, issueStatusSchema]),
  }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);
export type ItemStatusRow = z.infer<typeof itemStatusRowSchema>;

/** Live GitHub status per work item, keyed by `workItemKey`. */
const itemStatusesSchema = z.record(z.string(), itemStatusRowSchema);
export type ItemStatuses = z.infer<typeof itemStatusesSchema>;

export function workItemKey(item: { kind: string; label: string }): string {
  return `${item.kind}:${item.label}`;
}

/** A command, subagent, or workflow the agent left running, or one that has since ended. */
const backgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.enum(["command", "agent", "workflow"]),
  title: z.string(),
  /** The subagent's kind ("Explore agent") or the workflow's name. */
  detail: z.string().nullable(),
  state: z.enum(["running", "paused", "completed", "failed", "stopped"]),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  tokens: z.number().nullable(),
  toolUses: z.number().nullable(),
  /** The provider's one-line result, e.g. "failed with exit code 1". */
  summary: z.string().nullable(),
  outputFile: z.string().nullable(),
  /**
   * The provider's id for a subagent. bb sends the output file only when the
   * task ends; until then this finds the transcript.
   */
  agentId: z.string().nullable(),
  /** A subagent the agent waited on: Codex's child session id, or Claude Code's tool call id. */
  childRef: z.string().nullable(),
  /** The delegation item that started a subagent; bb tags each of its steps with this id. */
  delegationId: z.string().nullable(),
  /** A workflow's agents. */
  agents: z.array(z.object({ label: z.string(), state: z.string() })),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

/** One message or step in a subagent's conversation. */
const transcriptEntrySchema = z.object({
  /** prompt: what it was asked; report: its final answer; result: a tool's output. */
  kind: z.enum(["prompt", "text", "thinking", "tool", "result", "report"]),
  text: z.string(),
  /** A tool call's name; on a result, the call it answers. */
  tool: z.string().nullable(),
  /** The file a call touched, or a result shows, for syntax highlighting. */
  path: z.string().nullable(),
  /** An edit or write as a unified patch for one file. */
  patch: z.string().nullable(),
  error: z.boolean(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

const transcriptDetailsSchema = z.object({
  model: z.string().nullable(),
  effort: z.string().nullable(),
  prompt: z.string().nullable(),
});
export type TranscriptDetails = z.infer<typeof transcriptDetailsSchema>;
export const NO_DETAILS: TranscriptDetails = { model: null, effort: null, prompt: null };

const transcriptSchema = z.object({
  /** What the subagent ran on, when the transcript says. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  entries: z.array(transcriptEntrySchema),
  /** Entries left out between the prompt and the latest ones. */
  omitted: z.number(),
});

/** A related bb thread: one above this one, or one spawned or forked below it. */
const threadRefSchema = z.object({
  id: z.string(),
  /** The thread it was spawned under or forked from. */
  parentId: z.string().nullable(),
  /** The folder it works in; threads sharing one worked on the same thing. */
  environmentId: z.string().nullable(),
  title: z.string(),
  providerId: z.string(),
  status: z.string(),
  archived: z.boolean(),
  /** Forked from its parent, rather than spawned to do part of its work. */
  fork: z.boolean(),
  createdAt: z.number(),
});
export type ThreadRef = z.infer<typeof threadRefSchema>;

const diffStatSchema = z.object({ fileCount: z.number(), insertions: z.number(), deletions: z.number() });
export type DiffStat = z.infer<typeof diffStatSchema>;

export const sessionSummarySchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  environment: z
    .object({
      id: z.string(),
      machine: z.string().nullable(),
      project: z.string().nullable(),
      /** The project's remote as a web page, e.g. on GitHub. */
      repositoryUrl: z.string().nullable(),
      folder: z.string().nullable(),
      kind: z.enum(["worktree", "checkout", "folder"]),
      branch: z.string().nullable(),
      headSha: z.string().nullable(),
      /** Uncommitted changes. */
      workingTree: diffStatSchema.nullable(),
      /** Commits on this branch not yet in `base`: what its pull request shows. */
      branchChanges: diffStatSchema.extend({ base: z.string(), commits: z.number() }).nullable(),
    })
    .nullable(),
  context: z
    .object({
      usedTokens: z.number().nullable(),
      windowTokens: z.number().nullable(),
      estimated: z.boolean(),
      cost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
      autoCompactAtTokens: z.number().nullable(),
      capturedAt: z.string().nullable(),
      categories: z.array(
        z.object({
          label: z.string(),
          kind: z.enum(["used", "free", "reserved", "deferred"]),
          tokens: z.number(),
          /** Largest first, at most MAX_ENTRIES; `more` counts the rest. */
          entries: z.array(z.object({ label: z.string(), tokens: z.number() })),
          more: z.number(),
        }),
      ),
    })
    .nullable(),
  connectors: z.array(
    z.object({
      server: z.string(),
      /** Tools the provider loaded for this server; null when it reported no breakdown. */
      toolCount: z.number().nullable(),
      calls: z.number(),
      /** Most-called first, at most MAX_TOOLS; `moreTools` counts the rest. */
      tools: z.array(z.object({ name: z.string(), calls: z.number() })),
      moreTools: z.number(),
    }),
  ),
  changes: z.object({
    /** The branch's PR from the GitHub PR Status plugin, with its checks. */
    pullRequest: pullRequestStatusSchema.nullable(),
    workItems: z.array(workItemSchema),
  }),
  /** Running first, then finished, latest first; `moreBackground` counts what was left out. */
  background: z.array(backgroundTaskSchema),
  moreBackground: z.number(),
  lineage: z.object({
    /** This thread was forked from its parent, rather than spawned by it. */
    fork: z.boolean(),
    /** The threads above this one: the root first, the direct parent last. */
    ancestors: z.array(threadRefSchema),
    /** Every thread below this one, at any depth and archived ones included, oldest first; `parentId` places each. */
    descendants: z.array(threadRefSchema),
    /** The depth or count limit left some descendants out. */
    truncated: z.boolean(),
  }),
  itemsScanned: z.number(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const summaryInputSchema = z.object({ threadId: z.string().min(1) });
export const portSchema = z.number().int().min(1).max(65535);

/** A port listening for a process, or a Docker container, started in the thread's folder. */
const threadPortSchema = z.object({
  port: portSchema,
  address: z.string(),
  /** 0 for a Docker container's published port. */
  pid: z.number().int(),
  process: z.string(),
  source: z.enum(["process", "docker"]),
  container: z.string().nullable(),
  /** Compose service (`postgres`, `redis`) for a Docker row. */
  service: z.string().nullable(),
  /** From the folder's `.bb/ports.json`. */
  label: z.string().nullable(),
  /** The app being developed, a backing service, or a loopback port nobody opens. */
  role: z.enum(["app", "service", "internal"]),
  /** What the row shows: the label, the service, or the process. */
  name: z.string(),
  url: z.string(),
});
export type ThreadPort = z.infer<typeof threadPortSchema>;

const portsSchema = z.object({
  ports: z.array(threadPortSchema),
});

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** 42_000 → "42s", 95_000 → "1m 35s", 5_400_000 → "1h 30m". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Still running or paused, as against completed, failed, or stopped. */
export function isTaskActive(state: BackgroundTask["state"]): boolean {
  return state === "running" || state === "paused";
}

/** Threads grouped under the thread they were spawned from, keeping their order. */
export function groupByParent(threads: readonly ThreadRef[]): Map<string, ThreadRef[]> {
  const groups = new Map<string, ThreadRef[]>();
  for (const thread of threads) {
    if (thread.parentId !== null) push(groups, thread.parentId, thread);
  }
  return groups;
}

/**
 * The tree to show below `rootId`: each thread under the one that spawned it,
 * except that a later sibling working in the same folder as an earlier one
 * (a review of that work, say) goes under the earlier one. Siblings in their
 * parent's own folder stay where they are. `descendants` come oldest first;
 * each level is sorted again because moved siblings join the earlier one's children.
 */
export function lineageTree(
  descendants: readonly ThreadRef[],
  rootId: string,
  rootEnvironmentId: string | null,
): Map<string, ThreadRef[]> {
  const folderOf = new Map(descendants.map((thread) => [thread.id, thread.environmentId]));
  folderOf.set(rootId, rootEnvironmentId);
  const tree = new Map<string, ThreadRef[]>();
  for (const [parentId, siblings] of groupByParent(descendants)) {
    const first = new Map<string, string>();
    for (const thread of siblings) {
      const folder = thread.environmentId;
      if (folder === null || folder === folderOf.get(parentId)) {
        push(tree, parentId, thread);
        continue;
      }
      const earlier = first.get(folder);
      if (earlier === undefined) first.set(folder, thread.id);
      push(tree, earlier ?? parentId, thread);
    }
  }
  for (const level of tree.values()) level.sort((a, b) => a.createdAt - b.createdAt);
  return tree;
}

function push<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [value]);
  else group.push(value);
}

/** A subagent whose steps bb recorded; commands have only output. */
export function hasConversation(task: BackgroundTask): boolean {
  return task.kind !== "command" && task.delegationId !== null;
}

/** Duration, tokens, and tool uses, the ones known; callers join them. */
export function taskFacts(task: Pick<BackgroundTask, "durationMs" | "tokens" | "toolUses">): string[] {
  return [
    task.durationMs === null ? null : formatDuration(task.durationMs),
    task.tokens === null ? null : `${formatTokens(task.tokens)} tokens`,
    task.toolUses === null ? null : `${task.toolUses} tool ${task.toolUses === 1 ? "use" : "uses"}`,
  ].filter((fact) => fact !== null);
}

export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}


export const rpcContract = defineRpcContract({
  session_summary: {
    experimental_description:
      "A thread's environment, context usage by source, MCP connectors, and the PRs and issues it opened.",
    input: summaryInputSchema,
    output: sessionSummarySchema,
    tags: (input) => [threadTag(input.threadId)],
  },
  work_item_statuses: {
    experimental_description:
      "Live GitHub state, checks, and review of the PRs and issues a thread opened, merged, or closed.",
    input: summaryInputSchema,
    output: itemStatusesSchema,
    tags: (input) => [threadTag(input.threadId)],
  },
  reveal_folder: {
    experimental_description: "Show the thread's folder in the file manager of the machine it runs on.",
    input: summaryInputSchema,
    output: z.null(),
  },
  thread_ports: {
    experimental_description:
      "Servers listening on the thread's machine whose process or Docker Compose project started in the thread's folder.",
    input: summaryInputSchema,
    // Null when the thread has no folder.
    output: portsSchema.nullable(),
  },
  stop_port: {
    experimental_description: "Stop the process or Docker container listening on a port the thread's folder started.",
    input: summaryInputSchema.extend({ port: portSchema }),
    output: z.object({ detail: z.string() }),
  },
  subagent_transcript: {
    experimental_description: "A background subagent's conversation: its prompt, tool calls and results, and its report.",
    input: z.object({ threadId: z.string().min(1), taskId: z.string().min(1) }),
    output: transcriptSchema,
  },
});

/** The host entry runs `gh` on the thread's machine, where its login lives. */
export const hostContract = defineRpcContract({
  github_items: {
    experimental_retryable: true,
    input: z.object({
      /** The environment's folder, so a bare `#12` resolves to its repository. */
      cwd: z.string().nullable(),
      items: z
        .array(z.object({ key: z.string(), kind: z.enum(["pullRequest", "issue"]), ref: z.string().min(1) }))
        .max(100),
    }),
    output: itemStatusesSchema,
  },
  /** Open the folder in Finder, or the platform's file manager. */
  reveal: {
    input: z.object({ path: z.string() }),
    output: z.null(),
  },
  /** lsof and `docker ps`, kept to what the folder started. */
  ports: {
    input: z.object({ path: z.string() }),
    output: portsSchema,
  },
  /** Stop what a fresh scan finds on the port, so it can only stop the folder's own. */
  stop_port: {
    input: z.object({ path: z.string(), port: portSchema }),
    output: z.object({ detail: z.string() }),
  },
  /**
   * The model, effort, and prompt from a subagent's provider transcript: the
   * task's own output file, Claude Code's file for `agentId` or the tool call
   * `childRef` in session `sessionId`, or Codex's child session `childRef`.
   */
  transcript_details: {
    input: z.object({
      providerId: z.string(),
      path: z.string().nullable(),
      agentId: z.string().regex(/^[\w-]+$/).nullable(),
      sessionId: z.string().regex(/^[\w-]+$/).nullable(),
      childRef: z.string().regex(/^[\w-]+$/).nullable(),
      folder: z.string(),
    }),
    output: transcriptDetailsSchema,
  },
});

// Owned by the bundled Git plugin, which bb's Diff tab reads too; this is the
// part we read. `status` is keyed by environment id and refreshes whenever the
// workspace's files or refs change.
export const GIT_PLUGIN = "bb--git";
export const gitContract = defineRpcContract({
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          workspace: z.object({
            workingTree: diffStatSchema,
            checkout: z
              .object({ kind: z.string(), branchName: z.string().optional(), headSha: z.string().nullable().optional() })
              .nullable()
              .optional(),
            mergeBase: diffStatSchema.extend({ mergeBaseBranch: z.string(), aheadCount: z.number() }).nullable().optional(),
          }),
        }),
        z.object({ outcome: z.literal("unavailable") }).passthrough(),
      ]),
    ),
  },
});
type GitWorkspace = Extract<z.infer<typeof gitContract.status.output>[string], { outcome: "available" }>["workspace"];

/** What the panel shows from a `bb--git` workspace. */
export function gitView(workspace: GitWorkspace) {
  const { checkout, workingTree, mergeBase } = workspace;
  let branchChanges = null;
  if (mergeBase) {
    const { mergeBaseBranch, aheadCount, ...stat } = mergeBase;
    branchChanges = { ...stat, base: mergeBaseBranch, commits: aheadCount };
  }
  return {
    branch: checkout?.kind === "branch" ? (checkout.branchName ?? null) : null,
    headSha: checkout?.headSha ?? null,
    workingTree,
    branchChanges,
  };
}
