import { Check, Copy, Download } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { api } from "../lib/gateway";
import { openFile, openImage } from "../store/actions";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";
import { THEMES } from "../lib/themes";

// ---------------------------------------------------------------- file links
// Batched existence checks for file paths mentioned in replies (so they can link to a file pane).

const PATH_RE = /^(?:\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$|^(?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\/?$/;

function looksLikePath(text: string): boolean {
	return text.length < 240 && !text.includes(" ") && !/^https?:/.test(text) && PATH_RE.test(text);
}

/** Strip a trailing :line[:col]. */
function splitLocation(text: string): { path: string; line?: number } {
	const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(text);
	return { path: m?.[1] ?? text, line: m?.[2] ? Number(m[2]) : undefined };
}

const cache = new Map<string, "file" | "dir" | null>();
const waiting = new Map<string, Array<(v: "file" | "dir" | null) => void>>();
const queue = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
	timer = undefined;
	for (const [projectId, paths] of queue) {
		queue.delete(projectId);
		const list = [...paths];
		void api<Record<string, "file" | "dir">>("/api/fs/stat", { method: "POST", body: JSON.stringify({ projectId, paths: list }) })
			.catch(() => ({}) as Record<string, "file" | "dir">)
			.then(result => {
				for (const path of list) {
					const key = `${projectId}|${path}`;
					const value = result[path] ?? null;
					cache.set(key, value);
					for (const resolve of waiting.get(key) ?? []) resolve(value);
					waiting.delete(key);
				}
			});
	}
}

function statPath(projectId: string, path: string): Promise<"file" | "dir" | null> {
	const key = `${projectId}|${path}`;
	if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
	return new Promise(resolve => {
		waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
		if (!queue.has(projectId)) queue.set(projectId, new Set());
		queue.get(projectId)?.add(path);
		timer ??= setTimeout(flush, 80);
	});
}


type Highlighter = (code: string, lang: string, theme: string) => Promise<string>;
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	highlighterPromise ??= import("shiki").then(shiki => async (code, lang, theme) => {
		const language = (shiki.bundledLanguages as Record<string, unknown>)[lang] ? lang : "text";
		return shiki.codeToHtml(code, { lang: language, theme });
	});
	return highlighterPromise;
}

const LANG_ALIASES: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", sh: "bash", shell: "bash", yml: "yaml", rs: "rust", md: "markdown" };

export function CopyButton({ text, label }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="gy-icon-btn"
			title={label ?? "Copy"}
			data-jump="copy"
			onClick={() => {
				void navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
		</button>
	);
}

function downloadText(text: string, filename: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
	const theme = useApp(s => s.theme);
	const language = LANG_ALIASES[lang ?? ""] ?? lang ?? "text";
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (language === "mermaid") return;
		const timer = setTimeout(() => {
			void getHighlighter()
				.then(highlight => highlight(code, language, THEMES[theme].scheme === "light" ? "github-light" : "github-dark-dimmed"))
				.then(result => !cancelled && setHtml(result))
				.catch(() => undefined);
		}, 60);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [code, language, theme]);

	if (language === "mermaid") return <MermaidBlock code={code} />;

	return (
		<div className="gy-code" data-jump-kind="code" data-jump-text={code.slice(0, 20000)}>
			<div className="gy-code-head">
				<span className="gy-label">{language}</span>
				<div className="flex gap-1">
					<button type="button" className="gy-icon-btn" title="Download" data-jump="download" onClick={() => downloadText(code, `snippet.${lang || "txt"}`)}>
						<Download size={14} />
					</button>
					<CopyButton text={code} />
				</div>
			</div>
			{html ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is generated from escaped text.
				<div dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre>
					<code>{code}</code>
				</pre>
			)}
		</div>
	);
});

