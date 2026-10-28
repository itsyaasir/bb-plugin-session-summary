// Turns `gh pr view --json` and `gh issue view --json` output into the
// statuses the popover draws. Pure, so it is unit-tested on recorded output.
import { z } from "zod";
import type { Checks, IssueStatus, PullRequestStatus } from "./contract.ts";

export const PR_FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup";
export const ISSUE_FIELDS = "number,title,url,state,stateReason,labels";

// gh reports check runs (`status` + `conclusion`) and commit statuses
// (`state`) in one list.
const rollupEntrySchema = z.object({
  __typename: z.string().optional(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});

const pullRequestJsonSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  headRefName: z.string().nullish(),
  baseRefName: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(rollupEntrySchema).nullish(),
});

const issueJsonSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  stateReason: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
});

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function summarizeChecks(rollup: ReadonlyArray<z.infer<typeof rollupEntrySchema>>): Checks {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const entry of rollup) {
    const isStatusContext = entry.__typename === "StatusContext" || (entry.status == null && entry.state != null);
    if (isStatusContext) {
      const state = (entry.state ?? "").toUpperCase();
      if (state === "SUCCESS") passed += 1;
      else if (state === "FAILURE" || state === "ERROR") failed += 1;
      else pending += 1;
      continue;
    }
    if ((entry.status ?? "").toUpperCase() !== "COMPLETED") {
      pending += 1;
      continue;
    }
    // Success, neutral, skipped, and stale runs do not block the PR.
    if (FAILED_CONCLUSIONS.has((entry.conclusion ?? "").toUpperCase())) failed += 1;
    else passed += 1;
  }
  const total = rollup.length;
  const state = total === 0 ? "none" : failed > 0 ? "failing" : pending > 0 ? "pending" : "passing";
  return { state, passed, failed, pending, total };
}

export function parsePullRequest(json: unknown): PullRequestStatus | null {
  const parsed = pullRequestJsonSchema.safeParse(json);
  if (!parsed.success) return null;
  const pr = parsed.data;
  const state = pr.state.toUpperCase();
  return {
    kind: "pullRequest",
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
    headRef: pr.headRefName || null,
    baseRef: pr.baseRefName || null,
    review: reviewState(pr.reviewDecision),
    checks: summarizeChecks(pr.statusCheckRollup ?? []),
  };
}

export function parseIssue(json: unknown): IssueStatus | null {
  const parsed = issueJsonSchema.safeParse(json);
  if (!parsed.success) return null;
  const issue = parsed.data;
  const open = issue.state.toUpperCase() === "OPEN";
  return {
    kind: "issue",
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: open ? "open" : (issue.stateReason ?? "").toUpperCase() === "NOT_PLANNED" ? "not_planned" : "completed",
    labels: (issue.labels ?? []).map((label) => label.name),
  };
}

function reviewState(decision: string | null | undefined): PullRequestStatus["review"] {
  switch ((decision ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/**
 * The web page of a git remote: `git@github.com:o/r.git`,
 * `ssh://git@host/o/r.git`, and `https://host/o/r.git` all become
 * `https://host/o/r`. Local paths and unknown schemes give null.
 */
export function repositoryWebUrl(remote: string): string | null {
  const trimmed = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.hostname === "") return null;
    host = url.hostname;
    path = url.pathname;
  }
  path = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return path === "" ? null : `https://${host}/${path}`;
}
