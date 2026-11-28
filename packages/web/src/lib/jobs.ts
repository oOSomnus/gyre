/** Background jobs across chats, for the Jobs pane, Task Manager and status lights. */
import type { JobInfo } from "@gyre/protocol";
import { textOf } from "./omp";
import type { ChatState } from "../store/chats";

export interface ChatJob extends JobInfo {
	chatId: string;
}

/** Every chat's jobs, running ones first, newest first within each group. */
export function allJobs(chats: Record<string, ChatState>): ChatJob[] {
	const jobs: ChatJob[] = [];
	for (const [chatId, chat] of Object.entries(chats)) for (const job of chat.jobs ?? []) jobs.push({ ...job, chatId });
	return jobs.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startTime - a.startTime);
}

export const runningJobCount = (chats: Record<string, ChatState>) =>
	Object.values(chats).reduce((n, chat) => n + (chat.jobs ?? []).filter(j => j.status === "running").length, 0);

/** The result omp delivered to the transcript for a settled job (`async-result` message), if any. */
export function jobResult(chat: ChatState | undefined, jobId: string): string | undefined {
	if (!chat) return undefined;
	for (let i = chat.items.length - 1; i >= 0; i--) {
		const item = chat.items[i];
		if (item?.kind !== "message" || item.message.customType !== "async-result") continue;
		const details = item.message.details as { jobId?: unknown; jobs?: Array<{ jobId?: unknown }> } | undefined;
		if (details?.jobId === jobId || details?.jobs?.some(j => j.jobId === jobId)) return textOf(item.message.content);
	}
	return undefined;
}

export function duration(job: JobInfo, now = Date.now()): string {
	const s = Math.max(0, Math.floor(((job.endTime ?? now) - job.startTime) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
