/**
 * Thin, generic driver for `omp --mode rpc-ui`.
 *
 * Deliberately protocol-agnostic above the framing layer: any command object is
 * forwarded and any non-response frame is surfaced, so new upstream commands and
 * events need no changes here. Framing (protocol v2 chunk reassembly) reuses omp's
 * own exported decoder so it tracks upstream automatically.
 */
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { Subprocess } from "bun";

export interface OmpResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface OmpReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions?: number[];
	[key: string]: unknown;
}

export interface OmpProcessOptions {
	cwd: string;
	ompPath?: string;
	/** Extra CLI args appended after `--mode rpc-ui`. */
	args?: string[];
	env?: Record<string, string | undefined>;
	onFrame: (frame: { type: string; [key: string]: unknown }) => void;
	onExit: (code: number | null, stderrTail: string) => void;
	startupTimeoutMs?: number;
}

export class OmpCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "OmpCommandError";
	}
}

const STDERR_TAIL_BYTES = 16 * 1024;

interface Pending {
	resolve: (response: OmpResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class OmpProcess {
	#child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pending = new Map<string, Pending>();
	#nextId = 0;
	#stderrTail = "";
	#exited = false;
	ready: OmpReadyFrame | null = null;
	protocolVersion = 1;

	constructor(private readonly options: OmpProcessOptions) {}

	get running(): boolean {
		return this.#child !== null && !this.#exited;
	}

	get stderrTail(): string {
		return this.#stderrTail;
	}

	async start(): Promise<OmpReadyFrame> {
		if (this.#child) throw new Error("omp process already started");
		const argv = [this.options.ompPath ?? "omp", "--mode", "rpc-ui", ...(this.options.args ?? [])];
		const child = Bun.spawn(argv, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#child = child;

		let resolveReady!: (frame: OmpReadyFrame) => void;
		let rejectReady!: (error: Error) => void;
		const readyPromise = new Promise<OmpReadyFrame>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const startupTimer = setTimeout(
			() => rejectReady(new Error(`omp did not become ready in time.\n${this.#stderrTail}`)),
			this.options.startupTimeoutMs ?? 60_000,
		);

		void this.#pumpStderr(child.stderr);
		void this.#pumpStdout(child.stdout, frame => {
			clearTimeout(startupTimer);
			resolveReady(frame);
		});

		void child.exited.then(code => {
			this.#exited = true;
			clearTimeout(startupTimer);
			const error = new Error(`omp exited with code ${code}.\n${this.#stderrTail}`);
			rejectReady(error);
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			this.#pending.clear();
			this.options.onExit(code, this.#stderrTail);
		});

		const ready = await readyPromise;
		this.ready = ready;
		if (ready.supportedProtocolVersions?.includes(2)) {
			const response = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
			if (response.success) this.protocolVersion = 2;
		}
		return ready;
	}

	/** Send any command; resolves with the raw response (success or failure). */
	send(command: { type: string; [key: string]: unknown }, timeoutMs = 30_000): Promise<OmpResponse> {
		const child = this.#child;
		if (!child || this.#exited) return Promise.reject(new Error("omp process is not running"));
		const id = `mc_${++this.#nextId}`;
		return new Promise<OmpResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new OmpCommandError(`omp command timed out after ${timeoutMs}ms`, command.type, "timeout"));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ ...command, id });
		});
	}

	/** Send a command and unwrap `data`, throwing on failure. */
	async call<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T> {
		const response = await this.send(command, timeoutMs);
		if (!response.success) throw new OmpCommandError(response.error ?? "command failed", response.command, response.code);
		return response.data as T;
	}

	respondUi(response: { id: string; [key: string]: unknown }): void {
		if (!this.#child || this.#exited) return;
		this.#write({ type: "extension_ui_response", ...response });
	}

	async stop(graceMs = 3000): Promise<void> {
		const child = this.#child;
		if (!child || this.#exited) return;
		try {
			// Closing stdin is omp's clean-shutdown signal: it drains and exits 0.
			child.stdin.end();
		} catch {}
		const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), graceMs));
		if ((await Promise.race([child.exited, timeout])) === "timeout") {
			child.kill("SIGTERM");
			const second = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), graceMs));
			if ((await Promise.race([child.exited, second])) === "timeout") {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	}

	#write(frame: object): void {
		const child = this.#child;
		if (!child) return;
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		child.stdin.flush();
	}

	async #pumpStdout(stream: ReadableStream<Uint8Array>, onReady: (frame: OmpReadyFrame) => void): Promise<void> {
		const decoder = new RpcFrameDecoder();
		const text = new TextDecoder();
		let buffer = "";
		let readySeen = false;
		for await (const chunk of stream) {
			buffer += text.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					this.#appendStderr(`[non-JSON stdout] ${line}\n`);
					continue;
				}
				if (!readySeen && isRecord(parsed) && parsed.type === "ready") {
					readySeen = true;
					onReady(parsed as OmpReadyFrame);
					continue;
				}
				let frame: object | undefined;
				try {
					frame = decoder.push(parsed);
				} catch (error) {
					this.#appendStderr(`[frame decode error] ${String(error)}\n`);
					continue;
				}
				if (frame) this.#dispatch(frame as { type: string; [key: string]: unknown });
			}
		}
	}

	#dispatch(frame: { type: string; [key: string]: unknown }): void {
		if (frame.type === "response") {
			const response = frame as unknown as OmpResponse;
			const pending = response.id ? this.#pending.get(response.id) : undefined;
			if (pending && response.id) {
				this.#pending.delete(response.id);
				clearTimeout(pending.timer);
				pending.resolve(response);
				return;
			}
			// Late or unsolicited responses (e.g. a prompt failing after admission) go to the UI.
		}
		this.options.onFrame(frame);
	}

	async #pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const text = new TextDecoder();
		for await (const chunk of stream) this.#appendStderr(text.decode(chunk, { stream: true }));
	}

	#appendStderr(text: string): void {
		this.#stderrTail = (this.#stderrTail + text).slice(-STDERR_TAIL_BYTES);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
