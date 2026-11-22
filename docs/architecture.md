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
| `scripts/` | `build-desktop.ts` (desktop bundles), `build-release.ts` (release assets) and `bump-omp.ts` (omp upgrades). |

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
  - Other endpoints include `/api/omp/config` (allowlisted `omp config` keys), `/api/omp/skills`, `/api/agents`, `/api/mcp`, `/api/chats/:id/{restart,kill,plan-prefs}`, `/api/projects/:id/restart-chats`, `/api/ptys`, `/api/fs/stat`, `/api/kv/ui.*`, `/api/remote`.
  - `PATCH /api/omp/config` edits one `{key, name, value}` assignment in `modelRoles` or `task.agentModelOverrides`; `null` removes it. The gateway serializes config mutations and merges against the latest saved map.
  - Workspace saves compare revisions and return `409` on conflict. Deleted workspace IDs remain tombstoned; a new workspace must use a new ID.
  - `/api/kv/ui.*` GET returns an `ETag` (a hash of the stored JSON, or `"absent"`). A PUT with `If-Match` writes only if the record still has that version, atomically in one sqlite transaction, and returns `412` otherwise. Every Agent Studio draft mutation (`web/src/lib/agent-drafts.ts`) uses it: saves and publish cleanup change only their own key, re-read and retry on `412`, and a save never silently replaces a newer draft of the same agent (it reports a conflict instead).
  - File access is confined to the project root after `realpath` (no `..` or symlink escapes).
  - **Folder browser:** `GET /api/fs/browse?path=&hidden=1` lists directories (with a `.git` marker) anywhere the gateway user can read, for the Add Project dialog. It is not project-scoped on purpose. It sits behind the same token as everything else, and a token holder can already open a shell (terminals), so it grants nothing new.
  - **Projects:** `DELETE /api/projects/:id` stops the project's chats and terminals, then removes the row (`404` for unknown ids). Files on disk are untouched. `GET /api/projects/:id/usage` counts running chats and terminals for the confirmation.
  - **omp setup status:** at startup the gateway runs `omp --version` and, in the background, `omp models --json`. `ompStatus` is `missing` (no omp), `no-models` (no provider: omp exits with "No models available" in RPC mode), `ok`, or `unknown` (the check itself failed; chats are allowed). It is reported in `/api/health` and `welcome`. While the status is `missing`/`no-models`, `open_chat` fails fast with code `omp_setup` instead of spawning omp. A chat that exits with "No models available" flips the status back to `no-models`. `POST /api/omp/recheck` re-runs the checks after the user installs omp or adds a provider.
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
4. On exit it closes the sidecar's stdin. The gateway then stops its omp children and exits; it is killed after 10 s if it doesn't.

omp is **not** bundled. Desktop launchers often start apps without the user's shell `PATH`, so the gateway (`omp-path.ts`) looks for omp at `OMP_PATH`, on `PATH`, then in `~/.bun/bin`, `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. omp is a Bun script (`#!/usr/bin/env bun`), so the gateway also puts bun's folder on `PATH` before spawning it.

## Releases and the installer

