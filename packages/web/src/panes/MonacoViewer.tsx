import Editor, { loader } from "@monaco-editor/react";
// Core editor + syntax-only languages: a read-only viewer needs no language workers.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useApp } from "../store/app";
import { THEMES } from "../lib/themes";

// Bundle Monaco locally (no CDN) so the desktop app works offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monaco as unknown as typeof import("monaco-editor") });

export default function MonacoViewer({ path, content }: { path: string; content: string }) {
	const theme = useApp(s => s.theme);
	return (
		<Editor
			path={path}
			value={content}
			theme={THEMES[theme].scheme === "light" ? "vs" : "vs-dark"}
			options={{
				readOnly: true,
				minimap: { enabled: false },
				fontSize: 12.5,
				fontFamily: "JetBrains Mono, IBM Plex Mono, ui-monospace, monospace",
				scrollBeyondLastLine: false,
				renderLineHighlight: "none",
				automaticLayout: true,
			}}
		/>
	);
}
