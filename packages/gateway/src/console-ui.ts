/**
 * Full-screen console for `gyre` (the web version) when it runs in a terminal:
 * a coloured status bar with the URL and what the gateway is doing, and the
 * gateway's log underneath. Piped or redirected runs (the desktop sidecar,
 * scripts, CI) keep plain line output, so nothing that parses stdout changes.
 *
 * Keys: PgUp/PgDn/↑/↓ scroll the log, End/G follows it again, Home/g jumps
 * to the oldest line, o opens the UI in a browser, u shows the whole URL,
 * c copies it (OSC 52), q or Ctrl+C stops Gyre.
 */
import { readFileSync } from "node:fs";
import { format } from "node:util";
import type { GatewayStatus } from "./server";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
	at: number;
	level: LogLevel;
	text: string;
}

export interface ConsoleView {
	cols: number;
	rows: number;
	/** URL to open the UI (with its token). */
	url: string;
	phase: "running" | "stopping";
	status: GatewayStatus;
	startedAt: number;
	now: number;
	logs: readonly LogLine[];
	/** Wrapped log rows scrolled up from the newest; 0 follows the log. */
	scroll: number;
	/** A transient note shown in the status bar (e.g. "Opening browser…"). */
	note?: string;
	/** `logs` already wrapped for `cols` (see WrappedLog); wrapped here when absent. */
	wrapped?: readonly LogRow[];
	/** Show the whole URL in place of the log. */
	reveal?: boolean;
}

