# Architecture

```
┌────────────── apps/desktop (Tauri v2) ───────────────┐
│ starts the gateway sidecar, opens a window on its URL │
└───────────────────────┬──────────────────────────────┘
                        │
packages/web (React) ──WebSocket /ws + HTTP /api──> packages/gateway (Bun) ──NDJSON stdio──> omp --mode rpc-ui -e packages/omp-extension
        └──────── packages/protocol (shared types) ────────┘         │                          (unmodified, one per chat; extension adds plan mode)
                                                                     ├─ bun:sqlite: projects, workspaces, layouts, drafts
                                                                     └─ omp CLI (config, skills) and omp's agent/MCP files
```

## Packages

| Path | Role |
|---|---|
| `packages/protocol` | UI ↔ gateway message types. omp commands and frames are typed loosely and passed through. |
| `packages/gateway` | Local server (`Bun.serve`). It manages omp processes, owns product state, serves the web build, and provides project-scoped file reads and terminals. |
| `packages/omp-extension` | Gyre's omp extension (TypeScript loaded by omp with `-e`): plan mode over RPC with Plannotator or Gyre review. |
| `packages/web` | The UI (React 19, Tailwind 4, Radix, cmdk, zustand, shiki, Monaco, xterm.js, mermaid, KaTeX, @xyflow/react). |
| `packages/e2e` | Playwright-driven end-to-end checks against a running gateway and real omp. |
| `apps/desktop` | Tauri shell: sidecar lifecycle, single instance, external links open in the system browser. |
| `scripts/` | `build-desktop.ts` (web, compiled gateway sidecar, `tauri build`) and `bump-omp.ts` (upstream upgrades). |

## Gateway

- **`omp-process.ts`**: a generic driver for `omp --mode rpc-ui`.
  - Reads the ready frame, negotiates protocol v2, and reassembles `rpc_chunk` frames with omp's own exported `RpcFrameDecoder`.
  - Correlates responses by `id`. Every other frame goes to `onFrame`.
  - Closing stdin is omp's clean-shutdown signal.
- **`chats.ts`**: one omp process per chat. The chat id is the pane id, so a page reload re-attaches to the live process.
  - Starts omp with Gyre's extension and per-chat env (`GYRE_PLAN_PREFS`, `PLANNOTATOR_BROWSER=none`, `PLANNOTATOR_INBOX_TOOL=0`).
  - `restart(chatId)` respawns omp on the same session file (MCP and extension changes need a restart).
  - Fans frames out to subscribed sockets.
  - Tracks unanswered dialogs and "sticky" presentation state (status, widgets, the latest command list) and replays them to late subscribers.
  - Reaps idle chats (no subscribers, agent not busy) after 10 minutes.
- **`server.ts`**: HTTP API and WebSocket.
  - Security: binds to 127.0.0.1 by default, requires a per-launch token, and rejects `Host` headers that are not loopback or listed in `GYRE_ALLOWED_HOSTS` (DNS-rebinding guard). The token is injected into the page only for loopback clients or clients holding the HttpOnly login cookie (`POST /api/login`).
  - Endpoints added in v0.2: `/api/omp/config` (allowlisted `omp config` keys), `/api/omp/skills`, `/api/agents`, `/api/mcp`, `/api/chats/:id/{restart,kill,plan-prefs}`, `/api/projects/:id/restart-chats`, `/api/ptys`, `/api/fs/stat`, `/api/kv/ui.*`, `/api/remote`.
  - `PATCH /api/omp/config` edits one `{key, name, value}` assignment in `modelRoles` or `task.agentModelOverrides`; `null` removes it. The gateway serializes config mutations and merges against the latest saved map.
  - Workspace saves compare revisions and return `409` on conflict. Deleted workspace IDs remain tombstoned; a new workspace must use a new ID.
  - File access is confined to the project root after `realpath` (no `..` or symlink escapes).
- **`sessions.ts`**: the single in-process omp API use (`SessionManager.list`), because RPC has no session-listing command. It is lazily imported and isolated.
- **`pty.ts`**: terminals via Bun's native PTY (`Bun.spawn({ terminal })`). Shells are keyed by pane id and outlive their UI: detach on unmount, reattach with scrollback replay (at the size it was produced), kill only on close.
- **`omp-cli.ts`**: runs `omp config|skill|agents` for settings omp has no RPC command for.
- **`studio.ts`**: reads and writes omp agent files and `mcp.json` (validated names, fixed locations).

