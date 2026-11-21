/** The active tool list of a chat (from get_state.dumpTools), grouped into areas for permission editors. */
import { gateway } from "./gateway";

export interface ToolInfo {
	name: string;
	description: string;
}

const cache = new Map<string, Promise<ToolInfo[]>>();

export function fetchTools(chatId: string): Promise<ToolInfo[]> {
	let pending = cache.get(chatId);
	if (!pending) {
		pending = gateway
			.rpc<{ dumpTools?: ToolInfo[] }>(chatId, { type: "get_state" }, 30_000)
			.then(state => (state.dumpTools ?? []).map(t => ({ name: t.name, description: t.description ?? "" })))
			.catch(() => {
				cache.delete(chatId);
				return [];
			});
		cache.set(chatId, pending);
	}
	return pending;
}

/** omp built-ins when no chat is running to ask. */
export const FALLBACK_TOOLS: ToolInfo[] = [
	"read", "write", "edit", "ast_edit", "grep", "glob", "find", "ast_grep", "bash", "eval", "fetch", "web_search", "browser", "task", "ask", "todo",
].map(name => ({ name, description: "" }));

const AREAS: Array<{ area: string; test: (name: string) => boolean }> = [
	{ area: "Files: read", test: n => ["read", "grep", "glob", "find", "ast_grep", "lsp"].includes(n) },
	{ area: "Files: write", test: n => ["write", "edit", "ast_edit", "apply_patch", "notebook_edit"].includes(n) },
	{ area: "Shell & code", test: n => ["bash", "eval", "python", "ssh"].includes(n) },
	{ area: "Web", test: n => ["fetch", "web_search", "browser"].includes(n) || n.startsWith("browser") },
	{ area: "Agents & planning", test: n => ["task", "ask", "todo", "goal", "submit_plan", "job", "wait"].includes(n) },
];

export function groupTools(tools: ToolInfo[]): Array<{ area: string; tools: ToolInfo[] }> {
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const mcp = /^mcp__([^_]+(?:_[^_]+)*?)_/.exec(tool.name);
		const area = tool.name.startsWith("mcp__") ? `MCP: ${mcp?.[1] ?? "server"}` : (AREAS.find(a => a.test(tool.name))?.area ?? "Other");
		groups.set(area, [...(groups.get(area) ?? []), tool]);
	}
	const order = [...AREAS.map(a => a.area), "Other"];
	return [...groups.entries()]
		.sort((a, b) => {
			const ia = order.indexOf(a[0]);
			const ib = order.indexOf(b[0]);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
		})
		.map(([area, list]) => ({ area, tools: list }));
}
