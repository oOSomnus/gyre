/**
 * Gyre UI <-> gateway protocol.
 *
 * Design rule: omp frames and commands pass through untouched. The gateway owns
 * product state (projects, workspaces, layouts, terminals) and process lifecycle;
 * it does not reinterpret agent semantics. New omp commands/events therefore reach
 * the UI without gateway changes.
 */

/** Any omp RPC command body (`{ type: "...", ... }`), without the `id`. */
export type OmpCommand = { type: string; [key: string]: unknown };

/** Any omp outbound frame other than a command response. */
export type OmpFrame = { type: string; [key: string]: unknown };

/** An omp `extension_ui_response` body (without `type`). */
export type OmpUiResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; cancelled: true; timedOut?: boolean }
	| { id: string; answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
	| { id: string; data: Record<string, unknown> };

export type ChatStatus = "starting" | "ready" | "exited";

export interface ChatInfo {
	chatId: string;
	projectId: string;
	cwd: string;
	status: ChatStatus;
	sessionPath?: string;
	error?: string;
	/** True while a turn is running (agent_start .. session_settled). */
	busy?: boolean;
	/** Process start time (ms). */
	startedAt?: number;
	/** Unique identity of the current omp process. */
	generation?: string;
	/** Number of connected UI subscribers. */
	subscribers?: number;
}

/** A running terminal, as listed by the task manager. */
export interface PtyInfo {
	ptyId: string;
	key?: string;
	projectId: string;
	cwd: string;
	pid?: number;
	startedAt: number;
	attached: number;
}

// ---------------------------------------------------------------------------
// Client -> gateway
// ---------------------------------------------------------------------------

export type ClientMessage =
	| { t: "hello"; token: string }
	| { t: "open_chat"; reqId: string; projectId: string; chatId?: string; sessionPath?: string }
	| { t: "close_chat"; chatId: string }
	| { t: "subscribe"; chatId: string }
	| { t: "rpc"; reqId: string; chatId: string; command: OmpCommand; timeoutMs?: number }
	| { t: "ui_response"; chatId: string; response: OmpUiResponse }
	/** Open or reattach to the terminal identified by `key` (the pane id). Reattach replays scrollback. */
	| { t: "pty_open"; reqId: string; projectId: string; cols: number; rows: number; key?: string }
	| { t: "pty_input"; ptyId: string; data: string }
	| { t: "pty_resize"; ptyId: string; cols: number; rows: number }
	/** Stop receiving output; the shell keeps running (pane hidden or remounted). */
	| { t: "pty_detach"; ptyId: string; attachmentId: string }
	/** Kill the shell. */
	| { t: "pty_close"; ptyId: string }
	| { t: "pty_close_key"; key: string; projectId: string };

// ---------------------------------------------------------------------------
// Gateway -> client
// ---------------------------------------------------------------------------

export type ServerMessage =
	| { t: "welcome"; version: string; ompVersion: string | null; ompStatus?: OmpStatus }
	| { t: "error"; message: string }
	| { t: "result"; reqId: string; ok: true; data: unknown }
	| { t: "result"; reqId: string; ok: false; error: string; code?: string }
	| { t: "chat_replay"; chat: ChatInfo }
	| { t: "chat"; chat: ChatInfo }
	| { t: "frame"; chatId: string; frame: OmpFrame }
	| { t: "pty_data"; ptyId: string; data: string }
	| { t: "pty_exit"; ptyId: string; code: number | null };

// ---------------------------------------------------------------------------
// HTTP resources (gateway-owned product state)
// ---------------------------------------------------------------------------

export interface Project {
	id: string;
	name: string;
	path: string;
	createdAt: number;
}

/**
 * Whether omp can run chats: "missing" (no omp binary), "no-models" (no provider
 * configured, so omp refuses to start), "unknown" (the check itself failed; chats
 * are still allowed), "checking" while the first check runs.
 */
export type OmpStatus = "checking" | "ok" | "missing" | "no-models" | "unknown";

export interface HealthInfo {
	ok: boolean;
	version: string;
	ompVersion: string | null;
	ompStatus: OmpStatus;
}

/** Running work tied to a project (shown before removing it). */
export interface ProjectUsage {
	chats: number;
	terminals: number;
}

/** One directory in the folder browser (`GET /api/fs/browse`). */
export interface BrowseEntry {
	name: string;
	path: string;
	isGitRepo: boolean;
}

export interface BrowseListing {
	path: string;
	parent: string | null;
	home: string;
	entries: BrowseEntry[];
}

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	title?: string;
	status?: string;
}

export type PaneKind =
	| "chat"
	| "file"
	| "terminal"
	| "sessions"
	| "subagents"
	| "settings"
	| "events"
	| "plan"
	| "objectives"
	| "graph"
	| "tasks"
	| "message"
	| "image"
	| "subagent"
	| "studio"
	| "git"
	| "hooks";

