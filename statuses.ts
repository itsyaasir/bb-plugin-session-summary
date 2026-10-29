// Live GitHub status for the PRs and issues a thread touched. Each read asks
// the host entry (which runs `gh` on the thread's machine) only for items whose
// cached status is missing or stale, so an open popover costs little.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { workItemKey, type ItemStatusRow, type ItemStatuses } from "./contract.ts";
import { readThreadPlace, type TimelineCache } from "./summary.ts";

export type GithubItemsCall = (
  hostId: string,
  input: { cwd: string | null; items: Array<{ key: string; kind: "pullRequest" | "issue"; ref: string }> },
) => Promise<ItemStatuses>;

const MAX_ITEMS = 60;
const MAX_CACHED = 500;

/** How long a status stays fresh: settled items rarely change, running checks do. */
export function statusTtlMs(row: ItemStatusRow): number {
  if (row.outcome === "unavailable") return 60_000;
  const status = row.status;
  if (status.kind === "pullRequest") {
    if (status.state === "merged" || status.state === "closed") return 60 * 60_000;
    return status.checks.state === "pending" ? 20_000 : 2 * 60_000;
  }
  return status.state === "open" ? 5 * 60_000 : 60 * 60_000;
}

export class WorkItemStatuses {
  private readonly cache = new Map<string, { row: ItemStatusRow; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<ItemStatuses>>();
  private readonly sdk: PluginBbSdk;
  private readonly timeline: TimelineCache;
  private readonly callHost: GithubItemsCall;

  constructor(sdk: PluginBbSdk, timeline: TimelineCache, callHost: GithubItemsCall) {
    this.sdk = sdk;
    this.timeline = timeline;
    this.callHost = callHost;
  }

  read(threadId: string): Promise<ItemStatuses> {
    // Concurrent reads of one thread share a fetch instead of racing `gh`.
    const existing = this.inFlight.get(threadId);
    if (existing !== undefined) return existing;
    const next = this.load(threadId).finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, next);
    return next;
  }

  private async load(threadId: string): Promise<ItemStatuses> {
    const [{ environment }, scan] = await Promise.all([readThreadPlace(this.sdk, threadId), this.timeline.read(threadId)]);
    if (environment === null) return {};
    const hostId = environment.hostId;
    const cwd = environment.path ?? null;

    const wanted = new Map<string, { key: string; kind: "pullRequest" | "issue"; ref: string }>();
    for (const item of scan.workItems.values()) {
      // Linear has no `gh`; its issues keep the action the timeline recorded.
      if (item.source !== "github" || wanted.size >= MAX_ITEMS) continue;
      const key = workItemKey(item);
      if (wanted.has(key)) continue;
      wanted.set(key, { key, kind: item.kind, ref: item.url ?? item.label.replace(/^#/, "") });
    }

    const now = Date.now();
    const rows: ItemStatuses = {};
    const stale: Array<{ key: string; kind: "pullRequest" | "issue"; ref: string }> = [];
    for (const item of wanted.values()) {
      const cached = this.cache.get(this.cacheKey(hostId, cwd, item.key));
      if (cached !== undefined) rows[item.key] = cached.row;
      if (cached === undefined || cached.expiresAt <= now) stale.push(item);
    }
    if (stale.length === 0) return rows;

    let fetched: ItemStatuses;
    try {
      fetched = await this.callHost(hostId, { cwd, items: stale });
    } catch (error) {
      // Machine asleep or offline: keep what we had, mark the rest.
      const message = `Could not reach the thread's machine: ${error instanceof Error ? error.message : String(error)}`;
      for (const item of stale) rows[item.key] ??= { outcome: "unavailable", message };
      return rows;
    }
    for (const [key, row] of Object.entries(fetched)) {
      rows[key] = row;
      this.remember(this.cacheKey(hostId, cwd, key), row);
    }
    return rows;
  }

  private cacheKey(hostId: string, cwd: string | null, key: string): string {
    return `${hostId}\u0000${cwd ?? ""}\u0000${key}`;
  }

  private remember(key: string, row: ItemStatusRow): void {
    this.cache.delete(key);
    this.cache.set(key, { row, expiresAt: Date.now() + statusTtlMs(row) });
    while (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
