import { AlertTriangle, ChevronDown, ChevronRight, Info, Loader2, OctagonX } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import type { AgentMessage, ContentBlock, ThinkingBlock, ToolCallBlock } from "../lib/omp";
import { stripAnsi, textOf } from "../lib/omp";
import { forkAtMessage, openImage, viewMessage } from "../store/actions";
import { useChats, type ToolExecution, type TranscriptItem } from "../store/chats";
import { rendererFor, type ToolResultLike } from "../tools/registry";
import { CopyButton, Markdown } from "./Markdown";

export function time(ts?: number) {
	return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
}

/** Tinted card header: uppercase label on the left, "view · fork · time" cell on the right. */
export function CardHead({
	label,
	children,
	meta,
	onClick,
	jump,
}: {
	label: ReactNode;
	children?: ReactNode;
	meta?: ReactNode;
	onClick?: () => void;
	jump?: string;
}) {
	const left = (
		<>
			<span className="shrink-0">{label}</span>
			{children}
		</>
	);
	return (
		<div className="gy-card-head">
			{onClick ? (
				<button type="button" className="gy-card-label text-left" onClick={onClick} data-jump={jump ?? "toggle"}>
					{left}
				</button>
			) : (
				<div className="gy-card-label">{left}</div>
			)}
			{meta && <div className="gy-card-meta">{meta}</div>}
		</div>
	);
}

function Sep() {
	return <span aria-hidden>·</span>;
}

/** The right-hand action cell: view · review · fork · copy · time. */
function MessageMeta({ chatId, message, review, text }: { chatId?: string; message: AgentMessage; review?: boolean; text: string }) {
	const [error, setError] = useState<string | null>(null);
	return (
		<>
			{chatId && (
				<>
					<button type="button" onClick={() => viewMessage(chatId, message)} data-jump="view" title="Open in its own pane">
						view
					</button>
					<Sep />
					{review && (
						<>
							<button type="button" onClick={() => viewMessage(chatId, message, "review")} data-jump="review" title="Edit this reply and send it back">
								review
							</button>
							<Sep />
						</>
					)}
					{message.timestamp && (
						<>
							<button
								type="button"
								onClick={() => forkAtMessage(chatId, message).catch(e => setError(String((e as Error).message)))}
								data-jump="fork"
								title={error ?? "Fork the conversation here into a new pane"}
								style={error ? { color: "var(--err)" } : undefined}
							>
								fork
							</button>
							<Sep />
						</>
					)}
				</>
			)}
			<CopyButton text={text} />
			<span>{time(message.timestamp)}</span>
		</>
	);
}

function ImageThumb({ chatId, src, alt }: { chatId?: string; src: string; alt: string }) {
	return (
		<button type="button" onClick={() => openImage(chatId, src, alt)} data-jump="image" data-jump-kind="image" title="Open at actual size">
			<img alt={alt} src={src} className="max-h-72 border" style={{ borderColor: "var(--border-strong)" }} />
		</button>
	);
}

/** `readOnly`: no view · review · fork actions (a sub-agent's message is not in `chatId`'s session). */
export const UserCard = memo(function UserCard({ message, chatId, readOnly }: { message: AgentMessage; chatId?: string; readOnly?: boolean }) {
	const text = textOf(message.content);
	const images = Array.isArray(message.content) ? message.content.filter(b => b.type === "image") : [];
	if (message.synthetic && !text) return null;
	return (
		<div className="gy-card user">
			<CardHead label={message.steering ? "User · steer" : "User"} meta={<MessageMeta chatId={readOnly ? undefined : chatId} message={message} text={text} />} />
			<div className="gy-card-body">
				<div className="whitespace-pre-wrap break-words">{text}</div>
				{images.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-2">
						{images.map((img, i) => {
							const b = img as { data?: string; mimeType?: string };
							// biome-ignore lint/suspicious/noArrayIndexKey: positional
							return <ImageThumb key={i} chatId={chatId} src={`data:${b.mimeType};base64,${b.data}`} alt="attachment" />;
						})}
					</div>
				)}
			</div>
		</div>
	);
});

function ThinkingCard({ block, streaming }: { block: ThinkingBlock; streaming: boolean }) {
	const [open, setOpen] = useState(false);
	const text = block.thinking ?? "";
	if (!text.trim() && !streaming) return null;
	const preview = text.trim().split("\n").filter(Boolean).pop() ?? "";
	return (
		<div className="gy-card thinking">
			<CardHead label={<span className="flex items-center gap-1.5">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Thinking</span>} onClick={() => setOpen(o => !o)}>
				{streaming && <Loader2 size={12} className="animate-spin" />}
				{!open && (
					<span className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal tracking-normal normal-case italic" style={{ color: "var(--muted)" }}>
						{preview}
					</span>
				)}
			</CardHead>
			{open && (
				<div className="gy-card-body text-[12.5px]" style={{ color: "var(--text-dim)" }}>
					<Markdown text={text} />
				</div>
			)}
		</div>
	);
}

