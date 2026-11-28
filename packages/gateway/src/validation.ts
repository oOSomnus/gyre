import type { ClientMessage, Workspace } from "@gyre/protocol";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const terminalSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535;

export function validClientMessage(v: unknown): v is ClientMessage {
	if (!record(v) || !text(v.t)) return false;
	const strings = (...keys: string[]) => keys.every(k => text(v[k]));
	switch (v.t) {
		case "hello":
			return strings("token");
		case "open_chat":
			return strings("reqId", "projectId") && [v.chatId, v.sessionPath].every(x => x === undefined || text(x));
		case "subscribe":
		case "close_chat":
			return strings("chatId");
		case "rpc":
			return strings("reqId", "chatId") && record(v.command) && text(v.command.type) && (v.timeoutMs === undefined || (finite(v.timeoutMs) && v.timeoutMs > 0));
		case "ui_response":
			return strings("chatId") && record(v.response) && text(v.response.id);
		case "pty_open":
			return strings("reqId", "projectId") && terminalSize(v.cols) && terminalSize(v.rows) && (v.key === undefined || text(v.key));
		case "pty_input":
			return strings("ptyId", "data");
		case "pty_resize":
			return strings("ptyId") && terminalSize(v.cols) && terminalSize(v.rows);
		case "pty_close_key":
			return strings("key", "projectId");
		case "pty_detach":
			return strings("ptyId", "attachmentId");
		case "pty_close":
			return strings("ptyId");
		default:
			return false;
	}
}

const kinds = new Set([
	"chat",
	"terminal",
	"file",
	"sessions",
	"subagents",
	"settings",
	"events",
	"plan",
	"objectives",
	"graph",
	"tasks",
	"message",
	"image",
	"subagent",
	"studio",
	"git",
	"hooks",
	"jobs",
	"review",
]);
export function validWorkspace(v: unknown): v is Workspace {
	if (!record(v) || !text(v.name) || !record(v.panes) || !finite(v.updatedAt)) return false;
	if (v.revision !== undefined && (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0)) return false;
	const panes = v.panes;
	for (const [id, p] of Object.entries(panes)) {
		if (!record(p) || p.id !== id || !text(p.kind) || !kinds.has(p.kind)) return false;
		if (!["projectId", "sessionPath", "filePath", "chatId", "subagentId", "ref", "section", "title", "revision"].every(k => p[k] === undefined || text(p[k]))) return false;
	}
	const paneId = (id: unknown) => text(id) && Object.hasOwn(panes, id);
	const seen = new Set<string>();
	const layout = (node: unknown, depth: number): boolean => {
		if (node === null) return true;
		if (!record(node) || depth > 64) return false;
		if (node.type === "pane") {
			if (!paneId(node.paneId) || seen.has(String(node.paneId))) return false;
			seen.add(String(node.paneId));
			return true;
		}
		return (
			node.type === "split" &&
			(node.direction === "row" || node.direction === "column") &&
			Array.isArray(node.children) &&
			node.children.length > 0 &&
			Array.isArray(node.sizes) &&
			node.sizes.length === node.children.length &&
			node.sizes.every(x => finite(x) && x > 0) &&
			node.children.every(x => x !== null && layout(x, depth + 1))
		);
	};
	if (!layout(v.layout, 0) || (v.focusedPaneId !== undefined && !paneId(v.focusedPaneId))) return false;
	if (![v.hidden, v.hiddenManual].every(ids => ids === undefined || (Array.isArray(ids) && ids.every(paneId)))) return false;
	if (
		v.floating !== undefined &&
		(!record(v.floating) ||
			!Object.entries(v.floating).every(
				([id, rect]) => paneId(id) && record(rect) && [rect.x, rect.y, rect.w, rect.h, rect.z].every(finite) && Number(rect.w) > 0 && Number(rect.h) > 0,
			))
	)
		return false;
	return v.lastFocus === undefined || (record(v.lastFocus) && Object.values(v.lastFocus).every(finite));
}
