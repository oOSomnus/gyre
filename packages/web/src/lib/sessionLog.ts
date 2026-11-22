/**
 * Builds a Markdown debug log of one chat: omp's full message history (hidden
 * custom messages included), Gyre's plan and UI state, and the raw frame tail.
 * Meant to be handed to a model or a developer to diagnose a session.
 * Pure: no store or network access, so it is unit-tested directly.
 */
import type { ChatInfo, OmpFrame, PlanState } from "@gyre/protocol";
import type { AgentMessage, ContentBlock, ToolCallBlock, UiRequest } from "./omp";
import type { ToolExecution, TranscriptItem } from "../store/chats";

export const PAYLOAD_LIMIT = 8_000;
export const FRAME_LIMIT = 500;
export const MAX_LOG_FRAMES = 200;

export interface SessionLogInput {
	exportedAt: number;
	chatId: string;
	projectName?: string;
	info: ChatInfo;
	/** omp `get_state` result, when it could be read. */
	state?: unknown;
	plan: PlanState | null;
	messages: AgentMessage[];
	items: TranscriptItem[];
	toolExec: Record<string, ToolExecution>;
	widgets: Record<string, { lines: string[]; placement?: string }>;
	statuses: Record<string, string>;
	pendingUi: UiRequest[];
	queue: { steering: string[]; followUp: string[] };
	frames: Array<{ ts: number; frame: OmpFrame }>;
	userAgent?: string;
	/** Problems hit while collecting the log (e.g. history could not be re-read). */
	warnings?: string[];
}

/** Keep the head and tail of long text. */
export function clip(text: string, limit = PAYLOAD_LIMIT): string {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.6);
	const tail = limit - head;
	return `${text.slice(0, head)}\n… [${text.length - limit} chars omitted] …\n${text.slice(text.length - tail)}`;
}

/** A fenced block whose fence is longer than any backtick run inside the content. */
export function fence(content: string, lang = ""): string {
	const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${content}\n${ticks}`;
}

function json(value: unknown, limit = PAYLOAD_LIMIT): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	return clip(text, limit);
}

function iso(ts: unknown): string {
	return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : "?";
}

function quote(text: string): string {
	return text
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
}

function imageNote(block: { mimeType?: unknown; data?: unknown }): string {
	const size = typeof block.data === "string" ? Math.round((block.data.length * 3) / 4 / 1024) : 0;
	return `[image omitted: ${String(block.mimeType ?? "unknown")}, ~${size} KB]`;
}

function renderBlocks(content: AgentMessage["content"], toolExec: Record<string, ToolExecution>): string[] {
	if (typeof content === "string") return content.trim() ? [fence(clip(content))] : [];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content as ContentBlock[]) {
		switch (block.type) {
			case "text": {
				const text = String((block as { text?: unknown }).text ?? "");
				if (text.trim()) out.push(fence(clip(text)));
				break;
			}
			case "thinking": {
				const thinking = String((block as { thinking?: unknown }).thinking ?? "");
				if ((block as { redacted?: boolean }).redacted) out.push("> _(thinking redacted)_");
				else if (thinking.trim()) out.push(`**thinking**\n\n${quote(clip(thinking))}`);
				break;
			}
			case "toolCall": {
				const call = block as ToolCallBlock;
				const exec = toolExec[call.id];
				const timing = exec ? ` · ${exec.status} · ${iso(exec.startedAt)}${exec.endedAt ? ` → ${iso(exec.endedAt)} (${((exec.endedAt - exec.startedAt) / 1000).toFixed(1)}s)` : ""}` : "";
				out.push(`**tool call** \`${call.name}\` (${call.id})${call.intent ? ` · intent: ${call.intent}` : ""}${timing}\n\n${fence(json(call.arguments), "json")}`);
				break;
			}
			case "image":
				out.push(imageNote(block as { mimeType?: unknown; data?: unknown }));
				break;
			default:
				out.push(`**${block.type} block**\n\n${fence(json(block), "json")}`);
		}
	}
	return out;
}

function renderMessage(message: AgentMessage, n: number, toolExec: Record<string, ToolExecution>): string {
	const head = [`### #${n} · ${message.role}`, iso(message.timestamp)];
	if (message.model) head.push(message.provider ? `${message.provider}/${message.model}` : message.model);
	if (message.stopReason) head.push(`stop: ${message.stopReason}`);
	const customType = typeof message.customType === "string" ? message.customType : undefined;
	if (customType) head.push(`custom: ${customType}`);
	if (message.display === false) head.push("(hidden from UI)");
	const parts = [head.join(" · ")];
	if (message.errorMessage) parts.push(`**error:** ${clip(String(message.errorMessage), 2_000)}`);
	if (message.role === "toolResult") parts.push(`**tool result** \`${message.toolName ?? "?"}\` (${message.toolCallId ?? "?"})${message.isError ? " · **isError**" : ""}`);
	parts.push(...renderBlocks(message.content, toolExec));
	if (message.role === "toolResult" && message.details !== undefined) parts.push(`**details**\n\n${fence(json(message.details), "json")}`);
	if (message.role === "assistant" && message.usage) parts.push(`usage: \`${JSON.stringify(message.usage)}\``);
	return parts.join("\n\n");
}

