/**
 * Loose structural types for omp payloads. The UI reads them defensively so
 * new upstream fields or roles render generically instead of breaking.
 */

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface ImageBlock {
	type: "image";
	data?: string;
	mimeType?: string;
	url?: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}
export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock | { type: string; [key: string]: unknown };

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number } | number;
}

export interface AgentMessage {
	role: string;
	content?: string | ContentBlock[];
	timestamp?: number;
	// assistant
	model?: string;
	provider?: string;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
	// toolResult
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	[key: string]: unknown;
}

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: string;
}

export interface ContextUsage {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
	[key: string]: unknown;
}

export interface SessionState {
	model?: { id: string; name?: string; provider: string; contextWindow?: number; [key: string]: unknown } | null;
	thinkingLevel?: string;
	thinkingLevels?: string[];
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	queuedMessageCount?: number;
	queuedMessages?: unknown;
	isSettled?: boolean;
	tokensPerSecond?: number | null;
	contextUsage?: ContextUsage | null;
	messageCount?: number;
	fastModeEnabled?: boolean;
	goal?: unknown;
	todoPhases?: Array<{ name?: string; tasks?: Array<{ content?: string; status?: string }> }>;
	[key: string]: unknown;
}

export interface SessionStats {
	tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	cost?: number;
	contextUsage?: ContextUsage;
	toolCalls?: number;
	[key: string]: unknown;
}

export interface ModelPickerRow {
	provider: string;
	id: string;
	name?: string;
	roles?: Array<{ role: string; label?: string }>;
	thinking?: string[];
	thinkingLevel?: string;
	current?: boolean;
	overContext?: boolean;
	role?: string;
	[key: string]: unknown;
}

export type UiRequest = {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	optionDetails?: Array<{ description?: string; [key: string]: unknown }>;
	initialIndex?: number;
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: number[];
	markableCount?: number;
	placeholder?: string;
	prefill?: string;
	secret?: boolean;
	questions?: AskQuestion[];
	html?: string;
	timeout?: number;
	[key: string]: unknown;
};

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string } | string>;
	multiSelect?: boolean;
	allowCustom?: boolean;
	[key: string]: unknown;
}

export function textOf(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (block.type === "text" ? (block as TextBlock).text : ""))
		.filter(Boolean)
		.join("\n");
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

export function formatTokens(n: number | undefined | null): string {
	if (n == null || !Number.isFinite(n)) return "–";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

export function contextPercent(usage: ContextUsage | null | undefined): number | null {
	if (!usage) return null;
	if (typeof usage.percent === "number") return usage.percent;
	if (usage.tokens != null && usage.contextWindow) return (usage.tokens / usage.contextWindow) * 100;
	return null;
}
