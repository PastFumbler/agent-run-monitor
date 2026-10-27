SYNTHESIZED FROM SOURCE - NOT REAL SESSIONS.
Codex is not installed on the machine these were made on. Every record was hand-built from the serde
definitions in github.com/openai/codex at main 6fe77fc12346591b8037a8704640e40196b19044 (2026-10-27,
just after release rust-v0.164.0) plus older tags where noted. Content is a toy "todo-cli" Python project; the home
directory is C:\Users\alex or /home/alex. IDs are fake but correctly shaped (UUIDv7 thread/turn ids, call_*,
rs_*, msg_*, resp_*). Generator: scratchpad/tools/gen-codex-fixtures.js.

rollout-2026-10-20T16-03-12-019a01f2-...jsonl  current "legacy" history mode (no "ordinal"); 3 turns:
                                               completed (with failing test = tool error, 2 apply_patch edits),
                                               interrupted (turn_aborted), failed (task_complete.error).
rollout-2026-10-22T11-15-00-019a0a11-...jsonl  current "paginated" history mode (ordinal on every line,
                                               item_completed TurnItems, token_usage_record, world_state);
                                               Desktop-app style session_meta. 1 turn.
rollout-2026-04-14T20-40-02-019d1e2f-...jsonl  "extended history" era (~v0.110-v0.130, IDE/app-server):
                                               exec_command_end, mcp_tool_call_end (Err), error events.
rollout-2025-08-21T11-12-40-5973b6c0-...jsonl  pre-envelope era (codex-rs <= rust-v0.31.0): bare SessionMeta
                                               first line, bare ResponseItems, {"record_type":"state"};
                                               local_shell_call. Response-item details partly UNVERIFIED.
codex-corrupt.jsonl                            first 14 records of the legacy fixture + one garbage line +
                                               a blank line + a cut-off final record with no newline.
session_index.jsonl                            CODEX_HOME/session_index.jsonl (thread names, last entry wins).
history.jsonl                                  CODEX_HOME/history.jsonl (prompt history, one line per prompt).

Wall-clock timestamps inside filenames are LOCAL time (UTC+2 in these fixtures); in-record timestamps are UTC.
Exact record ordering inside a turn is approximated from the code paths, not captured from a live run.