### Wire protocol (UI ↔ gateway)

- **Client → gateway:**
  - `hello{token}`
  - `open_chat{projectId, chatId?, sessionPath?}`
  - `rpc{chatId, command}`, which forwards **any** omp command
  - `ui_response{chatId, response}`
  - `subscribe`, `close_chat`
  - `pty_open{reqId, key?}`, `pty_input`, `pty_resize`, `pty_detach{ptyId, attachmentId}`, `pty_close`, `pty_close_key{projectId, key}`. The open result's attachment ID is that open request's `reqId`, and a detach only releases the attachment whose ID it names. A delayed detach therefore cannot release a newer attachment on the same socket, provided the client never reuses a `reqId` on that socket; the gateway does not enforce unique IDs.
- **Gateway → client:**
  - `welcome`
  - `result{reqId, ok, data|error, code}`
  - `chat{ChatInfo}`, sent on every lifecycle change
  - `frame{chatId, frame}`, every omp frame unchanged
  - `pty_data`, `pty_exit`

## Web UI state

- **`store/chats.ts`** folds omp frames into a per-chat state: transcript items, tool executions, tool results, pending dialogs, statuses, widgets, commands, queue, sub-agents, and a raw frame ring buffer.
  - Unknown frames still land in the raw log (Events pane).
  - Unknown message roles render as collapsible generic cards.
  - Unknown tools use the generic tool renderer.
- **`store/app.ts`** holds projects, workspaces and the window manager: pane specs, the split-tree layout, hidden and floating panes and focus recency (saved to the gateway after a short debounce), plus the fit pass that auto-hides and restores panes, theme, keyboard/jump modes and overlays.
- Plan mode state comes from the extension's `gyre.plan` widget (`ChatState.plan`); a store subscription opens the Plan pane when a plan is submitted.

## Desktop

1. `scripts/build-desktop.ts` builds the web UI and compiles the gateway with `bun build --compile`.
2. It places the binary as the Tauri sidecar `binaries/gyre-gateway-<triple>`. The web build ships as the `web/` resource and the omp extension as `omp-extension/` (passed to the gateway as `GYRE_OMP_EXTENSION`).
3. At launch the shell starts the sidecar with `GYRE_PORT=0` and `GYRE_EXIT_ON_STDIN_CLOSE=1`, reads `GYRE_READY {url, token}`, and opens `url/#token=…`.
4. On exit it closes the sidecar's stdin. The gateway then stops its omp children and exits; it is killed after 6 s if it doesn't.

omp is **not** bundled. The gateway finds it on `PATH`, at `OMP_PATH`, or in common install locations (`~/.bun/bin`, `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`).

## Tracking omp upstream

Gyre's goal is to get every omp feature (tools, slash commands, skills, MCP, sessions) without maintaining a fork. The rules below keep upgrades cheap.

### Rules

