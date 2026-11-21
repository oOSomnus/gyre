# Gyre UX spec

This spec describes Gyre's UI (layout, themes, window manager, panes and keyboard model) and which omp RPC commands, events and Gyre gateway endpoints drive each part. Fonts: Space Grotesk and JetBrains Mono, via `@fontsource`.

## Design language (`packages/web/src/styles.css`)

- **Themes** (Settings → General, the workspace-name menu, or `Theme:` in the palette; stored in `localStorage` `gyre.theme`). Every theme defines the same token set in `styles.css`; non-CSS consumers (xterm, graph minimap, shiki/mermaid/Monaco light or dark) read `lib/themes.ts`.

  | Theme | Look | Title bars |
  |---|---|---|
  | **Graphite** (default) | ink-blue chrome, cool porcelain panes; cyan = working, orange = needs you, violet = plan | solid dark bar with a 3px stripe in the pane's colour |
  | **Riso** | riso-blue chrome, off-white paper, pink and blue spot inks, square corners | flat spot colour with a black halftone, hard offset shadow when focused |
  | **Phosphor** | dark green-black throughout; green = working, amber = needs you | dark bar, pane colour as text and rule, glow when focused |
  | **Dune** | dark slate chrome around warm sand panes | gradient bar per pane kind |
  | **Dusk** | Dune's dark variant | gradient bar per pane kind |

