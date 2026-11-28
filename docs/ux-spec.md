# Gyre UX spec

Gyre's UI (themes, window manager, panes, keyboard) and the omp RPC commands, events and gateway endpoints that drive each part.

## Design language (`packages/web/src/styles.css`)

- **Themes** (Settings → General, the workspace-name menu, or `Theme:` in the palette; stored in `localStorage` `gyre.theme`). Themes come in light/dark pairs (`THEME_FAMILIES` in `lib/themes.tsx`); Settings and the workspace menu lay them out as a grid with one row per family and Light / Dark columns. Every theme defines the same token set in `styles.css`; non-CSS consumers (xterm, graph minimap, shiki/mermaid/Monaco light or dark) read `lib/themes.tsx`. Fonts: Space Grotesk and JetBrains Mono.

  | Family | Theme | Look | Title bars |
  |---|---|---|---|
  | Graphite | **Graphite** (default, light) | ink-blue chrome, cool porcelain panes; cyan = working, orange = needs you, violet = plan | solid dark bar with a 3px stripe in the pane's colour |
  | | **Carbon** (dark) | Graphite's chrome around deep slate panes | as Graphite |
  | Riso | **Riso** (light) | riso-blue chrome, off-white paper, pink and blue spot inks, square corners | flat spot colour with a black halftone, hard offset shadow when focused |
  | | **Blacklight** (dark) | deep riso-blue chrome, warm-black paper, fluorescent inks, off-white outlines | as Riso, with a pink offset shadow |
  | Phosphor | **Greenbar** (light) | green-black chrome around pale green printer-paper panes | as Phosphor, on a light bar |
  | | **Phosphor** (dark) | dark green-black throughout; green = working, amber = needs you | dark bar, pane colour as text and rule, glow when focused |
  | Dune | **Dune** (light) | dark slate chrome around warm sand panes | gradient bar per pane kind |
  | | **Dusk** (dark) | warm greys, teal accents | gradient bar per pane kind |

- **Halftone**: every theme carries a dot texture on the chrome (top bar, gutters, hidden bar, phone tab strip), the title bars and the chat strip (`--halftone`, `--halftone-head`).
- **The gyroscope** (`shell/Gyroscope.tsx`, `lib/gyro.ts`) is Gyre's mark: three gimbal rings on pivot pins around a rotor on its axle, drawn on a 2D canvas with its own small 3D projection and lighting (no WebGL). *Idle*: slow drift in the theme's metal. *Working* (any agent busy): the rotor spins up and the ring edges catch the working colour. *Needs you* (a pending dialog or plan review): the outer ring turns to face you in the alert colour and stops. One shared animation loop; off-screen instances are skipped, nothing runs while the page is hidden, and reduced-motion users get a still pose. The app icon and favicon are renders of the same mark (`packages/e2e/render-icon.ts`).
- **Pane frames**: a colored border and title bar per pane kind (chat, terminal, task manager, files, plan, settings, …; colours per theme). A red square close button and a maximize button on the left, the title on the right as `project / name` with the project underlined. Unfocused panes are slightly desaturated; the focused pane glows.
- **Event cards**: 1px ink border, a tinted header strip with an uppercase letter-spaced mono label (USER butter, ASSISTANT parchment, THINKING lavender, tools sage/teal, COMPLETION CHOICE sky, TOOL SAFETY amber, errors coral, plan gold) and a separate bordered meta cell on the right: `view · review · fork · HH:MM:SS`.
- **Controls**: uppercase mono buttons with a 1px border and a 2px offset shadow; red danger buttons; green pill toggles; outlined status chips; keycaps; numbered choice rows with a teal selected state and an `Alt + 1…9` legend.
- **Top bar**: brand and New/palette on the left; a centered MODES group (MARKS Alt+W, KBD), the gyroscope (state as above; click for the palette) and badges (the notification bell with the count of chats that need you and an unread dot, running sub-agents); the workspace name and a minimap per workspace on the right.
- **Chat strip**: a dark rounded strip above each composer with cache reads, chat state, model, Marks, plan mode, review (badged when the last turn changed files), objectives, sub-agents, event graph, thinking level, tok/s with a sparkline, and a context ring. Cells hide by container width.

