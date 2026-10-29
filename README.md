# bb-plugin-session-summary

A thread's environment, context usage by source, MCP connectors, and the PRs
and issues it opened, in a popover from a button in the thread header and
as `bb session-summary`.

## Install

Install it from GitHub (bb builds it during the install):

```sh
bb plugin install git:github.com/itsyaasir/bb-plugin-session-summary
```

Update with `bb plugin update session-summary`, and remove with
`bb plugin remove session-summary`.

## Files

- `contract.ts`: the `session_summary` and `work_item_statuses` RPC
  contracts and the host entry's `github_items` contract, shared by the
  server, the host entry, and the app.
- `summary.ts`: builds the summary from `bb.sdk` (threads, environments,
  hosts, projects, context) and the GitHub PR Status plugin's RPC.
- `timeline.ts`: pure parser over `item/completed` timeline items. It
  infers MCP servers called and PRs and issues opened, merged, or closed.
- `background.ts`: pure parser over `backgroundTask` items, merging each
  task's start, progress, and completion events into one row.
- `transcript.ts`: pure; turns the steps bb records for a subagent (Claude Code or Codex) into its conversation, and reads the model, effort and prompt from the provider's transcript
  into prompt, tool calls, results, and report. The host entry reads the
  file (its last 16 MB); the server only ever passes a task's own output file.
- `host.ts`: the host entry (`bb.host`). It runs on the thread's machine and
  reads each PR's or issue's live state with `gh pr view` / `gh issue view
  --json`, in the environment's folder so a bare `#12` resolves. It also
  opens the folder in the file manager, reads its `origin` remote, and finds
  the folder's running servers (`lsof` and `docker ps`, see `ports.ts`).
- `ports.ts`: pure parsers for `lsof` and `docker ps`, the folder's
  `.bb/ports.json` labels, and which ports are apps, services, or internal.
  Adapted from the MIT [Worktree Ports](https://github.com/to-infinity-labs/bb-plugin-worktree-ports)
  plugin, narrowed to the thread's folder.
- `github.ts`: pure parser of that `gh` JSON (state, checks rollup, review,
  labels), and `repositoryWebUrl` for turning a remote into its web page.
- `statuses.ts`: asks the host entry only for stale items. The cache TTL
  depends on state: 20s while checks run, 2m for open PRs, 1h once merged or
  closed.
- `server.ts`: registers both RPCs, refreshes watched reads on thread and
  environment changes (`experimental_whileWatched` +
  `experimental_invalidate`), and the `bb session-summary` CLI.
- `app.tsx`: the header button and popover
  (`experimental_threadHeaderAction` + `@radix-ui/react-popover`, which the
  host shims). The RPCs are read only while the popover is open. Sections
  fold and reorder (drag the grip, or arrow keys on it); Changes lists
  pull requests then issues, each with a ⋯ menu (open, copy link). The
  folder and branch open small menus: Finder (`reveal_folder` → host
  `reveal`), BB's terminal panel (`terminals.create` + `experimental_openTerminal`),
  copy, and the repository (the project's remote, from `projects.get`). Empty sections
  are hidden. The popover's right edge is
  aligned to the header bar's right end (`alignOffset`, measured on open). The
  header button is a toggle: outside clicks and Escape don't close the
  popover. Order, folds, and whether it was left open are kept in
  `localStorage` under `<plugin id>:layout`.
- `skills/session-summary`: tells agents about the CLI.

## Where the data comes from

| Section | Source |
| --- | --- |
| Machine | `sdk.hosts.get(environment.hostId).name` |
| Folder, project | `sdk.environments.get`, `sdk.projects.get` |
| Branch, HEAD, working tree | `sdk.environments.status` (git environments) |
| Running servers | `lsof` listeners whose working folder is inside the thread's folder, plus Compose containers whose project folder is; labels from `.bb/ports.json` |
| Background tasks | `backgroundTask` items in `item/started` and `item/backgroundTask/*` events; a running task that the thread's `activity` counts no longer include shows as stopped |
| Subagent conversation | bb's `item/completed` events tagged with the delegation's `parentToolCallId`; model, effort and Claude Code's prompt from the provider's transcript (Claude Code `subagents/agent-*.jsonl`, Codex `sessions/…/rollout-*.jsonl`) |
| Lineage | `parentThreadId` and `originKind` from `sdk.threads.get` / `sdk.threads.list`: parents walked up to the root (10 at most), descendants read a level at a time with `{ parentThreadId }`, active and archived (6 levels, 200 threads at most); a later sibling with the same `environmentId` as an earlier one is shown under it; live status and new threads from `experimental_useSidebarThreads` |
| Context | `sdk.threads.context` → `usage`; `usage.snapshot.categories` is Claude Code only |
| Connectors | MCP tool entries in the context snapshot (`server: mcp__server__tool`) + `toolCall` items with a `server` |
| Branch PR | `bb--github-pr-status` RPC `pullRequests` |
| Opened PRs and issues | `commandExecution` (`gh pr/issue create|merge|close`) and MCP tool calls in `sdk.threads.events.list` |
| Their live state, checks, review | `gh` on the thread's machine, through the host entry. Linear issues have none. |

The timeline is scanned incrementally (cached per thread, at most 100 threads,
50 pages of 100 events per read, the server's page cap) and rescanned when history is rewritten.

## Develop

```
npm install
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

## License

MIT. See [LICENSE](LICENSE).
