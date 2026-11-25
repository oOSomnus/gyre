/**
 * Full-screen console for `gyre` (the web version) when it runs in a terminal:
 * a coloured status bar with the URL and what the gateway is doing, and the
 * gateway's log underneath. Piped or redirected runs (the desktop sidecar,
 * scripts, CI) keep plain line output, so nothing that parses stdout changes.
 *
 * Keys: PgUp/PgDn/↑/↓ scroll the log, End/G follows it again, Home/g jumps
 * to the oldest line, o opens the UI in a browser, q or Ctrl+C stops Gyre.
 */
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
export function logRows(logs: readonly LogLine[], cols: number): Array<{ level: LogLevel; time?: string; text: string }> {
	const width = Math.max(1, cols - TIME_WIDTH);
	const out: Array<{ level: LogLevel; time?: string; text: string }> = [];
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
	const facts = [
		status.ompVersion ? `omp ${status.ompVersion}` : "omp —",
		status.busy > 0 ? `${plural(status.chats, "chat")} (${status.busy} working)` : plural(status.chats, "chat"),
		plural(status.clients, "browser"),
		plural(status.terminals, "terminal"),
		`up ${uptime(view.now - view.startedAt)}`,
	].join(" · ");
	const hints = view.note ?? (view.scroll > 0 ? `↑ ${view.scroll} · End: follow log · q quit` : "o open · PgUp/PgDn scroll · q quit");
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
	const all = logRows(view.logs, cols);
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

export type ConsoleKey = "quit" | "open" | "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "redraw";

/** Keys in one chunk of raw terminal input. */
export function parseKeys(input: string): ConsoleKey[] {
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
		// Skip an unknown escape sequence whole rather than reading its letters as keys.
		if (input[i] === "\x1b") {
			const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)?/.exec(input.slice(i));
			i += match?.[0].length || 1;
			continue;
		}
		i += 1;
	}
	return keys;
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

/** Whether `gyre` should take over the terminal: an interactive terminal, not a sidecar or a pipe. */
export function wantsConsoleUi(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): boolean {
	if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
	if (env.GYRE_EXIT_ON_STDIN_CLOSE === "1" || env.GYRE_PLAIN === "1" || argv.includes("--plain")) return false;
	return env.TERM !== "dumb";
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
	const logs: LogLine[] = [];
	let scroll = 0;
	let note: string | undefined;
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let phase: ConsoleView["phase"] = "running";
	let closed = false;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const startedAt = Date.now();

	const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 });
	const draw = () => {
		pending = undefined;
		if (closed) return;
		const { cols, rows } = size();
		scroll = Math.min(scroll, maxScroll(logRows(logs, cols).length, rows));
		write(renderFrame({ cols, rows, url: options.url, phase, status: options.status(), startedAt, now: Date.now(), logs, scroll, note }));
	};
	const schedule = () => {
		if (!pending && !closed) pending = setTimeout(draw, 16);
	};

	const push = (level: LogLevel, raw: string) => {
		for (const part of sanitize(raw.replace(/\r\n?/g, "\n")).split("\n")) {
			if (!part.trim()) continue;
			logs.push({ at: Date.now(), level: levelOf(part, level), text: part });
			// Keep the reader's place while they look back.
			if (scroll > 0) scroll += wrap(part, Math.max(1, size().cols - TIME_WIDTH)).length;
		}
		if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
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

	const onKeys = (data: Buffer | string) => {
		const { cols, rows } = size();
		const page = Math.max(1, rows - HEADER_ROWS - 1);
		const limit = maxScroll(logRows(logs, cols).length, rows);
		for (const key of parseKeys(typeof data === "string" ? data : data.toString("utf8"))) {
			switch (key) {
				case "quit":
					options.onQuit();
					break;
				case "open":
					options.onOpen();
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
		const tail = logs.slice(-15);
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
		note(text) {
			note = text;
			if (noteTimer) clearTimeout(noteTimer);
			if (text) noteTimer = setTimeout(() => ((note = undefined), schedule()), 4000);
			schedule();
		},
		setStopping() {
			phase = "stopping";
			draw();
		},
		close: restore,
	};
}
