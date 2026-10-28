import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIssue, parsePullRequest, repositoryWebUrl, summarizeChecks } from "../github.ts";
import { statusTtlMs } from "../statuses.ts";

const prJson = {
  number: 310,
  title: "Add receipts",
  url: "https://github.com/acme/pos/pull/310",
  state: "OPEN",
  isDraft: false,
  headRefName: "receipts",
  baseRefName: "main",
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "StatusContext", state: "SUCCESS" },
  ],
};

test("checks: any failure wins, then anything still running", () => {
  assert.equal(summarizeChecks([]).state, "none");
  assert.deepEqual(
    summarizeChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", state: "ERROR" },
    ]),
    { state: "failing", passed: 1, failed: 2, pending: 1, total: 4 },
  );
  assert.equal(summarizeChecks([{ status: "QUEUED" }, { state: "PENDING" }]).state, "pending");
  assert.equal(summarizeChecks(prJson.statusCheckRollup).state, "passing");
});

test("a PR's state, review, and branches come from gh's JSON", () => {
  assert.deepEqual(parsePullRequest(prJson), {
    kind: "pullRequest",
    number: 310,
    title: "Add receipts",
    url: "https://github.com/acme/pos/pull/310",
    state: "open",
    headRef: "receipts",
    baseRef: "main",
    review: "review_required",
    checks: { state: "passing", passed: 3, failed: 0, pending: 0, total: 3 },
  });
  assert.equal(parsePullRequest({ ...prJson, isDraft: true })?.state, "draft");
  // A merged draft is merged.
  assert.equal(parsePullRequest({ ...prJson, state: "MERGED", isDraft: true })?.state, "merged");
  assert.equal(parsePullRequest({ ...prJson, state: "CLOSED" })?.state, "closed");
  assert.equal(parsePullRequest({ ...prJson, statusCheckRollup: null })?.checks.state, "none");
  assert.equal(parsePullRequest({ title: "no number" }), null);
});

test("an issue closes as completed or not planned", () => {
  const issue = {
    number: 306,
    title: "Crash on refund",
    url: "https://github.com/acme/pos/issues/306",
    state: "OPEN",
    stateReason: null,
    labels: [{ name: "bug" }],
  };
  assert.deepEqual(parseIssue(issue), {
    kind: "issue",
    number: 306,
    title: "Crash on refund",
    url: "https://github.com/acme/pos/issues/306",
    state: "open",
    labels: ["bug"],
  });
  assert.equal(parseIssue({ ...issue, state: "CLOSED", stateReason: "COMPLETED" })?.state, "completed");
  assert.equal(parseIssue({ ...issue, state: "CLOSED", stateReason: "NOT_PLANNED" })?.state, "not_planned");
  assert.equal(parseIssue({ ...issue, state: "CLOSED", stateReason: null })?.state, "completed");
});

test("running checks are looked at again sooner than settled items", () => {
  const open = parsePullRequest(prJson)!;
  const running = { ...open, checks: { ...open.checks, state: "pending" as const } };
  const merged = { ...open, state: "merged" as const };
  const ttl = (status: typeof open) => statusTtlMs({ outcome: "available", status });
  assert.ok(ttl(running) < ttl(open));
  assert.ok(ttl(open) < ttl(merged));
  assert.equal(statusTtlMs({ outcome: "unavailable", message: "offline" }), 60_000);
});

test("repositoryWebUrl turns remotes into web pages", () => {
  assert.equal(repositoryWebUrl("git@github.com:itsyaasir/bb.git"), "https://github.com/itsyaasir/bb");
  assert.equal(repositoryWebUrl("https://github.com/itsyaasir/bb.git\n"), "https://github.com/itsyaasir/bb");
  assert.equal(repositoryWebUrl("ssh://git@gitlab.com/a/b/c.git"), "https://gitlab.com/a/b/c");
  assert.equal(repositoryWebUrl("/Users/me/repos/bb"), null);
  assert.equal(repositoryWebUrl("file:///Users/me/repos/bb"), null);
});
