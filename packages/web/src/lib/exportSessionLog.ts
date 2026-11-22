import { gateway } from "./gateway";
import { downloadText } from "./download";
import type { AgentMessage } from "./omp";
import { buildSessionLog } from "./sessionLog";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";

function notice(chatId: string, level: "info" | "error", message: string): void {
	useChats.getState().apply(chatId, { type: "notice", level, message });
}

function stamp(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "chat"
	);
}

/** Collect the chat's history and Gyre state into a Markdown debug log, then download or copy it. */
export async function exportSessionLog(chatId: string, mode: "download" | "copy"): Promise<void> {
	const chat = useChats.getState().chats[chatId];
	if (!chat) return;
	try {
		const warnings: string[] = [];
		const [history, state] = await Promise.allSettled([
			gateway.rpc<{ messages?: AgentMessage[] } | AgentMessage[]>(chatId, { type: "get_messages" }, 60_000),
			gateway.rpc<unknown>(chatId, { type: "get_state" }, 15_000),
		]);
		let messages: AgentMessage[];
		if (history.status === "fulfilled") {
			const data = history.value;
			messages = Array.isArray(data) ? data : (data?.messages ?? []);
		} else {
			warnings.push(`get_messages failed (${String((history.reason as Error)?.message ?? history.reason)}); the transcript below is what this client had loaded.`);
			messages = chat.items.flatMap(item => (item.kind === "message" ? [item.message] : []));
		}
		if (state.status === "rejected") warnings.push(`get_state failed (${String((state.reason as Error)?.message ?? state.reason)}).`);

		// Re-read after the awaits so UI events and frames are current.
		const latest = useChats.getState().chats[chatId] ?? chat;
		const project = useApp.getState().projects.find(p => p.id === latest.info.projectId);
		const exportedAt = Date.now();
		const text = buildSessionLog({
			exportedAt,
			chatId,
			projectName: project?.name,
			info: latest.info,
			state: state.status === "fulfilled" ? state.value : undefined,
			plan: latest.plan,
			messages,
			items: latest.items,
			toolExec: latest.toolExec,
			widgets: latest.widgets,
			statuses: latest.statuses,
			pendingUi: latest.pendingUi,
			queue: latest.queue,
			frames: latest.frames,
			userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
			warnings,
		});

		if (mode === "copy") {
			await navigator.clipboard.writeText(text);
			notice(chatId, "info", `Session log copied to the clipboard (${messages.length} messages, ${Math.round(text.length / 1024)} KB).`);
		} else {
			const base = project?.name ?? latest.info.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "chat";
			const filename = `gyre-session-${slug(base)}-${stamp(exportedAt)}.md`;
			downloadText(text, filename, "text/markdown");
			notice(chatId, "info", `Session log saved as ${filename} (${messages.length} messages).`);
		}
	} catch (error) {
		notice(chatId, "error", `Session log export failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