## Window manager (`store/app.ts`, `shell/PaneGrid.tsx`)

- **Auto-tiling.** A new pane splits the largest docked pane along its longer side. Each kind has a minimum size; after every change (and on window resize) a fit pass moves the least-recently-focused pane to the **hidden bar** while any docked pane would be too small, and brings automatically hidden panes back when there is room. Panes hidden on purpose (H) stay hidden.
- **Hidden bar**: chips under the grid with a status light; hovering shows a scaled live preview (terminals show a placeholder); clicking restores.
- **Floating panes**: drag by the title bar, resize from the corner, layered above the grid; dock back with F or the pane menu.
- **Move to workspace**, **swap** (Shift+WASD), **keyboard resize** (Ctrl+WASD).
- **Workspace minimap**: each pane gets a traffic light (running pulses orange, needs you is yellow, error red, done green). Click to switch workspace.
- Terminals keep running when their pane is hidden, floated, moved or remounted: the gateway keys each shell by pane id and replays scrollback on reattach.
- **Phone layout** (< 768px): one pane at a time with a bottom tab strip.

## Screen inventory and data sources

Legend: `cmd` RPC command, `evt` event frame, `ui` `extension_ui_request` method, `gw` gateway-owned state, `ext` Gyre's omp extension, `cli` omp CLI run by the gateway.