- `scripts/build-release.ts` builds the web UI once and cross-compiles the gateway (`bun build --compile --target=bun-<os>-<arch>`) for linux/darwin × x64/arm64. Each target becomes `gyre-web-<os>-<arch>.tar.gz` containing `gyre/{gyre-gateway, web/, omp-extension/src/}`, the layout `main.ts` expects next to its binary. It also writes `gyre-manifest.json` (`{version, ompVersion}`, the omp version pinned in `packages/gateway/package.json`), `gyre-icon.png` and `SHA256SUMS`.
- `.github/workflows/release.yml` runs on `v*` tags. It builds the web tarballs and, on ubuntu-22.04, the `.deb` and AppImage (version from the tag) as `gyre-desktop-linux-x64.{deb,AppImage}`, then publishes them with `install.sh` and fresh checksums. Stable asset names let the installer download from `releases/latest/download/<asset>`.
- `install.sh` (repo root) reads answers from `/dev/tty`, so it works under `curl | bash`, and uses flags and recommended defaults without a terminal. It verifies every download against `SHA256SUMS` and installs one version: the web tarball, or the desktop `.deb`/AppImage. Either way `~/.local/bin/gyre` starts it (`gyre-gateway --open`, or the desktop binary in the background). It installs omp with Bun (the manifest's version) and adds bun's folder to its own `PATH`, because omp needs `bun` to run and Bun's installer only edits shell rc files. It only checks for a model provider (`omp models --json`) and points to omp for setup. `GYRE_RELEASE_BASE=file://…` points it at a local `dist/release`.
- The launcher records the installed version, the install folders and the install mode (`--web`, or `--desktop --deb|--appimage`). `gyre update` downloads `install.sh` from `main` (or `GYRE_INSTALLER_URL`, e.g. `file://$PWD/install.sh` for testing) and runs it with those flags plus `--update --from <version>`. In update mode the installer stops when the latest release is already installed, offers to move omp to the manifest's version, never installs omp from scratch and skips Plannotator if it isn't installed. The installer comes from `main` rather than the release so that `gyre update --version` can reach releases whose own `install.sh` has no `--update` flag.

## Tracking omp upstream

Gyre aims to expose every omp feature without maintaining a fork. These rules keep upgrades cheap.

### Rules

1. **Never fork or patch omp.** Gyre runs the user's installed `omp` binary unmodified, in `--mode rpc-ui`.
2. **Pin and match.** `packages/gateway/package.json` and `packages/omp-extension/package.json` pin `@oh-my-pi/pi-coding-agent` to an exact version. It should match the installed `omp --version`; `scripts/bump-omp.ts` updates both and checks this.
3. **Customize through omp's extension points.** Use extensions, custom tools, hooks, skills and MCP. If Gyre needs new behaviour from omp, propose it upstream rather than patching it locally. Gyre's one extension (`packages/omp-extension`, loaded with `omp -e`) adds plan mode over RPC.
4. **Write omp settings through omp.** Settings changes go through `omp config set` (validated by omp's registry, picked up live by its config watcher), and only allowlisted keys (`omp-cli.ts`). File-backed config that omp has no command for (agent `.md` files, `mcp.json`) is edited in omp's documented locations and formats.
5. **Pass through, don't reinterpret.**
   - The gateway forwards any command and any frame.
   - The UI renders unknown tools generically, shows unknown message roles as collapsible cards, and logs every frame in the Events pane.
   - New upstream tools, commands and events therefore appear without Gyre changes.
6. **Discover rather than hard-code.**
   - Slash commands come from `get_available_commands` and `available_commands_update`.
   - Models come from `get_model_picker`, and thinking levels from `get_state.thinkingLevels`.
   - Login providers come from `get_login_providers`.
7. **Only filter events for performance.** If `set_event_filter` is ever used, the Events pane must still be able to show everything.

### Coupling points (what can break on upgrade)

| Coupling | Where | Guarded by |
|---|---|---|
| RPC framing (ready frame, v2 negotiation, `rpc_chunk`) | `omp-process.ts` uses omp's exported `RpcFrameDecoder` | `test/contract.test.ts`, `test/gateway.test.ts` |
| `get_state` / `get_session_stats` field names | `store/chats.ts`, `ChatStrip.tsx` | contract test asserts the fields exist |
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
omp update                 # or reinstall omp at the new version
bun scripts/bump-omp.ts    # pin gateway + extension to the installed omp; runs typecheck and tests
bun packages/e2e/run.ts    # optional UI check (see its header)
```

CI (`.github/workflows/ci.yml`) runs the tests against the pinned and the latest omp on pushes to main, pull requests and daily, so upstream drift shows up as a red "latest" job before users hit it.

### Plan mode shell policy

While planning, the prompts forbid state-changing shell commands, but the shell stays available and its denylist is a best-effort guard, not a sandbox. File-tool writes are limited to session-local plan files. On approval the extension checks the submitted plan, applies the chosen role and context (fresh, compact or keep); a fresh session gets the approved plan in its local files.