/** A pane in the tiled workspace. `kind` decides the component. */
export interface PaneSpec {
	id: string;
	kind: PaneKind;
	projectId?: string;
	/** chat: bound session file, if any. */
	sessionPath?: string;
	/** file: project-relative path. */
	filePath?: string;
	/** Panes that belong to a chat (plan, objectives, graph, events, message, subagent): its pane id. */
	chatId?: string;
	/** subagent: omp subagent id. */
	subagentId?: string;
	/** message / image: a reference into the chat transcript or an in-memory registry. */
	ref?: string;
	/** settings / studio: initial section. */
	section?: string;
	/** git: the commit the pane is pinned to (any revision `git rev-parse` accepts). */
	revision?: string;
	title?: string;
}

/** A floating pane's geometry, in pixels relative to the grid. */
export interface FloatRect {
	x: number;
	y: number;
	w: number;
	h: number;
	z: number;
}

/** Binary-split tiling layout. */
export type LayoutNode = { type: "pane"; paneId: string } | { type: "split"; direction: "row" | "column"; sizes: number[]; children: LayoutNode[] };

export interface Workspace {
	/** Server revision; absent on legacy layouts and unsaved workspaces. */
	revision?: number;
	id: string;
	name: string;
	panes: Record<string, PaneSpec>;
	layout: LayoutNode | null;
	focusedPaneId?: string;
	/** Panes pushed out of the layout when there was no room (most recent last). */
	hidden?: string[];
	/** Hidden panes the user hid on purpose: never restored automatically. */
	hiddenManual?: string[];
	/** Panes floating above the grid. */
	floating?: Record<string, FloatRect>;
	/** paneId -> last focus time, used to choose which pane to hide. */
	lastFocus?: Record<string, number>;
	updatedAt: number;
}

export interface FsEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
	size?: number;
}

/** `GET /api/fs/read`: a file's text, and the version a save must match. */
export interface FsFile {
	path: string;
	content: string;
	truncated: boolean;
	binary: boolean;
	size: number;
	/** sha256 of the bytes; absent when the file was too large to read whole. */
	version?: string;
}

/** `PUT /api/fs/write` result. A 412 body carries `currentVersion` (null: file absent or already exists). */
export interface FsWriteResult {
	path: string;
	version: string;
	size: number;
}

/** Gyre plan-mode state, published by the Gyre omp extension as the `gyre.plan` widget. */
export interface PlanState {
	phase: "idle" | "planning" | "reviewing" | "executing";
	title?: string;
	planFilePath?: string;
	planContent?: string;
	/** Plannotator review page, when Plannotator is installed. */
	reviewUrl?: string;
	reviewId?: string;
	/** Increments with every submitted plan revision. */
	revision?: number;
	planModel?: string;
	error?: string;
	updatedAt: number;
}

/** The user's choices for how an approved plan runs. */
export interface PlanPrefs {
	role: string;
	context: "fresh" | "compact" | "keep";
}

// ---------------------------------------------------------------------------
// Git pane (`/api/projects/:id/git/...`)
// ---------------------------------------------------------------------------

/** One changed path. `index`/`worktree` are porcelain status letters ("." = unchanged, "?" = untracked). */
export interface GitFile {
	path: string;
	/** Rename/copy source. */
	origPath?: string;
	index: string;
	worktree: string;
	untracked: boolean;
	/** Unmerged (conflicted) path. */
	conflicted?: boolean;
	/** Lines added/removed in the index (staged) and work tree (unstaged); undefined for binary files. */
	staged?: { added?: number; removed?: number; binary?: boolean };
	unstaged?: { added?: number; removed?: number; binary?: boolean };
}

export interface GitStatus {
	root: string;
	/** Branch name, or null when HEAD is detached. */
	branch: string | null;
	headSha?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	files: GitFile[];
}

/** A diff hunk. `id` hashes the header and body, so a hunk action on a changed tree is rejected. */
export interface GitHunk {
	id: string;
	header: string;
	/** The hunk's lines, header excluded. */
	lines: string[];
}

export interface GitDiff {
	path: string;
	/** Old side path (differs on renames). */
	oldPath: string;
	/** Which side: index vs HEAD (staged) or work tree vs index (unstaged). Ignored for a revision diff. */
	staged: boolean;
	revision?: string;
	binary: boolean;
	/** Full text of each side for the split view ("" when the side does not exist or is binary). */
	oldText: string;
	newText: string;
	/** True when a side was too large to send and was left empty. */
	truncated?: boolean;
	hunks: GitHunk[];
}

export interface GitCommitInfo {
	sha: string;
	author: string;
	email: string;
	date: string;
	subject: string;
	body: string;
	parents: string[];
	files: Array<{ path: string; origPath?: string; status: string; added?: number; removed?: number }>;
}

export type GitHunkAction = "stage" | "unstage" | "discard";

export const PLAN_WIDGET_KEY = "gyre.plan";

export const GATEWAY_VERSION = "0.2.0";

export * from "./ui-requests";

/** omp hook modules: `<agentDir>/hooks/{pre,post}/` (user) and `<project>/.omp/hooks/{pre,post}/` (project). */
export type HookPhase = "pre" | "post";

export interface HookFile {
	scope: "user" | "project";
	phase: HookPhase;
	/** File name; its base name is the tool the hook is filed under (`*` for every tool). */
	name: string;
	tool: string;
	path: string;
	/** Present when one hook is read. */
	content?: string;
	version?: string;
}
