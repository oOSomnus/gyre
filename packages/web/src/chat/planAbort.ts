import type { AgentMessage, ContentBlock, ToolCallBlock } from "../lib/omp";
import type { TranscriptItem } from "../store/chats";

/** Gyre's plan-mode tool (packages/omp-extension). */
export const SUBMIT_PLAN_TOOL = "submit_plan";

function hasVisibleContent(message: AgentMessage): boolean {
	if (typeof message.content === "string") return message.content.trim().length > 0;
	if (!Array.isArray(message.content)) return false;
	return message.content.some((block: ContentBlock) => {
		if (block.type === "text") return String((block as { text?: unknown }).text ?? "").trim().length > 0;
		if (block.type === "thinking") return String((block as { thinking?: unknown }).thinking ?? "").trim().length > 0;
		return true;
	});
}

/**
 * The plan extension ends the run right after a successful `submit_plan` (as omp's
 * TUI does), and omp records that as an empty aborted assistant message. It is
 * control flow, not a failure, so its "Turn aborted" card is hidden.
 */
export function isPlanSubmitAbort(items: TranscriptItem[], index: number, toolResults: Record<string, AgentMessage>): boolean {
	const item = items[index];
	if (item?.kind !== "message") return false;
	const message = item.message;
	if (message.role !== "assistant" || message.stopReason !== "aborted" || hasVisibleContent(message)) return false;
	for (let i = index - 1; i >= 0; i--) {
		const previous = items[i];
		// Notices and events can sit between the submission and its abort; tool results belong to the call.
		if (previous?.kind !== "message" || previous.message.role === "toolResult") continue;
		// A user prompt or a custom message (feedback, reminder) starts a new run: stop there.
		if (previous.message.role !== "assistant") return false;
		const blocks = Array.isArray(previous.message.content) ? previous.message.content : [];
		const call = blocks.filter((block): block is ToolCallBlock => block.type === "toolCall").at(-1);
		if (call?.name !== SUBMIT_PLAN_TOOL) return false;
		const result = toolResults[call.id];
		if (!result || result.isError) return false;
		return (result.details as { ok?: unknown } | undefined)?.ok === true;
	}
	return false;
}
