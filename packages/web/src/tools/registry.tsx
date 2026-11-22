/**
 * Tool card renderers, keyed by omp wire tool name. Unknown tools use the
 * generic renderer, so tools added upstream still render (args + output).
 * Renderers must tolerate partial / malformed args while a call streams.
 */
import {
	Bot,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	ListTodo,
	MessageCircleQuestion,
	Search,
	SquareTerminal,
	Wrench,
	type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { ClipboardList } from "lucide-react";
import { CodeBlock } from "../chat/Markdown";
import { SubagentCards } from "../chat/SubagentCard";
import { openChatPane } from "../store/app";
import { stripAnsi } from "../lib/omp";

export interface ToolResultLike {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface ToolRenderProps {
	args: Record<string, unknown>;
	result?: ToolResultLike;
	partial?: ToolResultLike;
	running: boolean;
	chatId?: string;
	toolCallId?: string;
}

export interface ToolRenderer {
	icon: LucideIcon;
	label?: string;
	summary(props: ToolRenderProps): ReactNode;
	body?(props: ToolRenderProps): ReactNode;
}

// ---------- helpers ----------
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function resultText(result?: ToolResultLike): string {
	if (!result?.content) return "";
	return stripAnsi(
		result.content
			.map(block => (block.type === "text" ? (block.text ?? "") : ""))
			.filter(Boolean)
			.join("\n"),
	);
}

function ResultImages({ result }: { result?: ToolResultLike }) {
	const images = result?.content?.filter(block => block.type === "image" && block.data) ?? [];
	if (images.length === 0) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{images.map((image, i) => (
				<img
					// biome-ignore lint/suspicious/noArrayIndexKey: static list
					key={i}
					alt="tool output"
					src={`data:${image.mimeType ?? "image/png"};base64,${image.data}`}
					className="max-h-80 rounded border"
					style={{ borderColor: "var(--border)" }}
				/>
			))}
		</div>
	);
}

export function Output({ text, max = 6000, tail = false }: { text: string; max?: number; tail?: boolean }) {
	if (!text) return null;
	const clipped = text.length > max ? (tail ? `…\n${text.slice(-max)}` : `${text.slice(0, max)}\n…`) : text;
	return <pre className="gy-pre">{clipped}</pre>;
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
	if (children == null || children === "" || children === false) return null;
	return (
		<div className="flex gap-2 text-[12px]">
			<span className="gy-label w-16 shrink-0 pt-[2px]">{k}</span>
			<span className="min-w-0 break-all" style={{ color: "var(--text-dim)" }}>
				{children}
			</span>
		</div>
	);
}

export function DiffView({ diff, max = 400 }: { diff: string; max?: number }) {
	const lines = diff.split("\n");
	const shown = lines.slice(0, max);
	return (
		<pre className="gy-pre" style={{ padding: 0 }}>
			{shown.map((line, i) => {
				const cls =
					line.startsWith("+") && !line.startsWith("+++")
						? "gy-diff-add"
						: line.startsWith("-") && !line.startsWith("---")
							? "gy-diff-del"
							: line.startsWith("@@")
								? "gy-diff-hunk"
								: "";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
					<div key={i} className={`px-2 ${cls}`}>
						{line || " "}
					</div>
				);
			})}
			{lines.length > max && (
				<div className="px-2" style={{ color: "var(--muted)" }}>
					… {lines.length - max} more lines
				</div>
			)}
		</pre>
	);
}

function extOf(path: string | null): string | undefined {
	const m = path ? /\.([a-z0-9]+)$/i.exec(path) : null;
	return m?.[1]?.toLowerCase();
}

const pathArg = (args: Record<string, unknown>) => str(args.path) ?? str(args.file_path) ?? str(args.filePath);