| Element | Gyre component | Driven by |
|---|---|---|
| Top bar, modes, gyroscope, minimaps | `shell/TopBar.tsx` | local state, chat store |
| Tiled panes, hidden window bar, floating panes | `shell/PaneGrid.tsx` | `gw` `/api/workspaces` (layout, hidden, floating) |
| Pane title bar | `PaneFrame` | `cmd get_state` `sessionName`, first user message |
| Transcript cards with view · review · fork · time | `chat/Cards.tsx` | `evt message_*`, `cmd get_messages`; fork: `cmd get_entries` + `cmd fork {entryId}` in a new pane |
| Answer in its own pane / review a reply | `panes/MessagePane.tsx` | snapshot of the message; review sends an edited reply with `cmd prompt` |
| Rendered Markdown, tables, Mermaid, LaTeX | `chat/Markdown.tsx` (react-markdown, remark-gfm, remark-math + rehype-katex, shiki, mermaid) | assistant text |
| File links in replies | `FileLink` in `Markdown.tsx` | `gw` `/api/fs/stat` (batched); opens `panes/FilePane.tsx` |
| Images at actual size | `panes/ImagePane.tsx` | image content blocks |
| COMPLETION CHOICE / TOOL SAFETY | `chat/DialogCard.tsx` | `ui select/confirm/input/editor/ask/form/cancel`; approval prompts are selects ending in "Deny" |
| Sub-agent cards inside the task card | `chat/SubagentCard.tsx` | `cmd set_subagent_subscription {level: progress}`, `evt subagent_lifecycle/progress` (matched by `parentToolCallId`) |
| Sub-agent pane: the sub-agent's conversation rendered like a chat (streaming text, thinking, running tool cards), read-only apart from steer and cancel; opened from its card, the Agents pane or Task Manager | `panes/SubagentPane.tsx`, `chat/Transcript.tsx`, `store/subagent-transcripts.ts` | `cmd set_subagent_subscription {level: events}` while open, `evt subagent_event` (folded like chat frames), `cmd get_subagent_messages` (once, then only when nothing streams), `cmd steer_subagent`, `cmd cancel_subagent` |
| Objectives | `panes/ObjectivesPane.tsx` | `cmd goal`, `get_state.goal`, `get_state.todoPhases`, todo `tool_execution_end` details |
| Event graph | `panes/GraphPane.tsx` (@xyflow/react) | transcript, tool executions, sub-agents, todo phases |
| Task Manager | `panes/TasksPane.tsx` | `gw` `/api/chats` (+ restart/kill), `/api/ptys`, chat store sub-agents |
| Plan mode + review | `panes/PlanPane.tsx`, `ChatStrip` plan toggle, `PlanBanner` | `ext` `gyre.plan` widget state, `/gyre-plan` control command, `gw` `/api/chats/:id/plan-prefs`; Plannotator review page in an iframe |
| Agent Studio | `panes/StudioPane.tsx` | `gw` `/api/agents` (agent `.md` files), drafts in `/api/kv/ui.agentDrafts`, `cli` `task.agentModelOverrides` |
| MCP studio | Settings → MCP servers | `gw` `/api/mcp` (omp `mcp.json`), `/mcp test` and `/mcp reauth` via `cmd prompt`, `gw` restart-chats |
| Models & roles | Settings → Models & roles, model picker role chips and its Roles view (each role's model and effort; Ctrl M switches views) | `cli` `modelRoles`, `modelRoleStorage`; `cmd get_model_picker` |
| Sub-agent routing | Settings → Agent routing, Agent Studio | `cli` `task.agentModelOverrides`, agent `model: @role` |
| Config importer | Settings → Config sources | `cli` `enabledProviders` (omp reads other tools' configs live) |
| Skills | Settings → Skills | `cli` `omp skill list --json` |
| Remote access | Settings → Remote access, login screen | `gw` allowed hosts, `/api/login` cookie |
| Marks | `marks/JumpMarks.tsx` | DOM; second-step actions per `data-jump-kind` (link, table, image, code, file) |
| Palettes (Alt+X global, Alt+C pane) | `palette/CommandPalette.tsx` | app actions, `cmd get_available_commands` |
| TUI-only omp commands (`/clear`, `/new`, `/resume`, `/model`, `/settings`, `/git`) | `chat/localCommands.ts` (composer and palette) | `cmd new_session` (`/clear` links the old session as parent), Sessions pane, model picker, Settings pane, Git pane. omp's own version wins if it ever advertises one over RPC |
| Git pane (`/git [revision]`, New menu, palette): branch and ahead/behind, Conflicts / Staged / Changes groups with stage, unstage and discard per file (discard asks first), a hunk list over a Monaco split diff (inline in narrow panes and on phones) with per-hunk stage, unstage and discard, commit and amend (Ctrl+Enter), Generate. With a revision: a read-only view of that commit. Refreshes on focus, after its own actions and when a chat in the project finishes a turn | `panes/GitPane.tsx`, `panes/MonacoDiffViewer.tsx`, `lib/git.ts` | `gw` `/api/projects/:id/git/{status,diff,commit,last-message}` (GET), `/git/{stage,unstage,discard,hunk,commit,generate-message}` (POST); Generate runs `cli` `omp commit --legacy --dry-run` |
| Terminal, Send to AI | `panes/TerminalPane.tsx` | `gw` PTY (`pty_open {key}`, `pty_detach`, `pty_close`) |
| Files, sessions, settings/providers, raw events | `FilePane`, `SessionsPane`, `SettingsPane`, `EventsPane` | `gw` `/api/fs/*`, `/api/sessions`; `cli` config; `cmd get_login_providers`; every `evt` |
| File editing: Monaco editor, Ctrl+S, unsaved dot, a bar offering reload / overwrite / diff when the file changed on disk, New file, a confirmation before closing unsaved edits | `panes/FilePane.tsx`, `panes/MonacoViewer.tsx` | `gw` `GET /api/fs/read` (`version`), `PUT /api/fs/write` (`baseVersion`, `412`) |
| Hook Studio: user and project hooks grouped by pre/post, templates, a guided form (trigger, tools, input pattern, block / confirm / notify / run a command with a timeout, variables) that generates an editable module, save with syntax diagnostics, restart affected chats | `panes/HookStudioPane.tsx`, `lib/hook-templates.ts` | `gw` `/api/hooks`, `/api/hooks/file`, `/api/projects/:id/restart-chats` |
| Background jobs: every chat's jobs (type, intent, command, caption, status, duration), Kill, the chat, a settled job's result; a Task Manager row links here | `panes/JobsPane.tsx`, `lib/jobs.ts` | `ext` `gyre.jobs` widget (`ctx.getAsyncJobSnapshot()`), `cmd prompt` `/jobs kill <id>`, transcript `async-result` messages |
| Review (`/review`, Alt+R, chat strip): turns newest first; "This turn" (before → after) or "Since then" (before → work tree) with per-file and per-hunk revert; line-number clicks add comments sent to the composer as one message | `panes/ReviewPane.tsx`, `lib/review.ts` | `ext` `gyre.turns` widget, `gw` `/api/projects/:id/review/{files,diff,revert}` |
| Notifications (bell, Alt+N): needs you, finished, failed, plan ready, job settled, warnings and hook or extension errors (opening Hook Studio for a hook); Settings → General toggles system notifications | `shell/NotificationCenter.tsx`, `store/notifications.ts`, `lib/notifications.ts` | chat-store transitions; `evt extension_error` |
| Browser: address bar, back / forward / reload / open in tab; localhost links in chat open here; remote browsers go through a preview proxy | `panes/BrowserPane.tsx`, `lib/browser.ts` | `gw` `POST/DELETE /api/preview` |
| omp setup reminder (omp missing / no provider; points to omp for provider setup) | `shell/OmpSetup.tsx` in dead chat panes, the empty workspace, the phone layout and Settings → Providers; TopBar "Add a provider" chip | `gw` `ompStatus` from `/api/health` and `welcome`; Re-check: `gw` `POST /api/omp/recheck`, then restarts dead chat panes |
| Add project (folder browser) | `projects/AddProjectDialog.tsx`: path field, breadcrumbs, filterable folder list with git badges, hidden toggle, keyboard (↑↓ Enter Backspace) | `gw` `GET /api/fs/browse`, `POST /api/projects` |
| Manage projects | Settings → Projects (also TopBar New menu and palette "Manage projects…"): rename, new chat, remove with a confirmation listing what stops | `gw` `PATCH/DELETE /api/projects/:id`, `/api/projects/:id/usage`; removal closes the project's panes in every workspace |

## Plan mode

Gyre's omp extension (`packages/omp-extension`) provides plan mode over RPC, since omp's own is TUI-only (see [architecture](architecture.md#plan-mode-and-upstream)):

1. `/plan [task]` (or the strip toggle) switches to the **plan**-role model, adds `submit_plan`, makes the working tree read-only (writes only under `local://`; a best-effort denylist blocks destructive shell commands) and injects plan instructions adapted from omp's `plan-mode-active.md` on every turn.
2. The agent writes `local://<slug>-plan.md` and calls `submit_plan`. If it ends a turn without asking or submitting it is reminded (at most 3 times).
3. A **Plan** pane opens next to the chat. With the Plannotator omp extension installed it shows Plannotator's review page (annotations, plan diff); otherwise Gyre's own card with per-section comments. The toolbar holds the execution choices: **Continue with** (any chat role) and **Context** (fresh session / compact / keep).
4. Feedback (from Plannotator or Gyre) goes back to the agent, which revises and resubmits; earlier revisions collapse into a history list.
5. Approval restores the tools, switches to the chosen role's model, applies the context choice and sends the full plan (adapted `plan-mode-approved.md`). The chat runs it with full access; the plan state returns to idle when that run ends.

## Keyboard map

| Keys | Action |
|---|---|
| Alt X / Ctrl K | Global palette (type `/` for omp commands) |
| Alt C | Actions for the focused pane |
| Alt W (or Alt J) | Marks: label everything; links/tables/images/code/files offer actions (1-9); a terminal's mark focuses its input |
| Alt M | Keyboard mode: WASD focus, Shift+WASD swap, Ctrl+WASD resize, Q/E workspaces, 1-9 jump, H hide, F float/dock, Z maximize, X close, N chat, T terminal, Esc exit |
| Alt Z | Maximize / restore |
| Alt R | Review the focused chat's changes |
| Alt N | Notifications |
| Ctrl M | Model picker; again inside it to switch between Models and Roles |
| Alt ← ↑ → ↓ | Move focus between panes |
| Alt 1…9 | Answer the newest dialog |
| Alt Shift 1…9 | Switch workspace |
| Ctrl Shift Enter | New chat |
| Enter / Alt Enter while working | Steer / queue a follow-up; Esc stops |

## Not built

| Feature | Status |
|---|---|
| Git push, pull, branches, stash, AI-selected staging | not in the Git pane yet; use a terminal |
| Live output of a running background job | omp exposes no job output to extensions; the Jobs pane shows the result once omp delivers it to the chat |
| Semantic indexer, objective evaluator | not planned; omp's own search tools, goals and todos cover the agent side |