export interface LogRow {
	level: LogLevel;
	/** Set on a line's first row. */
	time?: string;
	text: string;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
/** Rows the status bar takes. */
export const HEADER_ROWS = 2;
/** Log lines kept in memory. */
export const MAX_LOG_LINES = 5000;
const TIME_WIDTH = 10;

// ANSI CSI/OSC sequences and other C0/C1 controls; logs must never move the cursor or change colours.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** One log entry as plain printable text: no escape sequences or control characters; tabs become spaces. */
export function sanitize(text: string): string {
	return text.replace(ANSI, "").replace(/\t/g, "    ").replace(CONTROL, "");
}

function charWidth(char: string): number {
	return Bun.stringWidth(char);
}

/** Cut `text` to at most `width` terminal columns. */
export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (Bun.stringWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		const w = charWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

/** Hard-wrap plain text to `width` columns (wide characters count twice). */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return [""];
	const rows: string[] = [];
	let row = "";
	let used = 0;
	for (const char of text) {
		const w = charWidth(char);
		if (used + w > width && row) {
			rows.push(row);
			row = "";
			used = 0;
		}
		row += char;
		used += w;
	}
	rows.push(row);
	return rows;
}

function pad(text: string, width: number): string {
	const cut = truncate(text, width);
	return cut + " ".repeat(Math.max(0, width - Bun.stringWidth(cut)));
}

function clock(at: number): string {
	const d = new Date(at);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

export function uptime(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The status word and its colour (bright SGR foreground, readable on the bar's blue). */
function health(view: ConsoleView): { word: string; color: string } {
	if (view.phase === "stopping") return { word: "stopping…", color: "93" };
	switch (view.status.ompStatus) {
		case "ok":
			return { word: "ready", color: "92" };
		case "checking":
			return { word: "checking omp…", color: "93" };
		case "missing":
			return { word: "omp not installed", color: "91" };
		case "no-models":
			return { word: "no model provider", color: "91" };
		default:
			return { word: "running", color: "93" };
	}
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Every log line wrapped to the log area's width, oldest first. */
export function logRows(logs: readonly LogLine[], cols: number): LogRow[] {
	const width = Math.max(1, cols - TIME_WIDTH);
	const out: LogRow[] = [];
	for (const line of logs) {
		wrap(line.text, width).forEach((text, i) => {
			out.push({ level: line.level, time: i === 0 ? clock(line.at) : undefined, text });
		});
	}
	return out;
}

/** The largest useful scroll offset for this many wrapped rows. */
export function maxScroll(rowCount: number, rows: number): number {
	return Math.max(0, rowCount - Math.max(1, rows - HEADER_ROWS));
}

/**
 * The log and its rows wrapped for one terminal width, kept in step as lines are added
 * and dropped, so a redraw or a key press does not re-wrap the whole log.
 */
export class WrappedLog {
	readonly lines: LogLine[] = [];
	rows: Array<LogRow & { entry: number }> = [];
	/** Lines dropped from the front: lines[i] is entry `dropped + i`. */
	#dropped = 0;

	constructor(
		public cols: number,
		readonly limit = MAX_LOG_LINES,
	) {}

	#wrap(line: LogLine, entry: number): Array<LogRow & { entry: number }> {
		return logRows([line], this.cols).map(row => ({ ...row, entry }));
	}

	/** Add a line, dropping the oldest past the limit. Returns how many rows the new line takes. */
	push(line: LogLine): number {
		const added = this.#wrap(line, this.#dropped + this.lines.length);
		this.lines.push(line);
		for (const row of added) this.rows.push(row);
		if (this.lines.length > this.limit) {
			const drop = this.lines.length - this.limit;
			this.lines.splice(0, drop);
			this.#dropped += drop;
			const keep = this.rows.findIndex(row => row.entry >= this.#dropped);
			this.rows.splice(0, keep < 0 ? this.rows.length : keep);
		}
		return added.length;
	}

	/**
	 * Re-wrap for a new width. `scroll` is rows up from the newest in a view `area` rows
	 * tall: while scrolled back, the line at the top of the view stays at the top; 0
	 * (following the log) stays 0. Returns the scroll for the new width.
	 */
	resize(cols: number, scroll: number, area: number): number {
		if (cols === this.cols) return scroll;
		const top = scroll > 0 ? this.rows[Math.max(0, this.rows.length - scroll - area)]?.entry : undefined;
		this.cols = cols;
		this.rows = this.lines.flatMap((line, i) => this.#wrap(line, this.#dropped + i));
		if (top === undefined) return 0;
		const limit = Math.max(0, this.rows.length - area);
		const index = this.rows.findIndex(row => row.entry === top);
		// Stay scrolled back (not following) even when the anchored line now fits at the bottom.
		return Math.min(limit, Math.max(Math.min(1, limit), this.rows.length - index - area));
	}
}

/** Two status rows on a coloured background, each exactly `cols` wide. */
export function renderHeader(view: ConsoleView): string[] {
	const { cols, status } = view;
	const width = (text: string) => Bun.stringWidth(text);
	const { word, color } = health(view);
	const BAR = `${ESC}48;5;24m${ESC}97m`;
	const SUB = `${ESC}48;5;236m${ESC}37m`;

	// Row 1: name, status, URL, version. The URL gives way first, then the version.
	const title = " ◉ Gyre ";
	const state = ` ● ${word}  `;
	let version = ` v${status.version} `;
	let urlRoom = cols - width(title) - width(state) - width(version);
	if (urlRoom < 16) {
		version = "";
		urlRoom = cols - width(title) - width(state);
	}
	let line1: string;
	if (urlRoom < 1) {
		line1 = `${BAR}${pad(`${title}${state}`, cols)}`;
	} else {
		const url = truncate(view.url, urlRoom);
		const gap = " ".repeat(Math.max(0, urlRoom - width(url)));
		line1 = `${BAR}${ESC}1m${title}${ESC}22m${ESC}${color}m${state}${ESC}97m${ESC}4m${url}${ESC}24m${gap}${version}`;
	}

	// Row 2: what the gateway is doing, then key hints (dropped when there is no room).
	// The version comes from omp's output: keep it to one printable line.
	const ompVersion = status.ompVersion ? sanitize(status.ompVersion).replace(/\s+/g, " ").trim() : "";
	const facts = [
		ompVersion ? `omp ${ompVersion}` : "omp —",
		status.busy > 0 ? `${plural(status.chats, "chat")} (${status.busy} working)` : plural(status.chats, "chat"),
		plural(status.clients, "browser"),
		plural(status.terminals, "terminal"),
		`up ${uptime(view.now - view.startedAt)}`,
	].join(" · ");
	const hints =
		view.note ??
		(view.reveal ? "any key: back · c copy" : view.scroll > 0 ? `↑ ${view.scroll} · End: follow log · q quit` : "o open · u URL · c copy · PgUp/PgDn · q quit");
	// Hints win over facts (they say how to get back to the live log); facts get the rest.
	const factsRoom = cols - width(hints) - 3;
	const line2 = factsRoom >= 24 ? `${pad(` ${facts}`, factsRoom)}  ${hints} ` : pad(` ${facts}`, cols);

	return [`${line1}${RESET}`, `${SUB}${line2}${RESET}`];
}

/** The whole screen: status bar on top, the visible slice of the log below. */
export function renderFrame(view: ConsoleView): string {
	const cols = Math.max(20, view.cols);
	const rows = Math.max(HEADER_ROWS + 1, view.rows);
	const header = renderHeader({ ...view, cols });
	const area = rows - HEADER_ROWS;
	if (view.reveal) {
		// The whole URL, wrapped (the status bar shortens it), for reading or selecting.
		const intro = truncate("The full URL, sign-in token included. c copies it; any other key goes back.", cols);
		const body = [`${ESC}2m${intro}${ESC}22m`, "", ...wrap(view.url, cols)];
		const lines = [...header, ...Array.from({ length: area }, (_, i) => body[i] ?? "")];
		return `${ESC}H${lines.map(line => `${ESC}2K${line}`).join("\r\n")}`;
	}
	const all = view.wrapped ?? logRows(view.logs, cols);
	const scroll = Math.min(view.scroll, maxScroll(all.length, rows));
	const end = all.length - scroll;
	const visible = all.slice(Math.max(0, end - area), end);
	const lines: string[] = [...header];
	for (let i = 0; i < area; i++) {
		const row = visible[i];
		if (!row) {
			lines.push("");
			continue;
		}
		const time = row.time ? `${ESC}2m${row.time.padEnd(TIME_WIDTH)}${ESC}22m` : " ".repeat(TIME_WIDTH);
		const color = row.level === "error" ? `${ESC}31m` : row.level === "warn" ? `${ESC}33m` : "";
		lines.push(`${time}${color}${row.text}${color ? RESET : ""}`);
	}
	return `${ESC}H${lines.map(line => `${ESC}2K${line}`).join("\r\n")}`;
}

/** Errors stand out from routine lines that also go to stderr. */
export function levelOf(text: string, fallback: LogLevel): LogLevel {
	if (/\b(fail(ed|s)?|error|exited \(code [1-9]|not found|unavailable|could not)\b/i.test(text)) return "error";
	return fallback;
}

export type ConsoleKey = "quit" | "open" | "copy" | "reveal" | "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "redraw";

/** Keys in one chunk of raw terminal input. */
export function parseKeys(input: string): ConsoleKey[] {
	return parseKeyChunk(input).keys;
}

/**
 * Keys in one chunk of raw terminal input, and `rest`: an escape sequence cut off at
 * the end of the chunk, to put in front of the next one.
 */
export function parseKeyChunk(input: string): { keys: ConsoleKey[]; rest: string } {
	const keys: ConsoleKey[] = [];
	const table: Array<[string, ConsoleKey]> = [
		["\x1b[5~", "pageUp"],
		["\x1b[6~", "pageDown"],
		["\x1b[A", "up"],
		["\x1b[B", "down"],
		["\x1bOA", "up"],
		["\x1bOB", "down"],
		["\x1b[H", "top"],
		["\x1b[1~", "top"],
		["\x1bOH", "top"],
		["\x1b[F", "bottom"],
		["\x1b[4~", "bottom"],
		["\x1bOF", "bottom"],
		["\x03", "quit"],
		["\x04", "quit"],
		["\x0c", "redraw"],
		["q", "quit"],
		["Q", "quit"],
		["o", "open"],
		["O", "open"],
		["c", "copy"],
		["C", "copy"],
		["u", "reveal"],
		["U", "reveal"],
		["k", "up"],
		["j", "down"],
		["g", "top"],
		["G", "bottom"],
		[" ", "pageDown"],
		["b", "pageUp"],
	];
	let i = 0;
	while (i < input.length) {
		const hit = table.find(([seq]) => input.startsWith(seq, i));
		if (hit) {
			keys.push(hit[1]);
			i += hit[0].length;
			continue;
		}
		// Skip an unknown escape sequence, or an Alt+key, whole rather than reading its letters as keys.
		if (input[i] === "\x1b") {
			const tail = input.slice(i);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences.
			if (/^\x1b(?:\[[0-?]*[ -/]*|O)?$/.test(tail)) return { keys, rest: tail };
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences.
			const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[ -~]|[ -~])?/.exec(tail);
			i += match?.[0].length || 1;
			continue;
		}
		i += 1;
	}
	return { keys, rest: "" };
}

export interface ConsoleUiOptions {
	url: string;
	status: () => GatewayStatus;
	/** q / Ctrl+C. */
	onQuit: () => void;
	/** o: open the UI in a browser. */
	onOpen: () => void;
	/** Lines logged before the console started. */
	initial?: Array<{ level: LogLevel; text: string }>;
}

export interface ConsoleUi {
	log(level: LogLevel, text: string): void;
	note(text: string | undefined): void;
	setStopping(): void;
	/** Leave the full-screen console and print the latest log lines to the normal screen. */
	close(): void;
}

/**
 * Whether this process's group owns its terminal (`gyre`, not `gyre &`). A background job
 * that set raw mode or read keys would be stopped by the shell. True when it can't tell.
 */
export function inForeground(): boolean {
	try {
		if (process.platform === "linux") {
			// /proc/self/stat: "pid (comm) state ppid pgrp session tty_nr tpgid …"; comm may hold spaces.
			const stat = readFileSync("/proc/self/stat", "utf8");
			const [, , pgrp, , , tpgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			return Number(tpgid) <= 0 || pgrp === tpgid;
		}
		if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
			const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-o", "tpgid=", "-p", String(process.pid)], { stderr: "ignore" });
			const [pgrp, tpgid] = ps.stdout.toString().trim().split(/\s+/);
			return !pgrp || !tpgid || Number(tpgid) <= 0 || pgrp === tpgid;
		}
	} catch {}
	return true;
}

/** Whether `gyre` should take over the terminal: an interactive terminal, not a sidecar, a pipe or a background job. */
export function wantsConsoleUi(
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv,
	foreground: () => boolean = inForeground,
): boolean {
	// stderr too: the console captures it, so a redirected stderr must keep getting the log.
	if (!process.stdout.isTTY || !process.stdin.isTTY || !process.stderr.isTTY) return false;
	if (env.GYRE_EXIT_ON_STDIN_CLOSE === "1" || env.GYRE_PLAIN === "1" || argv.includes("--plain")) return false;
	return env.TERM !== "dumb" && foreground();
}

/**
 * Take over the terminal. Console output (console.* and process.stdout/stderr
 * writes) becomes log lines in the console until `close()`.
 */
export function startConsoleUi(options: ConsoleUiOptions): ConsoleUi {
	const out = process.stdout;
	const write = out.write.bind(out) as (chunk: string) => boolean;
	const errWrite = process.stderr.write.bind(process.stderr);
	const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
	let scroll = 0;
	let reveal = false;
	/** An escape sequence split across input chunks. */
	let carry = "";
	let carryTimer: ReturnType<typeof setTimeout> | undefined;
	let note: string | undefined;
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let phase: ConsoleView["phase"] = "running";
	let closed = false;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const startedAt = Date.now();

	// renderFrame's own minimums, so the wrapped rows match what it draws.
	const size = () => ({ cols: Math.max(20, out.columns || 80), rows: Math.max(HEADER_ROWS + 1, out.rows || 24) });
	const log = new WrappedLog(size().cols);
	/** Re-wrap the log after a width change, keeping the reader's place. */
	const fit = () => {
		const { cols, rows } = size();
		scroll = log.resize(cols, scroll, rows - HEADER_ROWS);
		scroll = Math.min(scroll, maxScroll(log.rows.length, rows));
		return { cols, rows };
	};
	const draw = () => {
		pending = undefined;
		if (closed) return;
		const { cols, rows } = fit();
		const view = { cols, rows, url: options.url, phase, status: options.status(), startedAt, now: Date.now(), scroll, note, reveal };
		write(renderFrame({ ...view, logs: log.lines, wrapped: log.rows }));
	};
	const schedule = () => {
		if (!pending && !closed) pending = setTimeout(draw, 16);
	};
	const setNote = (text: string | undefined) => {
		note = text;
		if (noteTimer) clearTimeout(noteTimer);
		if (text) noteTimer = setTimeout(() => ((note = undefined), schedule()), 4000);
		schedule();
	};

	const push = (level: LogLevel, raw: string) => {
		for (const part of sanitize(raw.replace(/\r\n?/g, "\n")).split("\n")) {
			if (!part.trim()) continue;
			const added = log.push({ at: Date.now(), level: levelOf(part, level), text: part });
			// Keep the reader's place while they look back.
			if (scroll > 0) scroll += added;
		}
		schedule();
	};

	const capture =
		(level: LogLevel) =>
		(...args: unknown[]) =>
			push(level, format(...args));
	console.log = capture("info");
	console.info = capture("info");
	console.debug = capture("info");
	console.warn = capture("warn");
	console.error = capture("info");
	const captureStream = (level: LogLevel) =>
		((chunk: string | Uint8Array, ...rest: unknown[]) => {
			push(level, typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			const callback = rest.find(arg => typeof arg === "function") as (() => void) | undefined;
			callback?.();
			return true;
		}) as typeof process.stdout.write;
	out.write = captureStream("info");
	process.stderr.write = captureStream("info");

	for (const line of options.initial ?? []) push(line.level, line.text);

	const copyUrl = () => {
		// OSC 52: the terminal puts the text on the clipboard (where it supports it).
		write(`\x1b]52;c;${Buffer.from(options.url).toString("base64")}\x07`);
		setNote("URL copied (OSC 52)");
	};

	const onKeys = (data: Buffer | string) => {
		const text = carry + (typeof data === "string" ? data : data.toString("utf8"));
		const { keys, rest } = parseKeyChunk(text);
		carry = rest;
		if (carryTimer) clearTimeout(carryTimer);
		// A lone Esc (or a sequence that never completes) must not swallow the next key.
		carryTimer = rest
			? setTimeout(() => {
					// Esc on its own goes back from the URL view.
					if (reveal && carry === "\x1b") {
						reveal = false;
						schedule();
					}
					carry = "";
				}, 50)
			: undefined;
		if (reveal) {
			// Any key goes back to the log; c copies; Ctrl+C still stops Gyre (q only goes back).
			if (text.includes("\x03")) options.onQuit();
			else if (keys.includes("copy")) copyUrl();
			else if (text !== rest) reveal = false;
			schedule();
			return;
		}
		const { rows } = fit();
		const page = Math.max(1, rows - HEADER_ROWS - 1);
		const limit = maxScroll(log.rows.length, rows);
		for (const key of keys) {
			switch (key) {
				case "quit":
					options.onQuit();
					break;
				case "open":
					options.onOpen();
					break;
				case "copy":
					copyUrl();
					break;
				case "reveal":
					reveal = true;
					break;
				case "up":
					scroll = Math.min(limit, scroll + 1);
					break;
				case "down":
					scroll = Math.max(0, scroll - 1);
					break;
				case "pageUp":
					scroll = Math.min(limit, scroll + page);
					break;
				case "pageDown":
					scroll = Math.max(0, scroll - page);
					break;
				case "top":
					scroll = limit;
					break;
				case "bottom":
					scroll = 0;
					break;
				case "redraw":
					write(`${ESC}2J`);
					break;
			}
		}
		schedule();
	};

	const restore = () => {
		if (closed) return;
		closed = true;
		if (pending) clearTimeout(pending);
		if (noteTimer) clearTimeout(noteTimer);
		if (carryTimer) clearTimeout(carryTimer);
		clearInterval(tick);
		out.off("resize", onResize);
		process.stdin.off("data", onKeys);
		try {
			process.stdin.setRawMode?.(false);
		} catch {}
		process.stdin.pause();
		Object.assign(console, saved);
		out.write = write as typeof out.write;
		process.stderr.write = errWrite;
		// Leave the alternate screen, show the cursor, re-enable wrapping.
		write(`${ESC}?7h${ESC}?25h${ESC}?1049l`);
		const tail = log.lines.slice(-15);
		if (tail.length) write(`${tail.map(line => `${clock(line.at)}  ${line.text}`).join("\n")}\n`);
	};
	const onResize = () => {
		write(`${ESC}2J`);
		schedule();
	};

	// Alternate screen, hidden cursor, no auto-wrap (rows are pre-wrapped), clear.
	write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J`);
	out.on("resize", onResize);
	try {
		process.stdin.setRawMode?.(true);
	} catch {}
	process.stdin.resume();
	process.stdin.on("data", onKeys);
	// Uptime and status counts.
	const tick = setInterval(schedule, 1000);
	// Never leave the terminal in the alternate screen, whatever ends the process.
	process.on("exit", restore);
	draw();

	return {
		log: push,
		note: setNote,
		setStopping() {
			phase = "stopping";
			draw();
		},
		close: restore,
	};
}
