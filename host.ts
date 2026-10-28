// Session Summary — host entry. Runs on the thread's machine so `gh` uses that
// machine's GitHub login, and reads each PR's or issue's live state.
import { execFile } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type ItemStatusRow, type ItemStatuses } from "./contract.ts";
import { ISSUE_FIELDS, parseIssue, parsePullRequest, PR_FIELDS } from "./github.ts";

/** The platform's "show this folder" command. */
const REVEAL_COMMAND: Record<string, string> = { darwin: "open", win32: "explorer" };
const CONCURRENCY = 4;
const GH_TIMEOUT_MS = 20_000;
const EXEC_TIMEOUT_MS = 10_000;

type ExecResult = { ok: true; stdout: string } | { ok: false; message: string };

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
        resolve({ ok: false, message });
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
    origin_url: async ({ path }, context) => {
      const result = await exec("git", ["-C", path, "remote", "get-url", "origin"], { signal: context.signal });
      return { remote: result.ok ? result.stdout.trim() || null : null };
    },
    reveal: async ({ path }, context) => {
      const result = await exec(REVEAL_COMMAND[process.platform] ?? "xdg-open", [path], { signal: context.signal });
      // explorer exits 1 even when it opened the folder.
      if (!result.ok && process.platform !== "win32") throw new Error(result.message);
      return null;
    },
  },
});
