// A thread's background work: commands, subagents, and workflows the agent
// started and left running. bb records each as a `backgroundTask` item:
// `item/started` when it starts, `item/backgroundTask/progress` while it runs,
// `item/backgroundTask/completed` when it ends, all under the same item id.
// Finished tasks stay listed so their result and output file can be found.
//
// A subagent the agent waits on (Codex always, Claude Code when not run in the
// background) is a `delegation` item instead, whose `childRef` names the
// child: Codex's child session id, or Claude Code's tool call id. A background
// task whose `parentToolCallId` is the delegation's item id replaces it.
//
// Pure: no SDK access, so the parsing is unit-testable on recorded events.
import { z } from "zod";
import { isTaskActive, type BackgroundTask } from "./contract.ts";

export interface BackgroundScan {
  /** Keyed by item id, in start order. */
  tasks: Map<string, BackgroundTask>;
  /** A subagent's kind ("Explore agent") by its delegation's item id. */
  delegations: Map<string, string>;
  /** Delegations a background task took over, by item id. */
  claimed: Set<string>;
}

export function createBackgroundScan(): BackgroundScan {
  return { tasks: new Map(), delegations: new Map(), claimed: new Set() };
}

export const BACKGROUND_EVENT_TYPES = [
  "item/started",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
] as const;