export function ToolCard({ call, exec, result, chatId }: { call: ToolCallBlock; exec?: ToolExecution; result?: AgentMessage; chatId?: string }) {
	const renderer = rendererFor(call.name);
	const running = exec?.status === "running" || (!exec && !result);
	const final: ToolResultLike | undefined = result
		? { content: result.content as ToolResultLike["content"], details: result.details, isError: result.isError }
		: (exec?.result as ToolResultLike | undefined);
	const isError = final?.isError || exec?.status === "error";
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? (isError === true || call.name === "edit" || call.name === "apply_patch" || call.name === "task" || call.name === "submit_plan");
	const args = (call.arguments ?? exec?.args ?? {}) as Record<string, unknown>;
	const props = { args, result: final, partial: exec?.partial as ToolResultLike | undefined, running, chatId, toolCallId: call.id };
	const Icon = renderer.icon;
	const duration = exec?.endedAt && exec.startedAt ? ((exec.endedAt - exec.startedAt) / 1000).toFixed(1) : null;
	const shell = call.name === "bash" || call.name === "eval";

	return (
		<div className={`gy-card tool ${shell ? "shell" : ""} ${isError ? "error" : ""}`}>
			<CardHead
				label={
					<span className="flex items-center gap-1.5">
						{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
						<Icon size={13} />
						{(renderer.label ?? call.name).replace(/_/g, " ")}
					</span>
				}
				onClick={() => setOpen(!expanded)}
				jump="tool"
				meta={
					<>
						{running ? <Loader2 size={12} className="animate-spin" /> : duration ? <span>{duration}s</span> : null}
						<span>{time(exec?.startedAt)}</span>
					</>
				}
			>
				<span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal tracking-normal normal-case" style={{ color: "var(--text-dim)" }}>
					{call.intent ? <span className="italic">{call.intent} · </span> : null}
					{renderer.summary(props)}
				</span>
			</CardHead>
			{expanded && renderer.body && <div className="gy-card-body">{renderer.body(props)}</div>}
		</div>
	);
}

export const AssistantMessage = memo(function AssistantMessage({
	message,
	streaming,
	toolExec,
	toolResults,
	chatId,
	readOnly,
	hideAbort,
}: {
	message: AgentMessage;
	streaming: boolean;
	toolExec: Record<string, ToolExecution>;
	toolResults: Record<string, AgentMessage>;
	chatId?: string;
	/** No view · review · fork actions; tool cards still use `chatId`. */
	readOnly?: boolean;
	/** The abort is internal control flow (e.g. the run ended after submit_plan): no "Turn aborted" card. */
	hideAbort?: boolean;
}) {
	const blocks = (Array.isArray(message.content) ? message.content : []) as ContentBlock[];
	const fullText = textOf(message.content);
	const failed = message.stopReason === "error" || (message.stopReason === "aborted" && !hideAbort);
	if (hideAbort && !failed && blocks.length === 0 && !streaming) return null;
	const firstTextIndex = blocks.findIndex(b => b.type === "text" && (b as { text: string }).text.trim());
	return (
		<div className="space-y-2.5">
			{blocks.map((block, i) => {
				if (block.type === "thinking") {
					return <ThinkingCard key={`t${i}`} block={block as ThinkingBlock} streaming={streaming && i === blocks.length - 1} />;
				}
				if (block.type === "toolCall") {
					const call = block as ToolCallBlock;
					return <ToolCard key={call.id || `c${i}`} call={call} exec={toolExec[call.id]} result={toolResults[call.id]} chatId={chatId} />;
				}
				if (block.type === "text") {
					const text = (block as { text: string }).text;
					if (!text.trim()) return null;
					return (
						<div key={`x${i}`} className="gy-card assistant">
							<CardHead
								label="Assistant"
								meta={i === firstTextIndex && !streaming ? <MessageMeta chatId={readOnly ? undefined : chatId} message={message} review text={fullText} /> : <span>{time(message.timestamp)}</span>}
							>
								{message.model && (
									<span className="truncate font-mono text-[10.5px] font-normal tracking-normal normal-case" style={{ color: "var(--muted)" }}>
										{message.model}
									</span>
								)}
							</CardHead>
							<div className="gy-card-body">
								<Markdown text={text} streaming={streaming && i === blocks.length - 1} chatId={chatId} />
							</div>
						</div>
					);
				}
				if (block.type === "image") {
					const b = block as { data?: string; mimeType?: string };
					return <ImageThumb key={`i${i}`} chatId={chatId} src={`data:${b.mimeType};base64,${b.data}`} alt="generated" />;
				}
				return null;
			})}
			{streaming && blocks.length === 0 && (
				<div className="flex items-center gap-2 px-1 text-[12px]" style={{ color: "var(--muted)" }}>
					<Loader2 size={13} className="animate-spin" /> Waiting for the model…
				</div>
			)}
			{failed && (
				<div className="gy-card error">
					<CardHead label={message.stopReason === "aborted" ? "Aborted" : "Error"} meta={<span>{time(message.timestamp)}</span>} />
					<div className="gy-card-body flex items-center gap-2 text-[12.5px]">
						<OctagonX size={14} style={{ color: "var(--err)" }} />
						{message.stopReason === "aborted" ? "Turn aborted" : String(message.errorMessage ?? "The model returned an error")}
					</div>
				</div>
			)}
		</div>
	);
});

export function GenericMessage({ message }: { message: AgentMessage }) {
	const [open, setOpen] = useState(false);
	const text = textOf(message.content) || (typeof message.output === "string" ? String(message.output) : "");
	const label = message.role.replace(/([A-Z])/g, " $1");
	return (
		<div className="gy-card notice">
			<CardHead
				label={<span className="flex items-center gap-1.5">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{label}</span>}
				onClick={() => setOpen(o => !o)}
				meta={<span>{time(message.timestamp)}</span>}
			>
				<span className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal tracking-normal normal-case" style={{ color: "var(--muted)" }}>
					{typeof message.command === "string" ? String(message.command) : text.split("\n")[0]}
				</span>
			</CardHead>
			{open && (
				<div className="gy-card-body">
					{text ? <Markdown text={text} /> : <pre className="gy-pre">{JSON.stringify(message, null, 2).slice(0, 8000)}</pre>}
				</div>
			)}
		</div>
	);
}

const NOTICE_PREVIEW_CHARS = 280;

export function NoticeCard({ item }: { item: Extract<TranscriptItem, { kind: "notice" }> }) {
	const [expanded, setExpanded] = useState(false);
	const clean = stripAnsi(item.message);
	const long = clean.length > NOTICE_PREVIEW_CHARS;
	const Icon = item.level === "error" ? OctagonX : item.level === "warning" ? AlertTriangle : Info;
	return (
		<div className={`gy-card notice ${item.level}`}>
			<CardHead label={<span className="flex items-center gap-1.5"><Icon size={13} />{item.level === "info" ? "Notice" : item.level}</span>} meta={<span>{time(item.ts)}</span>} />
			<div className="gy-card-body text-[12.5px]">
				<div className="min-w-0 whitespace-pre-wrap break-words">
					{long && !expanded ? `${clean.slice(0, NOTICE_PREVIEW_CHARS).trimEnd()}…` : clean}
					{long && (
						<button type="button" className="ml-2 text-[11.5px] underline" style={{ color: "var(--info)" }} onClick={() => setExpanded(e => !e)}>
							{expanded ? "Show less" : `Show all (${clean.length.toLocaleString()} chars)`}
						</button>
					)}
					{item.url && (
						<div className="mt-2 flex gap-2">
							<a className="gy-btn primary" href={item.url} target="_blank" rel="noreferrer" data-jump="open-url" data-jump-kind="link">
								Open link
							</a>
							<CopyButton text={item.url} label="Copy link" />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export function CommandOutputCard({ text, ts }: { text: string; ts?: number }) {
	const clean = stripAnsi(text);
	return (
		<div className="gy-card command">
			<CardHead
				label="Command output"
				meta={
					<>
						<CopyButton text={clean} />
						<span>{time(ts)}</span>
					</>
				}
			/>
			<div className="gy-card-body">
				<div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
					{clean}
				</div>
			</div>
		</div>
	);
}

export function EventRow({ label, detail }: { label: string; detail?: string }) {
	return (
		<div className="flex items-center gap-3 px-1 text-[11px]" style={{ color: "var(--muted)" }}>
			<div className="h-px flex-1" style={{ background: "var(--border)" }} />
			<span className="font-mono tracking-wider uppercase">
				{label}
				{detail ? ` · ${detail}` : ""}
			</span>
			<div className="h-px flex-1" style={{ background: "var(--border)" }} />
		</div>
	);
}

/** Live status of the chat's plan, shown inline while plan mode is on. */
export function PlanBanner({ chatId }: { chatId: string }) {
	const plan = useChats(s => s.chats[chatId]?.plan);
	if (!plan || plan.phase === "idle") return null;
	const label = { planning: "Plan mode · planning", reviewing: "Plan mode · waiting for your review", executing: "Plan approved · executing", idle: "" }[plan.phase];
	return (
		<div className="gy-card plan">
			<CardHead label={label}>
				{plan.title && <span className="truncate font-sans text-[12.5px] font-normal tracking-normal normal-case">{plan.title}</span>}
			</CardHead>
		</div>
	);
}
