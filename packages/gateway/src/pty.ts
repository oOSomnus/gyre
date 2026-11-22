/**
 * Terminal panes backed by Bun's native PTY support.
 *
 * Terminals outlive the UI component that shows them: a pane that is hidden,
 * floated, moved to another workspace or remounted reattaches by `key` (its pane
 * id) and gets the scrollback replayed. Only an explicit close kills the shell.
 */
import type { PtyInfo } from "@gyre/protocol";
import type { Subprocess } from "bun";

const SCROLLBACK_BYTES = 256 * 1024;

export interface PtyListener {
	data(data: string): void;
	exit(code: number | null): void;
}

interface PtyHandle {
	id: string;
	key?: string;
	projectId: string;
	cwd: string;
	startedAt: number;
	process: Subprocess;
	terminal: { write(data: string): void; resize(cols: number, rows: number): void; close?(): void };
	scrollback: string[];
	scrollbackSize: number;
	listeners: Set<PtyListener>;
	cols: number;
	rows: number;
	closing?: boolean;
	closeTimer?: ReturnType<typeof setTimeout>;
}

export class PtyManager {
	readonly ptys = new Map<string, PtyHandle>();

	/** Reattach to the shell for `key`, or start one. Returns the pty id and whether it was reused. */
	open(params: { key?: string; projectId: string; cwd: string; cols: number; rows: number; listener: PtyListener }): {
		ptyId: string;
		reused: boolean;
		cols: number;
		rows: number;
	} {
		if (params.key) {
			const existing = [...this.ptys.values()].find(p => p.key === params.key && p.projectId === params.projectId && !p.closing);
			if (existing) {
				// Replay at the size the output was produced at; the client resizes afterwards.
				existing.listeners.add(params.listener);
				const replay = existing.scrollback.join("");
				if (replay) params.listener.data(replay);
				return { ptyId: existing.id, reused: true, cols: existing.cols, rows: existing.rows };
			}
		}
		const id = crypto.randomUUID();
		const shell = process.env.SHELL || "/bin/bash";
		const decoder = new TextDecoder();
		const handle: PtyHandle = {
			id,
			key: params.key,
			projectId: params.projectId,
			cwd: params.cwd,
			startedAt: Date.now(),
			process: undefined as unknown as Subprocess,
			terminal: undefined as unknown as PtyHandle["terminal"],
			scrollback: [],
			scrollbackSize: 0,
			listeners: new Set([params.listener]),
			cols: params.cols,
			rows: params.rows,
		};
		const child = Bun.spawn([shell, "-l"], {
			cwd: params.cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
			terminal: {
				cols: params.cols,
				rows: params.rows,
				data(_terminal: unknown, data: Uint8Array) {
					const text = decoder.decode(data, { stream: true });
					handle.scrollback.push(text);
					handle.scrollbackSize += text.length;
					while (handle.scrollbackSize > SCROLLBACK_BYTES && handle.scrollback.length > 1) {
						handle.scrollbackSize -= handle.scrollback.shift()?.length ?? 0;
					}
					for (const listener of handle.listeners) listener.data(text);
				},
			},
		} as Parameters<typeof Bun.spawn>[1]);
		handle.process = child;
		handle.terminal = (child as unknown as { terminal: PtyHandle["terminal"] }).terminal;
		this.ptys.set(id, handle);
		void child.exited.then(code => {
			clearTimeout(handle.closeTimer);
			this.ptys.delete(id);
			handle.terminal.close?.();
			for (const listener of handle.listeners) listener.exit(code);
		});
		return { ptyId: id, reused: false, cols: params.cols, rows: params.rows };
	}

	write(id: string, data: string): void {
		this.ptys.get(id)?.terminal.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const handle = this.ptys.get(id);
		if (!handle) return;
		handle.cols = Math.max(2, cols);
		handle.rows = Math.max(2, rows);
		handle.terminal.resize(handle.cols, handle.rows);
	}

	detach(id: string, listener: PtyListener): void {
		this.ptys.get(id)?.listeners.delete(listener);
	}

	detachAll(listener: PtyListener): void {
		for (const handle of this.ptys.values()) handle.listeners.delete(listener);
	}

	close(id: string): void {
		const handle = this.ptys.get(id);
		if (!handle || handle.closing) return;
		handle.closing = true;
		handle.process.kill("SIGHUP");
		handle.closeTimer = setTimeout(() => {
			if (this.ptys.get(id) === handle) handle.process.kill("SIGKILL");
		}, 1000);
	}

	closeByKey(key: string, projectId: string): void {
		for (const handle of this.ptys.values()) if (handle.key === key && handle.projectId === projectId) this.close(handle.id);
	}

	async closeAll(): Promise<void> {
		const handles = [...this.ptys.values()];
		for (const handle of handles) this.close(handle.id);
		await Promise.allSettled(handles.map(handle => handle.process.exited));
	}

	list(): PtyInfo[] {
		return [...this.ptys.values()].map(p => ({
			ptyId: p.id,
			key: p.key,
			projectId: p.projectId,
			cwd: p.cwd,
			pid: p.process.pid,
			startedAt: p.startedAt,
			attached: p.listeners.size,
		}));
	}
}
