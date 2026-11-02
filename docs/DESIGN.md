# Design notes

Why things are built the way they are. (Useful when reviewing the code, or explaining it.)

## One internal message format
Messages and content blocks use the Anthropic shape (`text`, `tool_use`, `tool_result`). The OpenAI adapter converts on the way out and back in. Adding a provider means one file implementing `complete(req) → {content, stopReason, usage}`; the agent loop, compaction, checkpoints and sub-agents never see wire formats. Streaming is SSE for both; tool-call arguments arrive as JSON fragments and are only parsed when the block closes.

## Agent loop
`stream → collect tool_use → execute → append tool_result → repeat`. Read-only tools in one response run concurrently; if any tool mutates, the batch runs sequentially so permission prompts and side effects stay ordered. Every tool call returns a `tool_result` even on error/denial/abort, which keeps the transcript valid for the next request. Compaction always produces a *single* user message (summary), which is a valid history no matter where in the loop it happens.

## Checkpoints: shadow git instead of copies or the user's repo
Snapshotting with the user's own git would rewrite their index/branches and conflicts with their workflow. File copies are slow and ignore deletions. A *shadow* repository (`GIT_DIR` under `~/.moo/shadow/<hash>`, `GIT_WORK_TREE` = project) gives content-addressed, deduplicated snapshots that respect `.gitignore`, handle deletions (`read-tree --reset -u`), and never touch the user's repo. Each checkpoint also stores the conversation, because compaction makes "message count" an unreliable rewind key. A rewind first snapshots the current state, so rewinding is itself undoable. *Not covered:* side effects outside the work tree, and commits the agent made in the user's real repository.

## Parallel sub-agents: worktrees, sequential merge
Concurrent agents editing one directory corrupt each other. Each worker gets `git worktree add -b moo/<run>/<name>` (own files, own branch, shared object store). Workers run unattended, so writes are confined to their worktree and they auto-approve tools; the *human* gate is approving the `parallel_tasks` call itself. Merging is sequential with `--no-ff`; on conflict the merge is aborted and the branch + worktree are kept for the user rather than guessing a resolution. *Known gap:* worker `bash` is not sandboxed.

## Plan → verify loop
Plan mode swaps the tool set (read-only + `submit_plan`) *and* the permission mode, so the restriction is enforced in code, not just by prompt. After execution, verify commands come from the plan or are auto-detected from the project (`package.json` scripts, `go.mod`, `Cargo.toml`, pytest config). A failure's tail output goes back to the agent for up to three repair rounds; the final report is derived from the checkpoint diff, not from the model's own claims.

## MCP trust
A project `.mcp.json` is code execution from a repository the user may have just cloned. MOO keys trust on a hash of `(cwd, servers)`, asks once, and re-asks when the config changes. User-level config is trusted implicitly. Tools without `readOnlyHint` go through normal permission prompts.

## Terminal rendering
Markdown is rendered per completed line with a tiny state machine (fence state, highlighter state), so it works on arbitrary stream chunking. Syntax highlighting is a dependency-free, line-based tokenizer: approximate by design, with state only for block comments and triple-quoted strings. The animated status line is a process-wide singleton; every UI write erases it first, and it only draws when the cursor is at column 0.

## Testing approach
No network or API key: tests run the real agent against a scripted OpenAI-compatible server (streamed SSE including split tool-call arguments), spawn the real CLI for headless mode, drive a stdio MCP server fixture, and use real temporary git repositories for checkpoints and worktrees. This caught real bugs during development (e.g. token counters being string-concatenated in traces).