// ---------- renderers ----------
const generic: ToolRenderer = {
	icon: Wrench,
	summary: ({ args }) => {
		const firstString = Object.values(args).find(v => typeof v === "string") as string | undefined;
		return firstString ? truncate(oneLine(firstString), 90) : "";
	},
	body: ({ args, result, partial }) => (
		<div className="space-y-2">
			{Object.keys(args).length > 0 && <CodeBlock code={JSON.stringify(args, null, 2)} lang="json" />}
			<Output text={resultText(result ?? partial)} />
			<ResultImages result={result ?? partial} />
		</div>
	),
};

const bash: ToolRenderer = {
	icon: SquareTerminal,
	label: "shell",
	summary: ({ args }) => <span className="font-mono">{truncate(oneLine(str(args.command) ?? "…"), 100)}</span>,
	body: ({ args, result, partial, running }) => {
		const details = rec(result?.details);
		const exit = details?.exitCode;
		return (
			<div className="space-y-2">
				<pre className="gy-pre">
					<span style={{ color: "var(--highlight)" }}>$ </span>
					{str(args.command) ?? ""}
				</pre>
				<Kv k="cwd">{str(args.cwd)}</Kv>
				<Output text={resultText(result ?? partial)} tail max={8000} />
				{!running && typeof exit === "number" && (
					<div className="gy-label" style={{ color: exit === 0 ? "var(--ok)" : "var(--err)" }}>
						exit {exit}
					</div>
				)}
			</div>
		);
	},
};

const read: ToolRenderer = {
	icon: FileText,
	summary: ({ args }) => <span className="font-mono">{pathArg(args) ?? "…"}</span>,
	body: ({ args, result }) => {
		const text = resultText(result);
		const path = pathArg(args);
		return text ? <CodeBlock code={text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text} lang={extOf(path)} /> : null;
	},
};

const write: ToolRenderer = {
	icon: FilePlus,
	summary: ({ args }) => <span className="font-mono">{pathArg(args) ?? "…"}</span>,
	body: ({ args, result }) => {
		const content = str(args.content);
		return (
			<div className="space-y-2">
				{content != null && <CodeBlock code={content.length > 20000 ? `${content.slice(0, 20000)}\n…` : content} lang={extOf(pathArg(args))} />}
				{result?.isError && <Output text={resultText(result)} />}
			</div>
		);
	},
};

const edit: ToolRenderer = {
	icon: FilePen,
	summary: ({ args }) => {
		const path = pathArg(args) ?? (str(args.input) ?? "").match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1] ?? null;
		return <span className="font-mono">{path ?? "…"}</span>;
	},
	body: ({ args, result }) => {
		const details = rec(result?.details);
		const diffs: Array<{ path?: string; diff: string }> = [];
		if (details && Array.isArray(details.perFileResults)) {
			for (const entry of details.perFileResults) {
				const r = rec(entry);
				const diff = str(r?.diff);
				if (diff) diffs.push({ path: str(r?.path) ?? undefined, diff });
			}
		}
		const top = str(details?.diff);
		if (top) diffs.push({ diff: top });
		if (diffs.length === 0) {
			const input = str(args.input) ?? str(args._input);
			return (
				<div className="space-y-2">
					{input ? <DiffView diff={input} /> : <CodeBlock code={JSON.stringify(args, null, 2)} lang="json" />}
					<Output text={resultText(result)} />
				</div>
			);
		}
		return (
			<div className="space-y-2">
				{diffs.map((d, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional
					<div key={i}>
						{d.path && <div className="gy-label mb-1">{d.path}</div>}
						<DiffView diff={d.diff} />
					</div>
				))}
				{result?.isError && <Output text={resultText(result)} />}
			</div>
		);
	},
};

const grep: ToolRenderer = {
	icon: Search,
	summary: ({ args }) => (
		<span className="font-mono">
			{truncate(str(args.pattern) ?? "…", 60)}
			{str(args.path) && <span style={{ color: "var(--muted)" }}> in {str(args.path)}</span>}
		</span>
	),
	body: ({ result }) => <Output text={resultText(result)} />,
};

