See at a glance where a thread runs, how full its context is, which
connectors it uses, and what it has shipped, from one button in the thread
header.

## What you get

- **Environment**: the branch (when there is one), the machine, the
  project folder, and the working tree's changed files. Click the folder to
  open it in Finder or in a terminal, copy its path, or open its repository;
  click the branch to open a terminal or copy its name.
- **Servers**: what is running from the thread's folder: dev servers, and
  Docker Compose services like Postgres. Each one's ⋯ menu opens it in the
  browser, copies its URL, or stops it. Name a port with a `.bb/ports.json`
  in the folder: `{"ports": [{"port": 3000, "label": "Web"}]}`.
- **Background**: commands, subagents, and workflows the agent started in
  the background. Running ones come first with a live timer; finished ones
  stay listed with their result, duration, tokens, and output file. Expand a
  subagent and choose **View conversation** to read its prompt, tool calls,
  and report in a side-panel tab; it follows along while the subagent runs.
- **Lineage**: the chain of threads above this one up to the root, and every
  thread below it as a tree: children, their children, and so on, each
  branch folding away. A thread that worked in the same folder as an earlier
  sibling (a review of that work) sits under it. bb's live status on each. Click one to open it.
- **Context**: tokens used against the window with a stacked bar, the
  auto-compact point, and for Claude Code the breakdown by source. Expand a
  source to see what fills it: memory file paths, skills, agents, MCP tools.
- **Connectors**: each MCP server the agent loaded, with its tool count and
  how often this thread called it.
- **Changes**, one list of pull requests and issues: the branch's pull request, plus the PRs
  and issues the thread opened, merged, or closed through `gh` or the GitHub
  and Linear connectors. Each shows its live state (open, draft, merged,
  closed) and whether checks pass, fail, or are running. Its ⋯ menu opens it
  on GitHub (or Linear) or copies its link.
- **Only what's there**: a section with nothing in it is left out.
- **Stays open while you work**: the header button toggles the popover (it
  lights up while open), and the popover lines up with the header's right end, so
  clicking elsewhere doesn't close it. Fold any section and drag sections
  into your order; it remembers your layout and whether you left it open.
- A `bb session-summary` command that prints the same summary for agents and
  scripts.

## How it works

Everything is read from bb on your own server: the thread, its environment
and machine, the context usage the provider recorded, and the thread's
timeline. The branch's PR comes from bb's bundled GitHub PR Status plugin. The live
state of other PRs and issues comes from `gh` on the thread's machine, using
the GitHub login already there; without `gh` they show what the thread did
to them. The popover refreshes while it is open, and while checks run it
looks again every 30 seconds. There are no settings or accounts.