function renderItem(item: TranscriptItem): string | undefined {
	switch (item.kind) {
		case "notice":
			return `- ${iso(item.ts)} · notice/${item.level}: ${clip(item.message, 2_000)}${item.url ? ` (${item.url})` : ""}`;
		case "event":
			return `- ${iso(item.ts)} · event: ${item.label}${item.detail ? ` (${clip(item.detail, 1_000)})` : ""}`;
		case "command_output":
			return `- ${iso(item.ts)} · command output:\n\n${fence(clip(item.text, 4_000))}`;
		default:
			return undefined;
	}
}

export function buildSessionLog(input: SessionLogInput): string {
	const state = (input.state ?? {}) as Record<string, unknown>;
	const model = state.model as { provider?: string; id?: string } | undefined;
	const out: string[] = [];

	out.push("# Gyre session log");
	const header = [
		`- Exported: ${iso(input.exportedAt)}`,
		`- Chat: ${input.chatId}${input.projectName ? ` · project ${input.projectName}` : ""}`,
		`- cwd: ${input.info.cwd || "?"}`,
		`- Session file: ${String(state.sessionFile ?? input.info.sessionPath ?? "?")}`,
		`- omp status: ${input.info.status}${input.info.busy ? " (busy)" : ""} · generation ${input.info.generation ?? "?"}${input.info.error ? ` · error: ${input.info.error}` : ""}`,
		`- Model: ${model?.provider && model.id ? `${model.provider}/${model.id}` : "?"} · thinking ${String(state.thinkingLevel ?? "?")}`,
		`- Messages: ${input.messages.length}`,
	];
	if (input.userAgent) header.push(`- Client: ${input.userAgent}`);
	out.push(header.join("\n"));
	out.push("> Hidden per-turn plan-mode context (`gyre-plan-context`) is injected at request time and isn't part of the stored history.");
	if (input.warnings?.length) out.push(input.warnings.map(w => `> **warning:** ${w}`).join("\n"));

	out.push("## Plan state");
	if (input.plan) {
		const { planContent, ...rest } = input.plan;
		out.push(fence(json(rest), "json"));
		if (planContent) out.push(`Plan content (revision ${input.plan.revision}):\n\n${fence(clip(planContent), "markdown")}`);
	} else {
		out.push("_No plan state._");
	}

	out.push("## Transcript");
	if (input.messages.length === 0) out.push("_No messages._");
	input.messages.forEach((message, i) => out.push(renderMessage(message, i + 1, input.toolExec)));

	out.push("## Gyre UI events");
	const events = input.items
		.filter(item => item.kind !== "message")
		.sort((a, b) => ("ts" in a ? a.ts : 0) - ("ts" in b ? b.ts : 0))
		.map(renderItem)
		.filter((line): line is string => Boolean(line));
	out.push(events.length ? events.join("\n") : "_None in this client session._");

	out.push("## UI state");
	const ui: string[] = [];
	for (const [key, widget] of Object.entries(input.widgets)) ui.push(`- widget \`${key}\`${widget.placement ? ` (${widget.placement})` : ""}:\n\n${fence(clip(widget.lines.join("\n"), 4_000))}`);
	for (const [key, value] of Object.entries(input.statuses)) ui.push(`- status \`${key}\`: ${clip(value, 500)}`);
	for (const request of input.pendingUi) ui.push(`- pending dialog: ${request.method}${request.title ? ` · ${request.title}` : ""} (${request.id})`);
	for (const text of input.queue.steering) ui.push(`- queued steer: ${clip(text, 1_000)}`);
	for (const text of input.queue.followUp) ui.push(`- queued follow-up: ${clip(text, 1_000)}`);
	out.push(ui.length ? ui.join("\n") : "_Empty._");

	const frames = input.frames.slice(-MAX_LOG_FRAMES);
	out.push(`## Raw omp frames (last ${frames.length} of ${input.frames.length} kept by this client)`);
	if (frames.length) {
		const lines = frames.map(({ ts, frame }) => {
			let body: string;
			try {
				body = JSON.stringify(frame);
			} catch {
				body = String(frame);
			}
			return `${iso(ts)}  ${frame.type}  ${clip(body, FRAME_LIMIT).replace(/\n/g, " ")}`;
		});
		out.push(fence(lines.join("\n")));
	} else {
		out.push("_None._");
	}

	return `${out.join("\n\n")}\n`;
}
