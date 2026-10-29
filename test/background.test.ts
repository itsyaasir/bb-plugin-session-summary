import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundScan, finishBackground, scanBackgroundEvent } from "../background.ts";
import { hasConversation } from "../contract.ts";

// Shapes recorded from a Claude Code thread.
function task(id: string, taskType: string, description: string, fields: Record<string, unknown> = {}) {
  return {
    type: "backgroundTask",
    id,
    familyId: `f-${id}`,
    taskType,
    description,
    status: "pending",
    taskStatus: "running",
    foreground: false,
    parentToolCallId: `call-${id}`,
    ...fields,
  };
}

test("a task's start and completion merge into one finished row", () => {
  const scan = createBackgroundScan();
  scanBackgroundEvent(
    scan,
    { type: "delegation", id: "call-a", label: "Review", status: "pending", presentation: { title: "Review", detail: "Explore agent" } },
    1_000,
  );
  scanBackgroundEvent(scan, task("a", "local_agent", "Review the plugin"), 1_000);
  // Running, it has no output file yet; its steps carry its delegation's id.
  const running = scan.tasks.get("a")!;
  assert.equal(running.outputFile, null);
  assert.equal(hasConversation(running), true);
  scanBackgroundEvent(
    scan,
    task("a", "local_agent", "Review the plugin", {
      status: "completed",
      taskStatus: "completed",
      summary: "Agent finished\nnotes for the agent",
      outputFile: "/tmp/a.output",
      usage: { totalTokens: 48_659, toolUses: 8, durationMs: 37_415 },
    }),
    38_000,
  );
  assert.deepEqual(finishBackground(scan, null, 10).tasks, [
    {
      id: "a",
      kind: "agent",
      title: "Review the plugin",
      detail: "Explore agent",
      state: "completed",
      startedAt: 1_000,
      endedAt: 38_000,
      durationMs: 37_415,
      tokens: 48_659,
      toolUses: 8,
      summary: "Agent finished\nnotes for the agent",
      outputFile: "/tmp/a.output",
      agentId: "f-a",
      childRef: null,
      delegationId: "call-a",
      agents: [],
    },
  ]);
});

test("running tasks come first, oldest first; finished ones latest first", () => {
  const scan = createBackgroundScan();
  scanBackgroundEvent(scan, task("old", "local_bash", "Old server"), 1);
  scanBackgroundEvent(scan, task("old", "local_bash", "Old server", { taskStatus: "failed", status: "failed" }), 2);
  scanBackgroundEvent(scan, task("run1", "local_bash", "Dev server"), 3);
  scanBackgroundEvent(scan, task("done", "local_agent", "Review"), 4);
  scanBackgroundEvent(scan, task("done", "local_agent", "Review", { taskStatus: "completed" }), 9);
  scanBackgroundEvent(scan, task("run2", "local_agent", "Research"), 5);
  scanBackgroundEvent(scan, { type: "commandExecution", id: "x", command: "ls" }, 6);

  const { tasks, more } = finishBackground(scan, new Set(["run1", "run2"]), 3);
  assert.deepEqual(
    tasks.map((row) => [row.id, row.kind, row.state]),
    [
      ["run1", "command", "running"],
      ["run2", "agent", "running"],
      ["done", "agent", "completed"],
    ],
  );
  assert.equal(more, 1);
});

test("a task bb no longer lists as running shows as stopped, even beside a live one of its kind", () => {
  const scan = createBackgroundScan();
  scanBackgroundEvent(scan, task("cmd", "local_bash", "Server"), 1);
  scanBackgroundEvent(scan, task("agent", "local_agent", "Research"), 2);
  scanBackgroundEvent(scan, task("stale", "local_agent", "Lost"), 3);
  const states = finishBackground(scan, new Set(["agent"]), 10).tasks.map((row) => [row.id, row.state]);
  assert.deepEqual(states, [
    ["agent", "running"],
    ["stale", "stopped"],
    ["cmd", "stopped"],
  ]);
});

test("a workflow keeps its name and agents from progress events", () => {
  const scan = createBackgroundScan();
  scanBackgroundEvent(scan, task("wf", "local_workflow", "Review changes", { workflowName: "review-changes" }), 1);
  scanBackgroundEvent(
    scan,
    task("wf", "local_workflow", "Review changes", {
      workflow: { agents: [{ label: "review:bugs", state: "done" }, { label: "review:perf" }], phases: [] },
    }),
    2,
  );
  const [row] = finishBackground(scan, null, 10).tasks;
  assert.equal(row?.kind, "workflow");
  assert.equal(row?.detail, "review-changes");
  assert.deepEqual(row?.agents, [
    { label: "review:bugs", state: "done" },
    { label: "review:perf", state: "unknown" },
  ]);
});

// Shapes recorded from a Codex thread and a Claude Code thread.
test("a delegation the agent waits on is a subagent; one a background task takes over is not", () => {
  const scan = createBackgroundScan();
  const codex = { type: "delegation", id: "d-1", childRef: "01a185b4-3609-7cb3-b175-0261eadf7146", label: "/root/inspect", background: false };
  scanBackgroundEvent(scan, { ...codex, status: "pending" }, 1_000);
  const running = scan.tasks.get("d-1")!;
  assert.equal(running.state, "running");
  assert.equal(running.childRef, codex.childRef);
  assert.equal(hasConversation(running), true);
  // bb lists no background work for it, yet it still runs.
  assert.equal(finishBackground(scan, new Set(), 10).tasks[0]!.state, "running");
  scanBackgroundEvent(scan, { ...codex, status: "completed" }, 9_000);
  assert.equal(scan.tasks.get("d-1")!.durationMs, 8_000);

  const claude = { type: "delegation", id: "d-2", childRef: "toolu_1", label: "Review", background: false };
  scanBackgroundEvent(scan, { ...claude, status: "pending" }, 1_000);
  scanBackgroundEvent(scan, task("b", "local_agent", "Review", { parentToolCallId: "d-2" }), 1_000);
  scanBackgroundEvent(scan, { ...claude, status: "completed", summary: "Async agent launched successfully." }, 2_000);
  assert.deepEqual([...scan.tasks.keys()], ["d-1", "b"]);
});
