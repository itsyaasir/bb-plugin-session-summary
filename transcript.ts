// A subagent's conversation. bb records each step a subagent takes (commands,
// file reads and edits, tool calls, thinking, messages) as a timeline item
// whose `parentToolCallId` is the subagent's delegation item id; summary.ts
// collects them per subagent and this turns them into display entries. It
// works the same for every provider.
//
// The provider's own transcript file adds only what bb does not record: the
// model, the reasoning effort, and Claude Code's prompt (`readTranscriptDetails`).
//
// Pure: no SDK or file access.
import type { TranscriptEntry } from "./contract.ts";
import { isRecord, stringify } from "./timeline.ts";

const MAX_STEPS = 400;
const MAX_TEXT = 6_000;
const MAX_RESULT = 1_500;
const MAX_INPUT = 300;

/** Claude Code's tool for a subagent's final answer. */
const HANDBACK_TOOL = "SubagentHandback";

/** One subagent's latest steps; `omitted` counts older ones dropped. */
export interface SubagentSteps {
  entries: TranscriptEntry[];
  omitted: number;
}

/** Add a subagent's completed step, keeping its latest `MAX_STEPS` entries. */
export function addStep(steps: Map<string, SubagentSteps>, delegationId: string, item: unknown): void {
  const entries = stepEntries(item);
  if (entries.length === 0) return;
  let bucket = steps.get(delegationId);
  if (bucket === undefined) {
    bucket = { entries: [], omitted: 0 };
    steps.set(delegationId, bucket);
  }
  bucket.entries.push(...entries);
  const extra = bucket.entries.length - MAX_STEPS;
  if (extra > 0) {
    bucket.entries.splice(0, extra);
    bucket.omitted += extra;
  }
}

/**
 * The conversation to show: the prompt, when the provider's file has it, then
 * the steps. A finished subagent with no handback reports in its last message.
 */
export function subagentConversation(
  steps: SubagentSteps | undefined,
  prompt: string | null,
  finished: boolean,
): SubagentSteps {
  const entries = [...(prompt === null ? [] : [entry("prompt", clip(prompt, MAX_TEXT))]), ...(steps?.entries ?? [])];
  const last = entries.at(-1);
  if (finished && last?.kind === "text" && !entries.some((candidate) => candidate.kind === "report")) {
    entries[entries.length - 1] = { ...last, kind: "report" };
  }
  return { entries, omitted: steps?.omitted ?? 0 };
}

/** A bb timeline item as display entries: a call and its result, a message, or nothing. */
export function stepEntries(item: unknown): TranscriptEntry[] {
  if (!isRecord(item)) return [];
  switch (item.type) {
    case "agentMessage": {
      const text = text_(item.text);
      return isNoise(text) ? [] : [entry("text", clip(text, MAX_TEXT))];
    }
    case "reasoning": {
      const text = [...list(item.content), ...list(item.summary)].filter((part) => typeof part === "string").join("\n");
      return text.trim() === "" ? [] : [entry("thinking", clip(text, MAX_TEXT))];
    }
    case "commandExecution": {
      // Codex wraps commands in `zsh -lc`; the title is the command itself.
      const title = isRecord(item.presentation) ? text_(item.presentation.title) : "";
      const call = entry("tool", clip(title || text_(item.command), MAX_INPUT), { tool: "Shell" });
      const error = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
      return withResult(call, text_(item.aggregatedOutput), error);
    }
    case "fileRead": {
      const path = text_(item.path);
      return path === "" ? [] : [entry("tool", path, { tool: "Read", path })];
    }
    case "fileChange":
      return list(item.changes)
        .filter(isRecord)
        .map((change) => {
          const path = text_(change.path);
          return entry("tool", path || "file", {
            tool: change.kind === "add" ? "Write" : "Edit",
            path: path || null,
            patch: patchOf(text_(change.diff)),
          });
        });
    case "toolCall": {
      const name = text_(item.tool) || "tool";
      const args = isRecord(item.arguments) ? item.arguments : {};
      if (name === HANDBACK_TOOL) {
        const message = text_(args.message);
        return message === "" ? [] : [entry("report", clip(message, MAX_TEXT))];
      }
      const error = item.status === "failed" || typeof item.error === "string";
      return withResult(entry("tool", describeInput(args), { tool: name }), resultText(item.result) || text_(item.error), error);
    }
    case "delegation":
      return [entry("tool", clip(text_(item.label) || "subagent", MAX_INPUT), { tool: "Agent" })];
    default:
      return [];
  }
}

