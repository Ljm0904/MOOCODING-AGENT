# Changelog

## 0.1.0
- Agent loop with streaming tool use, parallel read-only tools, interrupt, auto-compaction.
- Anthropic and OpenAI-compatible providers behind one message format.
- Tools: read/edit/write file, bash, glob, grep, todo, read-only `task` sub-agent.
- Permission modes: default, auto-edit, yolo, plan.
- Checkpoints & rewind via a shadow git repository (`/checkpoints`, `/rewind`, `/diff`).
- `parallel_tasks`: sub-agents in isolated git worktrees, merged back sequentially.
- `/plan`: read-only planning → approval → execution → verification loop with automatic repair.
- MCP client (stdio + streamable HTTP), project config trust prompt.
- Execution trace export to an HTML timeline (`/trace`).
- Streaming markdown rendering, built-in syntax highlighting, animated status line.
- Headless mode: `moo -p`, `--output-format json`, `--verify`.
- First-run setup wizard (`/setup`).
