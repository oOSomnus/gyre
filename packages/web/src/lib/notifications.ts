/**
 * What deserves a notification, from one chat-store state to the next: a chat newly
 * needing the user, a run finishing or failing, a plan waiting for review, a background
 * job settling, and warnings or errors the agent or an extension reported. Pure, so the
 * transitions are testable; the store and the UI live in `store/notifications.ts`.
 */
import type { ChatState } from "../store/chats";

export type NotificationKind = "needs-you" | "done" | "error" | "plan" | "job" | "warning";

export interface NotificationDraft {
	kind: NotificationKind;
	chatId: string;
	title: string;
	body?: string;
	/** A hook or extension file the notification is about (opens Hook Studio for hooks). */
	extensionPath?: string;
	/** Dedupe key: the same event replayed after a reconnect is not raised twice. */
	key: string;
}

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function lastAssistant(chat: ChatState) {
	for (let i = chat.items.length - 1; i >= 0; i--) {
		const item = chat.items[i];
		if (item?.kind === "message" && item.message.role === "assistant") return item.message;
	}
	return undefined;
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
		.map(b => b.text)
		.join(" ")
		.trim();
}

/** Notices older than this are history (a transcript reload), not news. */
const FRESH_MS = 15_000;

/** Notifications for the transitions from `prev` to `next`. `name(chatId)` labels a chat. */
export function detectNotifications(
	prev: Record<string, ChatState>,
	next: Record<string, ChatState>,
	name: (chatId: string) => string,
	now = Date.now(),
): NotificationDraft[] {
	const out: NotificationDraft[] = [];
	for (const [chatId, chat] of Object.entries(next)) {
		const before = prev[chatId];
		if (!before || before === chat) continue;
		const label = name(chatId);

		const seen = new Set(before.pendingUi.map(r => r.id));
		for (const request of chat.pendingUi) {
			if (seen.has(request.id)) continue;
			out.push({ kind: "needs-you", chatId, title: `${label} needs you`, body: short(String(request.title ?? request.message ?? "A question is waiting")), key: `ui:${chatId}:${request.id}` });
		}

		if (before.busy && !chat.busy) {
			const last = lastAssistant(chat);
			const failed = last?.stopReason === "error";
			out.push({
				kind: failed ? "error" : "done",
				chatId,
				title: failed ? `${label} stopped with an error` : `${label} finished`,
				body: short(failed ? String(last?.errorMessage ?? "The request failed") : assistantText(last?.content) || "The agent is waiting for you."),
				key: `run:${chatId}:${chat.items.length}`,
			});
		}

		if (chat.plan?.phase === "reviewing" && (before.plan?.phase !== "reviewing" || before.plan?.revision !== chat.plan.revision)) {
			out.push({ kind: "plan", chatId, title: `${label}: a plan is ready for review`, body: chat.plan.title, key: `plan:${chatId}:${chat.plan.revision ?? 0}` });
		}

		const running = new Set((before.jobs ?? []).filter(j => j.status === "running").map(j => j.id));
		for (const job of chat.jobs ?? []) {
			if (!running.has(job.id) || job.status === "running") continue;
			out.push({
				kind: job.status === "failed" ? "error" : "job",
				chatId,
				title: `Background job ${job.status}`,
				body: short(job.intent ?? job.label),
				key: `job:${chatId}:${job.id}`,
			});
		}

		for (const item of chat.items.slice(before.items.length)) {
			if (item.kind !== "notice" || item.level === "info" || now - item.ts > FRESH_MS) continue;
			out.push({
				kind: item.level === "error" ? "error" : "warning",
				chatId,
				title: item.extensionPath ? `${label}: a hook or extension failed` : item.level === "error" ? `${label}: error` : `${label}: warning`,
				body: short(item.message, 240),
				extensionPath: item.extensionPath,
				key: `notice:${chatId}:${item.key}`,
			});
		}
	}
	return out;
}

/** `scope:phase:name` for Hook Studio when `path` is an omp hook file, else undefined. */
export function hookTarget(path: string | undefined, projectPath?: string): string | undefined {
	const match = path?.match(/^(.*)\/hooks\/(pre|post)\/([^/]+)$/);
	if (!match) return undefined;
	const scope = projectPath && match[1] === `${projectPath}/.omp` ? "project" : "user";
	return `${scope}:${match[2]}:${match[3]}`;
}
