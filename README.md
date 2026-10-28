# bb-plugin-session-summary

A thread's environment, context usage by source, MCP connectors, and the PRs
and issues it opened, in a popover from a button in the thread header and
as `bb session-summary`.

## Files

- `contract.ts`: the `session_summary` and `work_item_statuses` RPC
  contracts and the host entry's `github_items` contract, shared by the
  server, the host entry, and the app.
- `summary.ts`: builds the summary from `bb.sdk` (threads, environments,
  hosts, projects, context) and the GitHub PR Status plugin's RPC.
- `timeline.ts`: pure parser over `item/completed` timeline items. It
  infers MCP servers called and PRs and issues opened, merged, or closed.
- `host.ts`: the host entry (`bb.host`). It runs on the thread's machine and
  reads each PR's or issue's live state with `gh pr view` / `gh issue view
  --json`, in the environment's folder so a bare `#12` resolves. It also
  opens the folder in the file manager and reads its `origin` remote.
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
  copy, and the repository (`repository` → host `origin_url`). Empty sections
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
