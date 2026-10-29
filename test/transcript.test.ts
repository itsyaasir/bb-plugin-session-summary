import assert from "node:assert/strict";
import { test } from "node:test";
import { addStep, readTranscriptDetails, stepEntries, subagentConversation, type SubagentSteps } from "../transcript.ts";

// Item shapes recorded from bb timelines of Codex and Claude Code subagents.
test("a command shows its title and output; a failure is an error", () => {
  const entries = stepEntries({
    type: "commandExecution",
    command: "/bin/zsh -lc pwd",
    presentation: { title: "pwd" },
    aggregatedOutput: "/repo\n",
    exitCode: 1,
    status: "completed",
  });
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.tool, entry.text, entry.error]),
    [
      ["tool", "Shell", "pwd", false],
      ["result", "Shell", "/repo\n", true],
    ],
  );
  assert.equal(stepEntries({ type: "commandExecution", command: "true", aggregatedOutput: "", exitCode: 0 }).length, 1);
});

test("a file change gets a hunk header so the diff renders", () => {
  const [write, edit] = stepEntries({
    type: "fileChange",
    changes: [
      { path: "a.ts", kind: "add", diff: "--- /dev/null\n+++ a.ts\n+one\n+two" },
      { path: "b.ts", kind: "update", diff: "--- b.ts\n+++ b.ts\n-old\n+new\n+more" },
    ],
  });
  assert.equal(write?.tool, "Write");
  assert.equal(write?.patch, "@@ -0,0 +1,2 @@\n+one\n+two");
  assert.equal(edit?.tool, "Edit");
  assert.equal(edit?.patch, "@@ -1,1 +1,2 @@\n-old\n+new\n+more");
});

test("a handback is the report; other tool calls show their input and result", () => {
  assert.deepEqual(
    stepEntries({ type: "toolCall", tool: "SubagentHandback", arguments: { message: "All done" } }).map((entry) => entry.kind),
    ["report"],
  );
  const [call, result] = stepEntries({ type: "toolCall", tool: "Grep", arguments: { pattern: "TODO" }, result: "3 matches" });
  assert.equal(call?.text, "TODO");
  assert.equal(result?.text, "3 matches");
  assert.equal(stepEntries({ type: "toolCall", tool: "Skill", arguments: {}, result: {} }).length, 1);
});

test("messages, thinking and reads become entries; reminders do not", () => {
  const steps = new Map<string, SubagentSteps>();
  addStep(steps, "d-1", { type: "reasoning", content: [], summary: ["Look first"] });
  addStep(steps, "d-1", { type: "fileRead", path: "/repo/a.ts" });
  addStep(steps, "d-1", { type: "agentMessage", text: "<system-reminder>x</system-reminder>" });
  addStep(steps, "d-1", { type: "agentMessage", text: "Found it" });
  assert.deepEqual(
    steps.get("d-1")!.entries.map((entry) => [entry.kind, entry.text]),
    [
      ["thinking", "Look first"],
      ["tool", "/repo/a.ts"],
      ["text", "Found it"],
    ],
  );
});

test("old steps are dropped and counted; a finished subagent's last message is its report", () => {
  const steps = new Map<string, SubagentSteps>();
  for (let index = 0; index < 405; index += 1) addStep(steps, "d", { type: "agentMessage", text: `m${index}` });
  const running = subagentConversation(steps.get("d"), "Find the bug", false);
  assert.equal(running.omitted, 5);
  assert.equal(running.entries[0]?.kind, "prompt");
  assert.equal(running.entries[1]?.text, "m5");
  assert.equal(running.entries.at(-1)?.kind, "text");
  assert.equal(subagentConversation(steps.get("d"), null, true).entries.at(-1)?.kind, "report");
  assert.deepEqual(subagentConversation(undefined, null, true), { entries: [], omitted: 0 });
});

test("Claude Code's transcript gives the model, effort and prompt", () => {
  const jsonl = [
    { type: "user", message: { content: "<system-reminder>ctx</system-reminder>" } },
    { type: "user", message: { content: [{ type: "text", text: "Review the plugin" }] } },
    { type: "assistant", effort: "medium", message: { model: "claude-opus-5-5", content: [] } },
    { type: "assistant", message: { model: "<synthetic>", content: [] } },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  assert.deepEqual(readTranscriptDetails(jsonl, "toolu_1", false), {
    model: "claude-opus-5-5",
    effort: "medium",
    prompt: "Review the plugin",
  });
});

test("a Codex child's settings come after its copy of the parent's context", () => {
  const child = "01a185b4-3609-7cb3-b175-0261eadf7146";
  const jsonl = [
    { type: "turn_context", payload: { model: "parent-model", effort: "low" } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: child } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol", collaboration_mode: { settings: { reasoning_effort: "high" } } } },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  assert.deepEqual(readTranscriptDetails(jsonl, child, false), { model: "gpt-6.1-sol", effort: "high", prompt: null });
  // A tail read starts inside the child.
  assert.equal(readTranscriptDetails(jsonl.split("\n")[0]!, child, true).model, "parent-model");
});