const presentationSchema = z.object({ detail: z.string().optional() }).optional();
const usageSchema = z
  .object({
    durationMs: z.number().optional(),
    toolUses: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .optional();
const backgroundTaskItemSchema = z.object({
  type: z.literal("backgroundTask"),
  id: z.string(),
  familyId: z.string().optional(),
  taskType: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  taskStatus: z.string().optional(),
  summary: z.string().optional(),
  outputFile: z.string().optional(),
  parentToolCallId: z.string().optional(),
  usage: usageSchema,
  workflowName: z.string().optional(),
  workflow: z
    .object({
      agents: z.array(z.object({ label: z.string().optional(), state: z.string().optional() })).optional(),
    })
    .optional(),
  presentation: presentationSchema,
});
const delegationItemSchema = z.object({
  type: z.literal("delegation"),
  id: z.string(),
  childRef: z.string().optional(),
  label: z.string().optional(),
  status: z.string().optional(),
  background: z.boolean().optional(),
  summary: z.string().optional(),
  presentation: presentationSchema,
});

const MAX_AGENTS = 20;

/** Feed one event's `item` with the event's type and time. Other items are ignored. */
export function scanBackgroundEvent(scan: BackgroundScan, item: unknown, at: number): void {
  const type = (item as { type?: unknown } | null)?.type;
  if (type === "delegation") {
    const parsed = delegationItemSchema.safeParse(item);
    if (parsed.success) scanDelegation(scan, parsed.data, at);
    return;
  }
  if (type !== "backgroundTask") return;
  const parsed = backgroundTaskItemSchema.safeParse(item);
  if (!parsed.success) return;
  const data = parsed.data;
  if (data.parentToolCallId !== undefined && !scan.claimed.has(data.parentToolCallId)) {
    scan.claimed.add(data.parentToolCallId);
    scan.tasks.delete(data.parentToolCallId);
  }
  const previous = scan.tasks.get(data.id);
  const state = stateFor(data.taskStatus ?? data.status) ?? previous?.state ?? "running";
  const startedAt = previous?.startedAt ?? at;
  const endedAt = isTaskActive(state) ? null : (previous?.endedAt ?? at);
  const agents = data.workflow?.agents?.slice(0, MAX_AGENTS).map((agent) => ({
    label: agent.label ?? "agent",
    state: agent.state ?? "unknown",
  }));
  scan.tasks.set(data.id, {
    id: data.id,
    kind: kindFor(data.taskType, data.workflow !== undefined || data.workflowName !== undefined) ?? previous?.kind ?? "agent",
    title: data.description ?? previous?.title ?? "Background task",
    detail:
      data.presentation?.detail ??
      data.workflowName ??
      (data.parentToolCallId === undefined ? undefined : scan.delegations.get(data.parentToolCallId)) ??
      previous?.detail ??
      null,
    state,
    startedAt,
    endedAt,
    // Commands report no usage; their span stands in.
    durationMs: data.usage?.durationMs ?? previous?.durationMs ?? (endedAt === null ? null : endedAt - startedAt),
    tokens: data.usage?.totalTokens ?? previous?.tokens ?? null,
    toolUses: data.usage?.toolUses ?? previous?.toolUses ?? null,
    summary: forUser(data.summary) ?? previous?.summary ?? null,
    outputFile: data.outputFile ?? previous?.outputFile ?? null,
    agentId: data.familyId ?? previous?.agentId ?? null,
    childRef: null,
    delegationId: data.parentToolCallId ?? previous?.delegationId ?? null,
    agents: agents ?? previous?.agents ?? [],
  });
}

function scanDelegation(scan: BackgroundScan, data: z.infer<typeof delegationItemSchema>, at: number): void {
  const detail = data.presentation?.detail;
  if (detail !== undefined) scan.delegations.set(data.id, detail);
  // A background one is listed by its background task.
  if (data.childRef === undefined || data.background === true || scan.claimed.has(data.id)) return;
  const previous = scan.tasks.get(data.id);
  const state = stateFor(data.status) ?? previous?.state ?? "running";
  const startedAt = previous?.startedAt ?? at;
  const endedAt = isTaskActive(state) ? null : (previous?.endedAt ?? at);
  scan.tasks.set(data.id, {
    id: data.id,
    kind: "agent",
    title: data.label ?? previous?.title ?? "Subagent",
    detail: detail ?? previous?.detail ?? null,
    state,
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : endedAt - startedAt,
    tokens: null,
    toolUses: null,
    summary: forUser(data.summary) ?? previous?.summary ?? null,
    outputFile: null,
    agentId: null,
    childRef: data.childRef,
    delegationId: data.id,
    agents: [],
  });
}

/**
 * Running first (oldest first), then finished (latest first), at most `limit`.
 * `active` is the item ids bb still lists as running background work; a task
 * missing from it missed its completion event, e.g. the provider exited, and
 * shows as stopped instead of running forever.
 */
export function finishBackground(
  scan: BackgroundScan,
  active: ReadonlySet<string> | null,
  limit: number,
): { tasks: BackgroundTask[]; more: number } {
  const tasks = [...scan.tasks.values()].map((task) => {
    // bb lists only background work; a delegation ends with its own event.
    if (active === null || !isTaskActive(task.state) || task.childRef !== null || active.has(task.id)) return task;
    return { ...task, state: "stopped" as const };
  });
  tasks.sort((a, b) => {
    const active = isTaskActive(a.state);
    if (active !== isTaskActive(b.state)) return active ? -1 : 1;
    return active
      ? (a.startedAt ?? 0) - (b.startedAt ?? 0)
      : (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
  return { tasks: tasks.slice(0, limit), more: Math.max(0, tasks.length - limit) };
}

/**
 * Claude Code's agent summary is a note to the parent agent ("This agent's
 * report was delivered to you as a message…"), not a result; the report
 * itself is in the conversation.
 */
function forUser(summary: string | undefined): string | undefined {
  return summary !== undefined && /report was delivered to you|agent launched successfully/i.test(summary) ? undefined : summary;
}

function stateFor(status: string | undefined): BackgroundTask["state"] | null {
  switch (status) {
    case "running":
    case "pending":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
    case "interrupted":
      return "stopped";
    default:
      return null;
  }
}

/** Claude Code says `local_bash` and `local_agent`; others may say more. */
function kindFor(taskType: string | undefined, hasWorkflow: boolean): BackgroundTask["kind"] | null {
  if (hasWorkflow || /workflow/i.test(taskType ?? "")) return "workflow";
  if (taskType === undefined) return null;
  if (/bash|shell|command|terminal/i.test(taskType)) return "command";
  return "agent";
}