const glob: ToolRenderer = {
	icon: FolderSearch,
	summary: ({ args }) => <span className="font-mono">{str(args.pattern) ?? str(args.glob) ?? pathArg(args) ?? "…"}</span>,
	body: ({ result }) => <Output text={resultText(result)} />,
};

const web: ToolRenderer = {
	icon: Globe,
	summary: ({ args }) => <span className="font-mono">{truncate(str(args.url) ?? str(args.query) ?? "…", 90)}</span>,
	body: ({ result }) => <Output text={resultText(result)} max={5000} />,
};

const task: ToolRenderer = {
	icon: Bot,
	label: "agents",
	summary: ({ args }) => {
		const tasks = Array.isArray(args.tasks) ? args.tasks : [];
		const first = rec(tasks[0]);
		return tasks.length > 0
			? `${tasks.length} task${tasks.length === 1 ? "" : "s"}${first ? ` · ${truncate(oneLine(String(first.description ?? first.agent ?? "")), 60)}` : ""}`
			: truncate(oneLine(str(args.description) ?? str(args.prompt) ?? ""), 80);
	},
	body: ({ args, result, partial, chatId, toolCallId }) => {
		const tasks = (Array.isArray(args.tasks) ? args.tasks : []).map(rec).filter(Boolean) as Record<string, unknown>[];
		const fallback = (
			<div className="space-y-2">
				{tasks.map((t, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional
					<div key={i} className="rounded border p-2" style={{ borderColor: "var(--border)" }}>
						<div className="flex items-center gap-2">
							<span className="gy-chip">{String(t.agent ?? "task")}</span>
							<span className="text-[12.5px]">{String(t.description ?? "")}</span>
						</div>
						{str(t.assignment) && (
							<div className="mt-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
								{truncate(String(t.assignment), 400)}
							</div>
						)}
					</div>
				))}
			</div>
		);
		return (
			<div className="space-y-2">
				{chatId && toolCallId ? <SubagentCards chatId={chatId} toolCallId={toolCallId} fallback={fallback} /> : fallback}
				<Output text={resultText(result ?? partial)} max={8000} />
			</div>
		);
	},
};

const todo: ToolRenderer = {
	icon: ListTodo,
	summary: ({ args }) => {
		const ops = Array.isArray(args.ops) ? args.ops.length : args.op ? 1 : 0;
		return ops ? `${ops} update${ops === 1 ? "" : "s"}` : "";
	},
	body: ({ result }) => <Output text={resultText(result)} />,
};

const ask: ToolRenderer = {
	icon: MessageCircleQuestion,
	summary: ({ args }) => {
		const questions = Array.isArray(args.questions) ? args.questions : [];
		const q = rec(questions[0]);
		return truncate(oneLine(String(q?.question ?? args.question ?? "")), 90);
	},
	body: ({ result }) => <Output text={resultText(result)} />,
};

const submitPlan: ToolRenderer = {
	icon: ClipboardList,
	label: "submit plan",
	summary: ({ args }) => <span>{str(args.title) ?? str(args.plan) ?? ""}</span>,
	body: ({ result, chatId }) => (
		<div className="flex items-center gap-2">
			<span className="text-[12.5px]">{resultText(result) || "Submitting…"}</span>
			{chatId && (
				<button type="button" className="gy-btn ml-auto" onClick={() => openChatPane("plan", chatId)} data-jump="open-plan">
					Open review
				</button>
			)}
		</div>
	),
};

const RENDERERS: Record<string, ToolRenderer> = {
	submit_plan: submitPlan,
	bash,
	read,
	write,
	edit,
	apply_patch: edit,
	ast_edit: edit,
	grep,
	ast_grep: grep,
	glob,
	find: glob,
	fetch: web,
	web_search: web,
	task,
	todo,
	ask,
};

export function rendererFor(toolName: string): ToolRenderer {
	return Object.hasOwn(RENDERERS, toolName) ? RENDERERS[toolName]! : generic;
}
