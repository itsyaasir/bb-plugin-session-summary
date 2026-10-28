// Reads a thread's completed timeline items and keeps what the summary needs:
// which MCP servers the agent called, and the pull requests and issues it
// opened, merged, or closed. bb records neither directly, so both are inferred
// from shell commands (`gh pr create`) and MCP tool calls (Linear save_issue,
// GitHub create_pull_request) and their output.
//
// Pure: no SDK access, so the parsing is unit-testable on recorded items.
import { z } from "zod";

export type WorkItemKind = "pullRequest" | "issue";
export type WorkItemAction = "opened" | "merged" | "closed";
export type WorkItemSource = "github" | "linear";

export interface WorkItem {
  kind: WorkItemKind;
  action: WorkItemAction;
  source: WorkItemSource;
  /** "#9", "owner/repo#9" or "ENG-42". */
  label: string;
  url: string | null;
}

export interface ToolUse {
  server: string;
  tool: string;
  calls: number;
}

export interface TimelineScan {
  /** Keyed by `${server}\u0000${tool}`. */
  toolUses: Map<string, ToolUse>;
  /** Keyed by `${kind}:${action}:${label}`; later sightings never overwrite a URL with null. */
  workItems: Map<string, WorkItem>;
  itemsScanned: number;
}

export function createTimelineScan(): TimelineScan {
  return { toolUses: new Map(), workItems: new Map(), itemsScanned: 0 };
}

// Only the fields we read, validated at the boundary; everything else passes.
const commandItemSchema = z.object({
  type: z.literal("commandExecution"),
  command: z.string(),
  exitCode: z.number().nullable().optional(),
  aggregatedOutput: z.string().nullable().optional(),
});
const toolCallItemSchema = z.object({
  type: z.literal("toolCall"),
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  status: z.string().optional(),
});

const GITHUB_PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const GITHUB_ISSUE_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;
const LINEAR_ISSUE_URL = /https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[\w.-]*)?/g;
const LINEAR_IDENTIFIER = /"identifier"\s*:\s*"([A-Z][A-Z0-9]*-\d+)"/;

/** Feed one `item/completed` payload's `item`. Unknown shapes are ignored. */
export function scanItem(scan: TimelineScan, item: unknown): void {
  scan.itemsScanned += 1;
  const command = commandItemSchema.safeParse(item);
  if (command.success) {
    scanCommand(scan, command.data);
    return;
  }
  const toolCall = toolCallItemSchema.safeParse(item);
  if (toolCall.success) scanToolCall(scan, toolCall.data);
}

function scanCommand(scan: TimelineScan, item: z.infer<typeof commandItemSchema>): void {
  // A failed command opened nothing. Codex reports null while unknown.
  if (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0) return;
  const output = item.aggregatedOutput ?? "";
  for (const segment of item.command.split(/&&|\|\||;|\n/)) {
    const gh = /\bgh\s+(pr|issue)\s+(create|merge|close)\b(.*)/.exec(segment);
    if (gh === null) continue;
    const kind: WorkItemKind = gh[1] === "pr" ? "pullRequest" : "issue";
    const action = verbToAction(gh[2] ?? "");
    if (action === "opened") {
      // `gh pr create` prints the new URL; nothing else identifies it.
      addUrls(scan, kind === "pullRequest" ? GITHUB_PR_URL : GITHUB_ISSUE_URL, output, kind, action);
    } else {
      addReferencedGithubItem(scan, kind, action, gh[3] ?? "");
    }
  }
}

function scanToolCall(scan: TimelineScan, item: z.infer<typeof toolCallItemSchema>): void {
  const key = `${item.server}\u0000${item.tool}`;
  const use = scan.toolUses.get(key) ?? { server: item.server, tool: item.tool, calls: 0 };
  use.calls += 1;
  scan.toolUses.set(key, use);

  if (item.status !== undefined && item.status !== "completed") return;
  const tool = item.tool.toLowerCase();
  const result = stringify(item.result);
  const args = isRecord(item.arguments) ? item.arguments : {};

  if (/(create|open)_?pull_?request|create_pr\b/.test(tool)) {
    addUrls(scan, GITHUB_PR_URL, result, "pullRequest", "opened");
  } else if (/merge_?pull_?request/.test(tool)) {
    addUrls(scan, GITHUB_PR_URL, result, "pullRequest", "merged");
  } else if (/create_?issue|save_?issue|issue_?write/.test(tool)) {
    // Linear save_issue and GitHub issue_write both update when given an id.
    const updating = args.id !== undefined || args.issue_number !== undefined || args.method === "update";
    if (updating) return;
    addUrls(scan, GITHUB_ISSUE_URL, result, "issue", "opened");
    const before = scan.workItems.size;
    addUrls(scan, LINEAR_ISSUE_URL, result, "issue", "opened");
    if (scan.workItems.size === before) {
      const identifier = LINEAR_IDENTIFIER.exec(result)?.[1];
      if (identifier !== undefined) {
        addWorkItem(scan, { kind: "issue", action: "opened", source: "linear", label: identifier, url: null });
      }
    }
  }
}

function addUrls(
  scan: TimelineScan,
  pattern: RegExp,
  text: string,
  kind: WorkItemKind,
  action: WorkItemAction,
): void {
  for (const match of text.matchAll(pattern)) {
    const linear = pattern === LINEAR_ISSUE_URL;
    addWorkItem(scan, {
      kind,
      action,
      source: linear ? "linear" : "github",
      label: linear ? (match[1] ?? match[0]) : `${match[1]}#${match[2]}`,
      url: match[0],
    });
  }
}

/** `gh pr merge 12`, `gh issue close https://github.com/o/r/issues/3`. */
function addReferencedGithubItem(
  scan: TimelineScan,
  kind: WorkItemKind,
  action: WorkItemAction,
  rest: string,
): void {
  const url = (kind === "pullRequest" ? GITHUB_PR_URL : GITHUB_ISSUE_URL).source;
  const byUrl = new RegExp(url).exec(rest);
  if (byUrl !== null) {
    addWorkItem(scan, { kind, action, source: "github", label: `${byUrl[1]}#${byUrl[2]}`, url: byUrl[0] });
    return;
  }
  const number = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(rest)?.[1];
  // Bare `gh pr merge` acts on the current branch's PR, which the summary
  // already shows from the GitHub PR Status plugin.
  if (number !== undefined) {
    addWorkItem(scan, { kind, action, source: "github", label: `#${number}`, url: null });
  }
}

function addWorkItem(scan: TimelineScan, item: WorkItem): void {
  const key = `${item.kind}:${item.action}:${item.label}`;
  const existing = scan.workItems.get(key);
  if (existing === undefined || (existing.url === null && item.url !== null)) {
    scan.workItems.set(key, item);
  }
}

function verbToAction(verb: string): WorkItemAction {
  if (verb === "merge") return "merged";
  if (verb === "close") return "closed";
  return "opened";
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