1. **Never fork or patch omp.** Gyre runs the user's installed `omp` binary unmodified, in `--mode rpc-ui`.
2. **Pin and match.** `packages/gateway/package.json` and `packages/omp-extension/package.json` pin `@oh-my-pi/pi-coding-agent` to an exact version. It should match the installed `omp --version`; `scripts/bump-omp.ts` updates both and checks this.
3. **Customize through omp's extension points.** Use extensions, custom tools, hooks, skills and MCP. If Gyre needs new behaviour from omp, propose it upstream rather than patching it locally. Gyre's one extension (`packages/omp-extension`, loaded with `omp -e`) adds plan mode over RPC; see below.
7. **Write omp settings through omp.** Settings changes go through `omp config set` (validated by omp's registry, picked up live by its config watcher), and only allowlisted keys (`omp-cli.ts`). File-backed config that omp has no command for (agent `.md` files, `mcp.json`) is edited in omp's documented locations and formats.
4. **Pass through, don't reinterpret.**
   - The gateway forwards any command and any frame.
   - The UI renders unknown tools generically, shows unknown message roles as collapsible cards, and logs every frame in the Events pane.
   - New upstream tools, commands and events therefore appear without Gyre changes.
5. **Discover rather than hard-code.**
   - Slash commands come from `get_available_commands` and `available_commands_update`.
   - Models come from `get_model_picker`, and thinking levels from `get_state.thinkingLevels`.
   - Login providers come from `get_login_providers`.
6. **Only filter events for performance.** If `set_event_filter` is ever used, the Events pane must still be able to show everything.

### Coupling points (what can break on upgrade)

| Coupling | Where | Guarded by |
|---|---|---|
| RPC framing (ready frame, v2 negotiation, `rpc_chunk`) | `omp-process.ts` uses omp's exported `RpcFrameDecoder` | `test/contract.test.ts`, `test/gateway.test.ts` |
| `get_state` / `get_session_stats` field names | `StatusBar.tsx`, `store/chats.ts` | contract test asserts the fields exist |
| `get_available_commands`, `get_model_picker` shapes | Composer, palette, model picker | contract tests |
| Local slash commands (`agentInvoked: false` plus `command_output`) | Composer | contract test |
| `extension_ui_request` methods and response shapes | `DialogCard.tsx` | e2e (`/pick-color`, `/confirm-demo` via a demo extension) |
| Session listing (in-process `SessionManager.list`, deep import `@oh-my-pi/pi-coding-agent/session/session-manager`) | `sessions.ts` | contract test. The import is isolated in one file; replace it if omp adds an RPC command for listing sessions. |
| Compile-time external `omp-legacy-pi-modules` | gateway `build` script | `bun run build` fails loudly if more virtual modules appear |
| Tool `details` shapes (`edit` diff, `bash` exitCode, `todo` phases) | `tools/registry.tsx`, `store/chats.ts` | renderers fall back to text/JSON on unknown shapes |
| Extension API used by plan mode: `registerCommand`, `registerTool`, `setActiveTools`, `on("context"/"tool_call"/"agent_end")`, `ctx.models.resolve("@role")`, `pi.setModel`, `ctx.compact`, command-context `newSession`, `ui.setWidget` | `packages/omp-extension/src/index.ts` | extension unit tests (mocked API), contract test (`-e` loads it, `/plan` publishes state without a model call) |
| omp's native plan prompts (`plan-mode-active.md`, `plan-mode-approved.md`), adapted in `omp-extension/src/prompts.ts` | extension | contract test checks the native template still exists; review the diff when bumping |
| Plannotator's public bus API (`plannotator:request` `plan-review`, `session-opened`, `review-result`, `session-closed`) | extension | extension unit tests; optional at runtime (Gyre's own review card is the fallback) |
| `omp config get/set --json` output, `omp config path`, `omp skill list --json`, `omp agents unpack --dir` | `omp-cli.ts` | contract test (config, agent dir) |
| Sub-agent frames (`subagent_lifecycle`/`progress` payloads, `get_subagent_messages`) | `store/chats.ts`, `SubagentCard`, `SubagentPane` | UI degrades to the plain task card |
| omp agent and MCP file formats/locations | `studio.ts` | gateway unit tests |

### Plan mode and upstream

omp's built-in plan mode is TUI/ACP-only today (no RPC command, state or approval frame). Gyre's extension reimplements the workflow with the public extension API. If omp adds plan mode to its RPC protocol (a `set_plan_mode`-style command, plan state in `get_state` and an approval UI request, as its ACP mode already has), switch the UI to the native protocol and retire the extension; the `gyre.plan` widget is the only contract between the extension and the UI.

### Upgrade procedure

```bash
omp update                      # or reinstall omp at the new version
bun scripts/bump-omp.ts         # pins gateway + extension to the installed version, runs typecheck, extension tests, gateway tests + contract
bun packages/e2e/run.ts   # optional UI check (see packages/e2e/run.ts header)
```

CI (`.github/workflows/ci.yml`) runs the suite against both the pinned version and the latest omp release every day. Upstream drift shows up as a red "latest" job before users hit it.

### Plan mode shell policy

Gyre simulates omp’s native plan workflow over RPC without modifying omp. Planning and review prompts prohibit state-changing shell commands; the shell remains available, and its denylist is a best-effort guard rather than a sandbox. Dedicated file-tool writes are restricted to session-local plan artifacts. Approval checks the submitted content, applies the selected execution role and fresh/compact/keep context choice, and preserves the approved plan in a fresh session’s local artifacts.
