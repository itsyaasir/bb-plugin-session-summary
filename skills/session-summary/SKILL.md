---
name: session-summary
description: Summarize a bb thread's machine, folder, branch, context usage by source, MCP connectors, and the PRs and issues it opened. Use when asked what this session has done, where it runs, which connectors it uses, or how full its context is.
---

# Session summary

Run `bb session-summary` inside a thread to summarize it, or pass another
thread's id: `bb session-summary thr_abc123`. Add `--json` for the full,
machine-readable summary.

It reports:

- **Environment**: machine, project, folder, whether it is a worktree, the
  branch and HEAD, and the working tree's changed files.
- **Context**: tokens used of the window, cost when the provider reports it,
  and for Claude Code the breakdown by source (messages, system prompt, MCP
  tools, skills, memory files, custom agents) with each source's entries.
  Other providers report totals only.
- **Connectors**: MCP servers the provider loaded (Claude Code) and how many
  times this thread called each.
- **Changes**: the branch's pull request (from the GitHub PR Status plugin),
  plus PRs and issues this thread opened, merged, or closed, each with its
  live GitHub state and checks (`[now merged, checks passing]`), read with
  `gh` on the thread's machine. `--json` puts these under `statuses`, keyed
  `pullRequest:<label>` or `issue:<label>`. Linear issues have no live state.

Connectors and opened PRs and issues are inferred from the thread's tool
calls and shell commands (`gh pr create`, `gh issue create`, Linear
`save_issue`, GitHub `create_pull_request`), because bb does not record them
directly. A PR opened outside this thread does not appear unless it is the
branch's PR.

The same summary opens from the Session summary button in the thread header.
