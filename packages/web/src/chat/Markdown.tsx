import { Check, Copy, Download } from "lucide-react";
import { createContext, useContext, memo, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

const cache = new Map<string, { value: "file" | "dir" | null; expires: number }>();
const waiting = new Map<string, Array<(v: "file" | "dir" | null) => void>>();
const queue = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
	timer = undefined;
	for (const [projectId, paths] of queue) {
		queue.delete(projectId);
		const list = [...paths];
		for (let offset = 0; offset < list.length; offset += 200) {
			const chunk = list.slice(offset, offset + 200);
			void api<Record<string, "file" | "dir">>("/api/fs/stat", { method: "POST", body: JSON.stringify({ projectId, paths: chunk }) })
				.then(result => {
					for (const path of chunk) {
						const key = `${projectId}|${path}`;
						const value = result[path] ?? null;
						cache.delete(key);
						cache.set(key, { value, expires: Date.now() + 5000 });
						if (cache.size > 2000) cache.delete(cache.keys().next().value!);
						for (const resolve of waiting.get(key) ?? []) resolve(value);
						waiting.delete(key);
					}
				})
				.catch(() => {
					for (const path of chunk) {
						const key = `${projectId}|${path}`;
						for (const resolve of waiting.get(key) ?? []) resolve(null);
						waiting.delete(key);
					}
				});
		}
	}
}

function statPath(projectId: string, path: string): Promise<"file" | "dir" | null> {
	const key = `${projectId}|${path}`;
	const cached = cache.get(key);
	if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
	cache.delete(key);
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

const LANG_ALIASES: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	py: "python",
	sh: "bash",
	shell: "bash",
	yml: "yaml",
	rs: "rust",
	md: "markdown",
};

export function CopyButton({ text, label }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<button
			type="button"
			className="gy-icon-btn"
			title={error ?? label ?? "Copy"}
			aria-label={error ?? label ?? "Copy"}
			data-jump="copy"
			onClick={() => {
				void Promise.resolve()
					.then(() => navigator.clipboard.writeText(text))
					.then(() => {
						setError(null);
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					})
					.catch(() => {
						setCopied(false);
						setError("Copy failed. Check clipboard permissions and retry.");
					});
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
		setError(null);
		void import("mermaid").then(async ({ default: mermaid }) => {
			mermaid.initialize({ startOnLoad: false, theme: THEMES[theme].scheme === "light" ? "default" : "dark", securityLevel: "strict" });
			try {
				const { svg } = await mermaid.render(`gy-mermaid-${++mermaidSeq}`, code);
				if (!cancelled && ref.current) {
					ref.current.innerHTML = svg;
					setError(null);
				}
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
			{error && <pre className="gy-pre">{code}</pre>}
			<div ref={ref} style={error ? { display: "none" } : undefined} className="flex justify-center p-3" />
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

const MarkdownChat = createContext<string | undefined>(undefined);
const markdownComponents: Components = {
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noreferrer" data-jump-kind="link">
			{children}
		</a>
	),
	img: function MarkdownImage({ src, alt }) {
		const chatId = useContext(MarkdownChat);
		if (typeof src === "string") {
			let local: boolean;
			try {
				local = new URL(src, window.location.href).origin === window.location.origin;
			} catch {
				return <span>{alt || "Image unavailable"}</span>;
			}
			const dataImage = /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/i.test(src);
			if (!local && !dataImage) return <a href={src} target="_blank" rel="noreferrer">Open image: {alt || src}</a>;
		}
		return typeof src === "string" ? (
			<button type="button" onClick={() => openImage(chatId, src, alt)} data-jump="image" data-jump-kind="image" data-jump-text={src}>
				<img src={src} alt={alt ?? ""} />
			</button>
		) : null;
	},
	pre: ({ children }) => <>{children}</>,
	code: function MarkdownCode({ className, children }) {
		const chatId = useContext(MarkdownChat);
		const match = /language-([\w+-]+)/.exec(className ?? "");
		const content = String(children ?? "");
		if (!match && !content.includes("\n")) {
			return chatId && looksLikePath(content) ? <FileLink text={content} chatId={chatId} /> : <code>{children}</code>;
		}
		return <CodeBlock code={content.replace(/\n$/, "")} lang={match?.[1]} />;
	},
	table: ({ children }) => <TableBlock>{children}</TableBlock>,
};
export const Markdown = memo(function Markdown({ text, streaming, chatId }: { text: string; streaming?: boolean; chatId?: string }) {
	return (
		<MarkdownChat.Provider value={chatId}>
			<div className={`gy-md ${streaming ? "gy-streaming-caret" : ""}`}>
				<ReactMarkdown
					remarkPlugins={[remarkGfm, remarkMath]}
					rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
					components={markdownComponents}
				>
					{text}
				</ReactMarkdown>
			</div>
		</MarkdownChat.Provider>
	);
});

/** A table's text as Markdown or TSV (also used by jump-mark actions). */
export function tableText(table: HTMLTableElement, sep: "md" | "tsv"): string {
	const rows = [...table.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("th,td")].map(cell => (cell.textContent ?? "").trim()));
	return sep === "tsv"
		? rows.map(r => r.join("\t")).join("\n")
		: rows.map((r, i) => `| ${r.map(cell => cell.replace(/\|/g, "\\|")).join(" | ")} |${i === 0 ? `\n|${r.map(() => " --- |").join("")}` : ""}`).join("\n");
}

function TableBlock({ children }: { children: React.ReactNode }) {
	const ref = useRef<HTMLTableElement>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const copyAs = (sep: "md" | "tsv") => {
		if (!ref.current) return;
		const text = tableText(ref.current, sep);
		void Promise.resolve()
			.then(() => navigator.clipboard.writeText(text))
			.then(() => setCopyError(null))
			.catch(() => setCopyError("Copy failed. Check clipboard permissions and retry."));
	};
	return (
		<div className="group relative inline-block max-w-full overflow-auto" data-jump-kind="table">
			<div className="absolute right-1 top-1 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
				<button type="button" className="gy-btn" style={{ height: 22 }} onClick={() => copyAs("md")} data-jump="copy-md">
					MD
				</button>
				<button type="button" className="gy-btn" style={{ height: 22 }} onClick={() => copyAs("tsv")} data-jump="copy-tsv">
					TSV
				</button>
			</div>
			{copyError && <div role="alert">{copyError}</div>}
			<table ref={ref}>{children}</table>
		</div>
	);
}