/**
 * What the provider's transcript adds: the model, the reasoning effort, and
 * (Claude Code) the prompt. `inChild` is false for a Codex child's first
 * lines, which copy the parent's conversation until the child's settings
 * apply; `childId` is that child's session id.
 */
export function readTranscriptDetails(
  jsonl: string,
  childId: string | null,
  inChild: boolean,
): { model: string | null; effort: string | null; prompt: string | null } {
  let model: string | null = null;
  let effort: string | null = null;
  let prompt: string | null = null;
  let child = inChild || childId === null;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = isRecord(record.payload) ? record.payload : {};
    const message = isRecord(record.message) ? record.message : {};
    if (record.type === "assistant") {
      // Claude Code: each reply names its model and effort.
      if (typeof message.model === "string" && !message.model.startsWith("<")) model = message.model;
      if (typeof record.effort === "string") effort = record.effort;
    } else if (record.type === "user" && prompt === null) {
      const content = message.content;
      const text = typeof content === "string" ? content : list(content).map((block) => (isRecord(block) && block.type === "text" ? text_(block.text) : "")).join("\n");
      if (!isNoise(text)) prompt = text;
    } else if (record.type === "event_msg" && payload.type === "thread_settings_applied" && payload.thread_id === childId) {
      child = true;
    } else if (record.type === "turn_context" && child) {
      // Codex: each turn names its model and effort.
      const settings = isRecord(payload.collaboration_mode) && isRecord(payload.collaboration_mode.settings) ? payload.collaboration_mode.settings : {};
      const turnEffort = payload.effort ?? settings.reasoning_effort;
      if (typeof payload.model === "string") model = payload.model;
      if (typeof turnEffort === "string") effort = turnEffort;
    }
  }
  return { model, effort, prompt };
}

function entry(
  kind: TranscriptEntry["kind"],
  text: string,
  fields: Partial<Pick<TranscriptEntry, "tool" | "path" | "patch" | "error">> = {},
): TranscriptEntry {
  return { kind, text, tool: null, path: null, patch: null, error: false, ...fields };
}

/** A call, then its output when it printed something or failed. */
function withResult(call: TranscriptEntry, output: string, error: boolean): TranscriptEntry[] {
  if (output.trim() === "" && !error) return [call];
  return [call, entry("result", clip(output, MAX_RESULT), { tool: call.tool, path: call.path, error })];
}

/** The one argument that says what a call did, else the arguments in brief. */
function describeInput(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return clip(value, MAX_INPUT);
  }
  return clip(stringify(input), MAX_INPUT);
}

/** A tool's result: its text, an MCP result's text blocks, or the value as JSON. */
function resultText(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
  }
  const text = stringify(result);
  return text === "{}" || text === "[]" ? "" : text;
}

/**
 * bb's diff lists the added and removed lines under `---`/`+++` headers with
 * no hunk header; one is added so the diff renders.
 */
function patchOf(diff: string): string | null {
  const lines = clip(diff, MAX_TEXT)
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  if (lines.length === 0) return null;
  if (lines.some((line) => line.startsWith("@@"))) return lines.join("\n");
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  return [`@@ -${removed === 0 ? 0 : 1},${removed} +1,${added} @@`, ...lines].join("\n");
}

function text_(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Empty text, or a reminder Claude Code injects for the agent rather than a message. */
function isNoise(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>"));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
