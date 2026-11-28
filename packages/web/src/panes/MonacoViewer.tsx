import Editor, { loader, type OnMount } from "@monaco-editor/react";
// Core editor + syntax-only languages: editing plain text needs no language workers.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useRef } from "react";
import { useApp } from "../store/app";
import { THEMES } from "../lib/themes";

// Bundle Monaco locally (no CDN) so the desktop app works offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monaco as unknown as typeof import("monaco-editor") });

/**
 * A Monaco editor for one file. Read-only unless `readOnly` is false; then `onChange`
 * reports every edit and Ctrl/Cmd+S calls `onSave`. `value` is the saved text: changing
 * it (a reload) replaces the buffer, while typing leaves it alone.
 */
export default function MonacoViewer({
	path,
	content,
	modelKey,
	readOnly = true,
	onChange,
	onSave,
}: {
	path: string;
	content: string;
	/** Prefix that keeps two panes on the same file from sharing one Monaco model. */
	modelKey?: string;
	readOnly?: boolean;
	onChange?: (value: string) => void;
	onSave?: () => void;
}) {
	const theme = useApp(s => s.theme);
	const saveRef = useRef(onSave);
	saveRef.current = onSave;
	const onMount: OnMount = editor => {
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
	};
	return (
		<Editor
			path={modelKey ? `${modelKey}/${path}` : path}
			value={content}
			theme={THEMES[theme].scheme === "light" ? "vs" : "vs-dark"}
			onMount={onMount}
			onChange={value => onChange?.(value ?? "")}
			options={{
				readOnly,
				minimap: { enabled: false },
				fontSize: 12.5,
				fontFamily: "JetBrains Mono, IBM Plex Mono, ui-monospace, monospace",
				scrollBeyondLastLine: false,
				renderLineHighlight: readOnly ? "none" : "line",
				automaticLayout: true,
			}}
		/>
	);
}