let mermaidSeq = 0;
function MermaidBlock({ code }: { code: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const theme = useApp(s => s.theme);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void import("mermaid").then(async ({ default: mermaid }) => {
			mermaid.initialize({ startOnLoad: false, theme: THEMES[theme].scheme === "light" ? "default" : "dark", securityLevel: "strict" });
			try {
				const { svg } = await mermaid.render(`gy-mermaid-${++mermaidSeq}`, code);
				if (!cancelled && ref.current) ref.current.innerHTML = svg;
			} catch (e) {
				if (!cancelled) setError(String(e));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [code, theme]);
	return (
		<div className="gy-code">
			<div className="gy-code-head">
				<span className="gy-label">diagram</span>
				<CopyButton text={code} />
			</div>
			{error ? <pre className="gy-pre">{code}</pre> : <div ref={ref} className="flex justify-center p-3" />}
		</div>
	);
}

function FileLink({ text, chatId }: { text: string; chatId?: string }) {
	const projectId = useChats(s => (chatId ? s.chats[chatId]?.info.projectId : undefined));
	const [kind, setKind] = useState<"file" | "dir" | null>(null);
	const { path } = splitLocation(text);
	useEffect(() => {
		if (!projectId) return;
		let live = true;
		void statPath(projectId, path).then(k => live && setKind(k));
		return () => {
			live = false;
		};
	}, [projectId, path]);
	if (kind !== "file" || !projectId) return <code>{text}</code>;
	return (
		<code
			className="gy-file-link"
			role="link"
			tabIndex={0}
			title={`Open ${path}`}
			data-jump="file"
			data-jump-kind="file"
			data-jump-text={path}
			onClick={() => openFile(projectId, path.replace(/^\.\//, ""))}
			onKeyDown={e => e.key === "Enter" && openFile(projectId, path.replace(/^\.\//, ""))}
		>
			{text}
		</code>
	);
}

export const Markdown = memo(function Markdown({ text, streaming, chatId }: { text: string; streaming?: boolean; chatId?: string }) {
	return (
		<div className={`gy-md ${streaming ? "gy-streaming-caret" : ""}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noreferrer" data-jump-kind="link">
							{children}
						</a>
					),
					img: ({ src, alt }) =>
						typeof src === "string" ? (
							<button type="button" onClick={() => openImage(chatId, src, alt)} data-jump="image" data-jump-kind="image" data-jump-text={src}>
								<img src={src} alt={alt ?? ""} />
							</button>
						) : null,
					pre: ({ children }) => <>{children}</>,
					code: ({ className, children }) => {
						const match = /language-([\w+-]+)/.exec(className ?? "");
						const content = String(children ?? "");
						if (!match && !content.includes("\n")) {
							if (chatId && looksLikePath(content)) return <FileLink text={content} chatId={chatId} />;
							return <code>{children}</code>;
						}
						return <CodeBlock code={content.replace(/\n$/, "")} lang={match?.[1]} />;
					},
					table: ({ children }) => <TableBlock>{children}</TableBlock>,
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});

/** A table's text as Markdown or TSV (also used by jump-mark actions). */
export function tableText(table: HTMLTableElement, sep: "md" | "tsv"): string {
	const rows = [...table.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("th,td")].map(cell => (cell.textContent ?? "").trim()));
	return sep === "tsv"
		? rows.map(r => r.join("\t")).join("\n")
		: rows.map((r, i) => `| ${r.join(" | ")} |${i === 0 ? `\n|${r.map(() => " --- |").join("")}` : ""}`).join("\n");
}

function TableBlock({ children }: { children: React.ReactNode }) {
	const ref = useRef<HTMLTableElement>(null);
	const copyAs = (sep: "md" | "tsv") => ref.current && void navigator.clipboard.writeText(tableText(ref.current, sep));
	return (
		<div className="group relative inline-block max-w-full overflow-auto" data-jump-kind="table">
			<div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
				<button type="button" className="gy-btn" style={{ height: 22 }} onClick={() => copyAs("md")} data-jump="copy-md">
					MD
				</button>
				<button type="button" className="gy-btn" style={{ height: 22 }} onClick={() => copyAs("tsv")} data-jump="copy-tsv">
					TSV
				</button>
			</div>
			<table ref={ref}>{children}</table>
		</div>
	);
}
