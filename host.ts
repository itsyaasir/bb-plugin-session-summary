// Session Summary — host entry. Runs on the thread's machine so `gh` uses that
// machine's GitHub login, and lsof sees the servers the thread started there.
import { execFile } from "node:child_process";
import { open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, NO_DETAILS, type ItemStatusRow, type ItemStatuses, type ThreadPort } from "./contract.ts";
import { ISSUE_FIELDS, parseIssue, parsePullRequest, PR_FIELDS } from "./github.ts";
import { finishPorts, isInside, type ScannedPort, parseCwds, parseDockerRows, parseLabels, parseListeners } from "./ports.ts";
import { readTranscriptDetails } from "./transcript.ts";

/** The platform's "show this folder" command. */
const REVEAL_COMMAND: Record<string, string> = { darwin: "open", win32: "explorer" };
const CONCURRENCY = 4;
const GH_TIMEOUT_MS = 20_000;
const EXEC_TIMEOUT_MS = 10_000;
/**
 * A long subagent's transcript can run to hundreds of MB. Its head holds the
 * prompt; its tail the latest model and effort.
 */
const TRANSCRIPT_WHOLE_BYTES = 512 * 1024;
const TRANSCRIPT_END_BYTES = 256 * 1024;

type ExecResult = { ok: true; stdout: string } | { ok: false; message: string; stdout: string };

/** Run a command; a failure becomes a one-line message instead of a throw. */
function exec(
  command: string,
  args: string[],
  { cwd = null, signal, timeoutMs = EXEC_TIMEOUT_MS, env }: { cwd?: string | null; signal: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...(cwd === null ? {} : { cwd }), signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env === undefined ? {} : { env }) },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT" && cwd !== null && error.message.includes(cwd)
            ? "The thread's folder no longer exists."
            : code === "ENOENT"
              ? `${command} is not installed on this machine.`
              : (stderr.trim().split("\n")[0] ?? "") || error.message;
        resolve({ ok: false, message, stdout });
      },
    );
  });
}

const gh = (args: string[], cwd: string | null, signal: AbortSignal) =>
  exec("gh", args, { cwd, signal, timeoutMs: GH_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });

async function readItem(
  item: { kind: "pullRequest" | "issue"; ref: string },
  cwd: string | null,
  signal: AbortSignal,
): Promise<ItemStatusRow> {
  const args =
    item.kind === "pullRequest"
      ? ["pr", "view", item.ref, "--json", PR_FIELDS]
      : ["issue", "view", item.ref, "--json", ISSUE_FIELDS];
  const result = await gh(args, cwd, signal);
  if (!result.ok) return { outcome: "unavailable", message: result.message };
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { outcome: "unavailable", message: "gh returned output that is not JSON." };
  }
  const status = item.kind === "pullRequest" ? parsePullRequest(json) : parseIssue(json);
  return status === null
    ? { outcome: "unavailable", message: "gh returned an unexpected shape." }
    : { outcome: "available", status };
}

/**
 * Listening processes whose working folder is inside `folders`. lsof exits 1
 * when any one file is unreadable, so its output counts even from a failure.
 */
async function processPorts(folders: string[], signal: AbortSignal): Promise<ScannedPort[]> {
  const listeners = parseListeners((await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { signal })).stdout);
  const pids = [...new Set(listeners.map((listener) => listener.pid))];
  if (pids.length === 0) return [];
  let cwds: Map<number, string>;
  if (process.platform === "linux") {
    cwds = new Map();
    await Promise.all(
      pids.map(async (pid) => {
        // Gone since the first pass, or another user's process.
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd !== null) cwds.set(pid, cwd);
      }),
    );
  } else {
    cwds = parseCwds((await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], { signal })).stdout);
  }
  return listeners.flatMap((listener) => {
    const cwd = cwds.get(listener.pid);
    if (cwd === undefined || !folders.some((folder) => isInside(cwd, folder))) return [];
    return [{ ...listener, source: "process" as const, container: null, service: null }];
  });
}

/** Published ports of Compose containers whose project folder is inside `folders`. */
async function dockerPorts(folders: string[], signal: AbortSignal): Promise<ScannedPort[]> {
  const format = '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}';
  const result = await exec("docker", ["ps", "--format", format], { signal });
  if (!result.ok) return [];
  return parseDockerRows(result.stdout)
    .filter((row) => folders.some((folder) => isInside(row.workingDir, folder)))
    .flatMap((row) =>
      row.ports.map(({ port, address }) => ({
        port,
        address,
        pid: 0,
        process: "docker",
        source: "docker" as const,
        container: row.name,
        service: row.service,
      })),
    );
}

