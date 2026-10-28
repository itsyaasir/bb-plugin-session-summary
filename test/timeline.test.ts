import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpToolLabel, summarizeConnectors } from "../summary.ts";
import { createTimelineScan, scanItem } from "../timeline.ts";

function command(command: string, aggregatedOutput: string, exitCode: number | null = 0) {
  return { type: "commandExecution", id: "i1", command, cwd: "", status: "completed", aggregatedOutput, exitCode };
}

function toolCall(server: string, tool: string, args: unknown, result: unknown) {
  return { type: "toolCall", id: "i2", server, tool, arguments: args, status: "completed", result };
}

test("gh pr create records the URL it printed", () => {
  const scan = createTimelineScan();
  scanItem(
    scan,
    command(
      'git push -u origin feat && gh pr create --title "Add browser client" --body x',
      "Creating pull request for feat into main\n\nhttps://github.com/yasir/better-daraja/pull/9\n",
    ),
  );
  assert.deepEqual([...scan.workItems.values()], [
    {
      kind: "pullRequest",
      action: "opened",
      source: "github",
      label: "yasir/better-daraja#9",
      url: "https://github.com/yasir/better-daraja/pull/9",
    },
  ]);
});

test("a failed gh command opens nothing", () => {
  const scan = createTimelineScan();
  scanItem(scan, command("gh pr create --fill", "https://github.com/o/r/pull/1", 1));
  assert.equal(scan.workItems.size, 0);
});

test("a PR URL in a read command is not an opened PR", () => {
  const scan = createTimelineScan();
  scanItem(scan, command("gh pr view 3", "https://github.com/o/r/pull/3"));
  assert.equal(scan.workItems.size, 0);
});

test("gh pr merge and gh issue close record what they acted on", () => {
  const scan = createTimelineScan();
  scanItem(scan, command("gh pr merge 12 --squash", "✓ Squashed and merged"));
  scanItem(scan, command("gh issue close https://github.com/o/r/issues/4", ""));
  assert.deepEqual(
    [...scan.workItems.values()].map(({ kind, action, label }) => `${kind} ${action} ${label}`),
    ["pullRequest merged #12", "issue closed o/r#4"],
  );
});

test("Linear save_issue creates an issue only without an id", () => {
  const scan = createTimelineScan();
  scanItem(
    scan,
    toolCall("claude.ai Linear", "save_issue", { title: "Bug", team: "ENG" }, {
      content: [{ type: "text", text: '{"identifier":"ENG-42","url":"https://linear.app/acme/issue/ENG-42/bug"}' }],
    }),
  );
  scanItem(
    scan,
    toolCall("claude.ai Linear", "save_issue", { id: "ENG-7", state: "Done" }, '{"identifier":"ENG-7"}'),
  );
  assert.deepEqual([...scan.workItems.values()], [
    { kind: "issue", action: "opened", source: "linear", label: "ENG-42", url: "https://linear.app/acme/issue/ENG-42/bug" },
  ]);
});

test("Linear identifier without a URL still counts", () => {
  const scan = createTimelineScan();
  scanItem(scan, toolCall("linear", "create_issue", { title: "x" }, '{"identifier":"APP-3"}'));
  assert.deepEqual([...scan.workItems.values()].map((item) => item.label), ["APP-3"]);
});

test("tool calls count per server and match the context breakdown by tool name", () => {
  const scan = createTimelineScan();
  // Claude Code reports the call as server "bb"; the breakdown calls it "bb-bridge".
  scanItem(scan, toolCall("bb", "check_ui", {}, "ok"));
  scanItem(scan, toolCall("bb", "check_ui", {}, "ok"));
  scanItem(scan, toolCall("github", "get_me", {}, "{}"));
  // Built-in tools have no server and are not connectors.
  scanItem(scan, { type: "toolCall", id: "i3", tool: "Skill", arguments: {}, status: "completed", result: "" });

  const categories = [
    {
      id: "mcp-deferred",
      label: "MCP tools (deferred)",
      kind: "deferred" as const,
      tokens: 100,
      entries: [
        { id: "a", label: "bb-bridge: mcp__bb-bridge__check_ui", tokens: 50 },
        { id: "b", label: "bb-bridge: mcp__bb-bridge__ui_examples", tokens: 50 },
        { id: "c", label: "claude.ai Linear: mcp__claude_ai_Linear__list_issues", tokens: 50 },
      ],
    },
    { id: "skills", label: "Skills", kind: "used" as const, tokens: 10, entries: [{ id: "s", label: "bb-cli", tokens: 10 }] },
  ];
  assert.deepEqual(summarizeConnectors(categories, scan), [
    {
      server: "bb-bridge",
      toolCount: 2,
      calls: 2,
      tools: [
        { name: "check_ui", calls: 2 },
        { name: "ui_examples", calls: 0 },
      ],
      moreTools: 0,
    },
    { server: "github", toolCount: null, calls: 1, tools: [{ name: "get_me", calls: 1 }], moreTools: 0 },
    { server: "claude.ai Linear", toolCount: 1, calls: 0, tools: [{ name: "list_issues", calls: 0 }], moreTools: 0 },
  ]);
});

test("parseMcpToolLabel reads qualified and bare names", () => {
  assert.deepEqual(parseMcpToolLabel("yab-browser: mcp__yab-browser__tabs"), { server: "yab-browser", tool: "tabs" });
  assert.deepEqual(parseMcpToolLabel("mcp__linear__get_issue"), { server: "linear", tool: "get_issue" });
  assert.equal(parseMcpToolLabel("bb-cli"), null);
});
