import { DiffEditor, loader } from "@monaco-editor/react";
// Same local Monaco bundle as MonacoViewer (no CDN, syntax-only languages).
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useEffect, useRef } from "react";
import { useApp } from "../store/app";
import { THEMES } from "../lib/themes";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monaco as unknown as typeof import("monaco-editor") });

/** Monaco's language id for a file path, from the registered extensions and file names. */
function languageFor(path: string): string | undefined {
	const name = path.split("/").pop() ?? path;
	const lower = name.toLowerCase();
	return monaco.languages
		.getLanguages()
		.find(l => l.filenames?.some(f => f.toLowerCase() === lower) || l.extensions?.some(ext => lower.endsWith(ext.toLowerCase())))?.id;
}

export interface DiffReveal {
	/** 1-based line on the new side. */
	line: number;
	/** Changes on every request, so revealing the same line twice still scrolls. */
	nonce: number;
}

/** A read-only diff: side by side, or inline when `inline` (narrow panes). */
export default function MonacoDiffViewer({
	modelKey,
	path,
	oldText,
	newText,
	inline,
	reveal,
}: {
	/** Unique per pane and side, so two Git panes never share Monaco models. */
	modelKey: string;
	path: string;
	oldText: string;
	newText: string;
	inline: boolean;
	reveal?: DiffReveal;
}) {
	const theme = useApp(s => s.theme);
	const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
	// The library disposes its models before the diff widget lets go of them, which
	// Monaco reports as an error. Keep the models and dispose them after the editor.
	const modelsRef = useRef<monaco.editor.IDiffEditorModel | null>(null);
	// Per-mount URIs: a remount must never pick up models this one disposes later.
	const mountId = useRef(crypto.randomUUID().slice(0, 8)).current;
	useEffect(
		() => () => {
			const editor = editorRef.current;
			const models = modelsRef.current ?? editor?.getModel() ?? null;
			try {
				editor?.setModel(null);
			} catch {}
			setTimeout(() => {
				models?.original.dispose();
				models?.modified.dispose();
			});
		},
		[],
	);
	useEffect(() => {
		if (!reveal) return;
		const modified = editorRef.current?.getModifiedEditor();
		modified?.revealLineInCenter(Math.max(1, reveal.line));
		modified?.setPosition({ lineNumber: Math.max(1, reveal.line), column: 1 });
	}, [reveal]);
	const encoded = encodeURI(path);
	return (
		<DiffEditor
			original={oldText}
			modified={newText}
			language={languageFor(path)}
			originalModelPath={`gitdiff://${modelKey}-${mountId}/a/${encoded}`}
			modifiedModelPath={`gitdiff://${modelKey}-${mountId}/b/${encoded}`}
			theme={THEMES[theme].scheme === "light" ? "vs" : "vs-dark"}
			keepCurrentOriginalModel
			keepCurrentModifiedModel
			onMount={editor => {
				editorRef.current = editor;
				modelsRef.current = editor.getModel();
				editor.onDidChangeModel(() => {
					modelsRef.current = editor.getModel() ?? modelsRef.current;
				});
			}}
			options={{
				readOnly: true,
				originalEditable: false,
				renderSideBySide: !inline,
				useInlineViewWhenSpaceIsLimited: true,
				minimap: { enabled: false },
				fontSize: 12.5,
				fontFamily: "JetBrains Mono, IBM Plex Mono, ui-monospace, monospace",
				scrollBeyondLastLine: false,
				renderLineHighlight: "none",
				renderOverviewRuler: false,
				// The +/- and revert glyphs are codicons, which the syntax-only bundle does not load.
				renderIndicators: false,
				renderMarginRevertIcon: false,
				automaticLayout: true,
			}}
		/>
	);
}
