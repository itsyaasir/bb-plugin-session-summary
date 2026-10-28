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

export const sessionSummarySchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  environment: z
    .object({
      machine: z.string().nullable(),
      project: z.string().nullable(),
      folder: z.string().nullable(),
      kind: z.enum(["worktree", "checkout", "folder"]),
      branch: z.string().nullable(),
      defaultBranch: z.string().nullable(),
      headSha: z.string().nullable(),
      workingTree: z
        .object({ fileCount: z.number(), insertions: z.number(), deletions: z.number() })
        .nullable(),
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
  itemsScanned: z.number(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const summaryInputSchema = z.object({ threadId: z.string().min(1) });

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
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
  repository: {
    experimental_description: "The web page of the thread folder's `origin` remote, or null.",
    input: summaryInputSchema,
    // Untagged: a thread's refreshes don't re-run git; the remote rarely changes.
    output: z.object({ url: z.string().nullable() }),
  },
  reveal_folder: {
    experimental_description: "Show the thread's folder in the file manager of the machine it runs on.",
    input: summaryInputSchema,
    output: z.null(),
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
  /** `git remote get-url origin` in the folder. */
  origin_url: {
    input: z.object({ path: z.string() }),
    output: z.object({ remote: z.string().nullable() }),
  },
  /** Open the folder in Finder, or the platform's file manager. */
  reveal: {
    input: z.object({ path: z.string() }),
    output: z.null(),
  },
});