async function scanPorts(path: string, signal: AbortSignal): Promise<{ ports: ThreadPort[] }> {
  if (process.platform !== "darwin" && process.platform !== "linux") return { ports: [] };
  // lsof reports resolved paths: /tmp is /private/tmp on macOS.
  const folders = [...new Set([path, await realpath(path).catch(() => path)])];
  const [processes, docker, labels] = await Promise.all([
    processPorts(folders, signal),
    dockerPorts(folders, signal),
    readFile(join(path, ".bb", "ports.json"), "utf8").then(parseLabels, () => new Map()),
  ]);
  return { ports: finishPorts([...processes, ...docker], labels) };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    github_items: async ({ cwd, items }, context) => {
      const rows: ItemStatuses = {};
      let next = 0;
      const worker = async () => {
        while (next < items.length && !context.signal.aborted) {
          const item = items[next++]!;
          rows[item.key] = await readItem(item, cwd, context.signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
      return rows;
    },
    reveal: async ({ path }, context) => {
      const result = await exec(REVEAL_COMMAND[process.platform] ?? "xdg-open", [path], { signal: context.signal });
      // explorer exits 1 even when it opened the folder.
      if (!result.ok && process.platform !== "win32") throw new Error(result.message);
      return null;
    },
    ports: ({ path }, context) => scanPorts(path, context.signal),
    transcript_details: async ({ providerId, path, agentId, sessionId, childRef, folder }) => {
      const file = path ?? (await findTranscript(providerId, folder, sessionId, agentId, childRef));
      if (file === null) return NO_DETAILS;
      const { head, tail } = await readEnds(file, TRANSCRIPT_WHOLE_BYTES, TRANSCRIPT_END_BYTES);
      const fromHead = readTranscriptDetails(head, childRef, false);
      if (tail === null) return fromHead;
      // The tail starts after a Codex child's copy of its parent's context.
      const fromTail = readTranscriptDetails(tail, childRef, true);
      return { model: fromTail.model ?? fromHead.model, effort: fromTail.effort ?? fromHead.effort, prompt: fromHead.prompt };
    },
    stop_port: async ({ path, port }, context) => {
      const target = (await scanPorts(path, context.signal)).ports.find((row) => row.port === port);
      if (target === undefined) throw new Error(`Nothing from this folder is listening on ${port}.`);
      if (target.source === "docker") {
        const result = await exec("docker", ["stop", target.container!], { signal: context.signal, timeoutMs: 30_000 });
        if (!result.ok) throw new Error(result.message);
        return { detail: `Stopped container ${target.container}.` };
      }
      process.kill(target.pid, "SIGTERM");
      return { detail: `Stopped ${target.process} (pid ${target.pid}).` };
    },
  },
});

/**
 * A running subagent's transcript. Claude Code keeps it at
 * `projects/<folder>/<session>/subagents/agent-<id>.jsonl`, with a `.meta.json`
 * naming the tool call that started it; Codex keeps a child session at
 * `sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl`.
 */
async function findTranscript(
  providerId: string,
  folder: string,
  sessionId: string | null,
  agentId: string | null,
  childRef: string | null,
): Promise<string | null> {
  if (providerId === "codex") return childRef === null ? null : findCodexRollout(childRef);
  if (providerId !== "claude-code" || sessionId === null) return null;
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const subagents = join(config, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), sessionId, "subagents");
  if (agentId !== null) return join(subagents, `agent-${agentId}.jsonl`);
  if (childRef === null) return null;
  for (const name of await readdir(subagents).catch(() => [])) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = await readFile(join(subagents, name), "utf8").catch(() => "");
    if (meta.includes(`"toolUseId":"${childRef}"`)) return join(subagents, name.replace(/\.meta\.json$/, ".jsonl"));
  }
  return null;
}

/** A Codex session id is a UUIDv7, so its first 48 bits give the day folder (local time) it was written in. */
async function findCodexRollout(id: string): Promise<string | null> {
  const ms = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  const sessions = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  // The day before and after cover a clock or time-zone change.
  for (const offset of [0, -1, 1]) {
    const day = new Date(ms + offset * 86_400_000);
    const dir = join(sessions, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    const name = (await readdir(dir).catch(() => [])).find((file) => file.endsWith(`-${id}.jsonl`));
    if (name !== undefined) return join(dir, name);
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A file up to `whole` bytes as `head`; a larger one as its first and last
 * `end` bytes, cut to whole lines.
 */
async function readEnds(path: string, whole: number, end: number): Promise<{ head: string; tail: string | null }> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const read = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      return buffer.toString("utf8", 0, bytesRead);
    };
    if (size <= whole) return { head: await read(0, size), tail: null };
    const head = await read(0, end);
    const tail = await read(size - end, end);
    return { head: head.slice(0, head.lastIndexOf("\n")), tail: tail.slice(tail.indexOf("\n") + 1) };
  } finally {
    await file.close();
  }
}
