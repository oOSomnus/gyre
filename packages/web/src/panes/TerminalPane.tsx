import type { PaneSpec } from "@gyre/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { gateway } from "../lib/gateway";
import { sendToChat, terminalCloser, terminals } from "../store/actions";
import { useApp } from "../store/app";
import { THEMES } from "../lib/themes";

export function TerminalPane({ pane, focused }: { pane: PaneSpec; focused: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const theme = useApp(s => s.theme);
	const [exited, setExited] = useState<number | null>(null);
	const [nonce, setNonce] = useState(0);
	const [selection, setSelection] = useState("");

	useEffect(() => {
		const el = host.current;
		if (!el || !pane.projectId) return;
		const term = new Terminal({
			fontFamily: "JetBrains Mono, IBM Plex Mono, ui-monospace, monospace",
			fontSize: 12.5,
			cursorBlink: true,
			theme: THEMES[useApp.getState().theme].xterm,
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		try {
			fit.fit();
		} catch {}
		termRef.current = term;
		terminals.set(pane.id, term);
		setExited(null);

		let ptyId: string | null = null;
		let attachmentId: string | null = null;
		let disposed = false;
		let explicitlyClosed = false;
		let attaching = false;
		const off = gateway.on(msg => {
			if (msg.t === "welcome") attach();
			if (msg.t === "pty_data" && msg.ptyId === ptyId) term.write(msg.data);
			if (msg.t === "pty_exit" && msg.ptyId === ptyId) setExited(msg.code ?? 0);
		});
		// The pane id keys the shell: hiding, floating or moving the pane reattaches to the same shell.
		const attach = () => {
			if (disposed || explicitlyClosed || attaching) return;
			attaching = true;
			if (ptyId) term.reset();
			void gateway
				.openPty(pane.projectId!, term.cols, term.rows, pane.id)
				.then(({ ptyId: id, attachmentId: attachment, reused, cols, rows }) => {
					if (disposed) {
						if (explicitlyClosed) gateway.send({ t: "pty_close", ptyId: id });
						else gateway.send({ t: "pty_detach", ptyId: id, attachmentId: attachment });
						return;
					}
					ptyId = id;
					attachmentId = attachment;
					if (reused && cols && rows) {
						// Replay scrollback at the size it was produced at, then fit to this pane.
						term.resize(cols, rows);
						setTimeout(() => {
							if (disposed) return;
							try {
								fit.fit();
								gateway.send({ t: "pty_resize", ptyId: id, cols: term.cols, rows: term.rows });
							} catch {}
						}, 120);
					}
				})
				.catch(error => {
					if (!disposed) term.write(`\r\n${(error as Error).message}\r\n`);
				})
				.finally(() => {
					attaching = false;
				});
		};
		attach();
		terminalCloser.set(pane.id, () => {
			explicitlyClosed = true;
			if (ptyId) gateway.send({ t: "pty_close", ptyId });
		});
		const input = term.onData(data => ptyId && gateway.send({ t: "pty_input", ptyId, data }));
		const select = term.onSelectionChange(() => setSelection(term.getSelection()));
		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
				if (ptyId) gateway.send({ t: "pty_resize", ptyId, cols: term.cols, rows: term.rows });
			} catch {}
		});
		observer.observe(el);
		return () => {
			disposed = true;
			observer.disconnect();
			input.dispose();
			select.dispose();
			off();
			if (ptyId && attachmentId) gateway.send({ t: "pty_detach", ptyId, attachmentId });
			terminals.delete(pane.id);
			term.dispose();
			termRef.current = null;
		};
	}, [pane.projectId, pane.id, nonce]);

	useEffect(() => {
		if (termRef.current) termRef.current.options.theme = THEMES[theme].xterm;
	}, [theme]);

	useEffect(() => {
		if (focused) termRef.current?.focus();
	}, [focused]);

	return (
		<div className="relative h-full p-1" style={{ background: THEMES[theme].xterm.background }}>
			{/* xterm types into a zero-size helper textarea that marks skip; the host is the mark
			    target instead, and activating it (or clicking anywhere in it) focuses the shell. */}
			<div ref={host} className="h-full w-full" data-jump="terminal" aria-label="Terminal input" onClick={() => termRef.current?.focus()} />
			{selection.trim() && (
				<button
					type="button"
					className="gy-btn primary absolute top-2 right-3"
					onClick={() => {
						sendToChat(`Terminal output:\n\n\`\`\`\n${selection.trimEnd()}\n\`\`\`\n`, pane.projectId);
						termRef.current?.clearSelection();
					}}
					data-jump="send-to-ai"
				>
					<Send size={12} /> Send to AI
				</button>
			)}
			{exited !== null && (
				<div className="absolute inset-x-0 bottom-3 flex justify-center">
					<button type="button" className="gy-btn" onClick={() => setNonce(n => n + 1)}>
						Shell exited ({exited}) — restart
					</button>
				</div>
			)}
		</div>
	);
}