- **Halftone**: every theme carries a dot texture on the chrome (top bar, gutters, hidden bar, phone tab strip), the title bars and the chat strip (`--halftone`, `--halftone-head`).
- **The gyroscope** (`shell/Gyroscope.tsx`, `lib/gyro.ts`) is Gyre's mark: three gimbal rings on pivot pins around a rotor on its axle, drawn on a 2D canvas with its own small 3D projection and lighting (no WebGL). *Idle*: slow drift in the theme's metal. *Working* (any agent busy): the rotor spins up and the ring edges catch the working colour. *Needs you* (a pending dialog or plan review): the outer ring turns to face you in the alert colour and stops. One shared animation loop; off-screen instances are skipped, nothing runs while the page is hidden, and reduced-motion users get a still pose. The app icon and favicon are renders of the same mark (`packages/e2e/render-icon.ts`).
- **Pane frames**: a colored border and title bar per pane kind (chat, terminal, task manager, files, plan, settings, …; colours per theme). A red square close button and a maximize button on the left, the title on the right as `project / name` with the project underlined. Unfocused panes are slightly desaturated; the focused pane glows.
- **Event cards**: 1px ink border, a tinted header strip with an uppercase letter-spaced mono label (USER butter, ASSISTANT parchment, THINKING lavender, tools sage/teal, COMPLETION CHOICE sky, TOOL SAFETY amber, errors coral, plan gold) and a separate bordered meta cell on the right: `view · review · fork · HH:MM:SS`.
- **Controls**: uppercase mono buttons with a 1px border and a 2px offset shadow; red danger buttons; green pill toggles; outlined status chips; keycaps; numbered choice rows with a teal selected state and an `Alt + 1…9` legend.
- **Top bar**: brand and New/palette on the left; a centered MODES group (MARKS Alt+W, KBD), the gyroscope (state as above; click for the palette) and badges (chats that need you, running sub-agents); the workspace name and a minimap per workspace on the right.
- **Chat strip** (replaces the old global status bar): a dark rounded strip above each composer with cache reads, chat state, model, Marks, plan mode, objectives, sub-agents, event graph, thinking level, tok/s with a sparkline, and a context ring. Cells hide by container width.

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
| Sub-agent pane | `panes/SubagentPane.tsx` | `cmd get_subagent_messages` (incremental), `cmd steer_subagent`, `cmd cancel_subagent` |
| Objectives | `panes/ObjectivesPane.tsx` | `cmd goal`, `get_state.goal`, `get_state.todoPhases`, todo `tool_execution_end` details |
| Event graph | `panes/GraphPane.tsx` (@xyflow/react) | transcript, tool executions, sub-agents, todo phases |
| Task Manager | `panes/TasksPane.tsx` | `gw` `/api/chats` (+ restart/kill), `/api/ptys`, chat store sub-agents |
| Plan mode + review | `panes/PlanPane.tsx`, `ChatStrip` plan toggle, `PlanBanner` | `ext` `gyre.plan` widget state, `/gyre-plan` control command, `gw` `/api/chats/:id/plan-prefs`; Plannotator review page in an iframe |
| Agent Studio | `panes/StudioPane.tsx` | `gw` `/api/agents` (agent `.md` files), drafts in `/api/kv/ui.agentDrafts`, `cli` `task.agentModelOverrides` |
| MCP studio | Settings → MCP servers | `gw` `/api/mcp` (omp `mcp.json`), `/mcp test` and `/mcp reauth` via `cmd prompt`, `gw` restart-chats |
| Models & roles | Settings → Models & roles, model picker role chips | `cli` `modelRoles`, `modelRoleStorage`; `cmd get_model_picker` |
| Sub-agent routing | Settings → Agent routing, Agent Studio | `cli` `task.agentModelOverrides`, agent `model: @role` |
| Config importer | Settings → Config sources | `cli` `enabledProviders` (omp reads other tools' configs live) |
| Skills | Settings → Skills | `cli` `omp skill list --json` |
| Remote access | Settings → Remote access, login screen | `gw` allowed hosts, `/api/login` cookie |
| Marks | `marks/JumpMarks.tsx` | DOM; second-step actions per `data-jump-kind` (link, table, image, code, file) |
| Palettes (Alt+X global, Alt+C pane) | `palette/CommandPalette.tsx` | app actions, `cmd get_available_commands` |
| TUI-only omp commands (`/clear`, `/new`, `/resume`, `/model`, `/settings`) | `chat/localCommands.ts` (composer and palette) | `cmd new_session` (`/clear` links the old session as parent), Sessions pane, model picker, Settings pane. omp's own version wins if it ever advertises one over RPC |
| Terminal, Send to AI | `panes/TerminalPane.tsx` | `gw` PTY (`pty_open {key}`, `pty_detach`, `pty_close`) |
| Files, sessions, settings/providers, raw events | `FilePane`, `SessionsPane`, `SettingsPane`, `EventsPane` | as in v0.1 |

## Plan mode

omp's built-in plan mode is wired only into its TUI (the `/plan` builtin has no RPC handler and the review overlay is TUI-only), so Gyre ships an omp extension (`packages/omp-extension`) that implements the same workflow through omp's public extension API:

1. `/plan [task]` (or the strip toggle) switches to the **plan**-role model, adds `submit_plan`, makes the working tree read-only (writes only under `local://`, destructive shell commands blocked) and injects plan instructions adapted from omp's `plan-mode-active.md` on every turn.
2. The agent writes `local://<slug>-plan.md` and calls `submit_plan`. If it ends a turn without asking or submitting it is reminded (at most 3 times).
3. A **Plan** pane opens next to the chat. With the Plannotator omp extension installed it shows Plannotator's review page (annotations, plan diff); otherwise Gyre's own card with per-section comments. The toolbar holds the execution choices: **Continue with** (any chat role) and **Context** (fresh session / compact / keep).
4. Feedback (from Plannotator or Gyre) goes back to the agent, which revises and resubmits; earlier revisions collapse into a history list.
5. Approval restores the tools, switches to the chosen role's model, applies the context choice and sends the full plan (adapted `plan-mode-approved.md`). The chat runs it with full access; the plan state returns to idle when that run ends.

## Keyboard map

| Keys | Action |
|---|---|
| Alt X / Ctrl K | Global palette (type `/` for omp commands) |
| Alt C | Actions for the focused pane |
| Alt W (or Alt J) | Marks: label everything; links/tables/images/code/files offer actions (1-9) |
| Alt M | Keyboard mode: WASD focus, Shift+WASD swap, Ctrl+WASD resize, Q/E workspaces, 1-9 jump, H hide, F float/dock, Z maximize, X close, N chat, T terminal, Esc exit |
| Alt Z | Maximize / restore |
| Ctrl M | Model picker |
| Alt ← ↑ → ↓ | Move focus between panes |
| Alt 1…9 | Answer the newest dialog |
| Alt Shift 1…9 | Switch workspace |
| Ctrl Shift Enter | New chat |
| Enter / Alt Enter while working | Steer / queue a follow-up; Esc stops |

## Not built

| Feature | Status |
|---|---|
| Hook Studio | omp hooks are files under `.omp/hooks`; edit them in a terminal or file pane |
| Commit review ("Review N changes", Alt+R) | not built; omp's `/review` or a terminal `git diff` |
| Embedded browser pane | omp's `browser` tool renders as a tool card |
| Semantic indexer, objective evaluator | not planned; omp's own search tools, goals and todos cover the agent side |
