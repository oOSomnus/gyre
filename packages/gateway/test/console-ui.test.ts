import { describe, expect, test } from "bun:test";
import { type ConsoleView, HEADER_ROWS, levelOf, parseKeys, renderFrame, renderHeader, sanitize, truncate, uptime, wrap } from "../src/console-ui";

const STATUS = { version: "1.2.3", ompVersion: "19.1.0", ompStatus: "ok" as const, clients: 1, chats: 2, busy: 1, terminals: 0 };

function view(over: Partial<ConsoleView> = {}): ConsoleView {
	return {
		cols: 100,
		rows: 10,
		url: "http://127.0.0.1:7341/#token=abc",
		phase: "running",
		status: STATUS,
		startedAt: 0,
		now: 65_000,
		logs: [],
		scroll: 0,
		...over,
	};
}

const plain = (text: string) => sanitize(text);
/** The screen as rows of visible text. */
const screen = (frame: string) => frame.split("\r\n").map(row => plain(row));

describe("console text", () => {
	test("sanitize strips escape sequences and controls, keeps text", () => {
		expect(sanitize("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\tz\x07")).toBe("red ok    z");
		expect(sanitize("a\x1b[2J\x1b[Hb")).toBe("ab");
	});
	test("wrap and truncate count terminal columns", () => {
		expect(wrap("abcdef", 4)).toEqual(["abcd", "ef"]);
		expect(wrap("", 4)).toEqual([""]);
		expect(wrap("日本語", 4)).toEqual(["日本", "語"]);
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("abc", 4)).toBe("abc");
	});
	test("uptime", () => {
		expect(uptime(5_000)).toBe("5s");
		expect(uptime(65_000)).toBe("1m 5s");
		expect(uptime(3_660_000)).toBe("1h 1m");
	});
	test("errors are told apart from routine stderr lines", () => {
		expect(levelOf("Chat 1234 exited (code 1): boom", "info")).toBe("error");
		expect(levelOf("Chat 1234 exited (code 0)", "info")).toBe("info");
		expect(levelOf("WebSocket dispatch failed: x", "info")).toBe("error");
		expect(levelOf("Browser connected (1 open)", "info")).toBe("info");
	});
});

describe("status bar", () => {
	test("shows the URL, status and counts on a coloured background, each row exactly the terminal width", () => {
		const [row1, row2] = renderHeader(view({ cols: 120 }));
		expect(row1).toContain("\x1b[48;5;24m");
		expect(row2).toContain("\x1b[48;5;236m");
		expect(plain(row1 ?? "")).toContain("http://127.0.0.1:7341/#token=abc");
		expect(plain(row1 ?? "")).toContain("● ready");
		expect(plain(row1 ?? "")).toContain("v1.2.3");
		expect(plain(row2 ?? "")).toContain("omp 19.1.0 · 2 chats (1 working) · 1 browser · 0 terminals · up 1m 5s");
		expect(plain(row2 ?? "")).toContain("o open · PgUp/PgDn scroll · q quit");
		for (const row of [row1, row2]) expect(Bun.stringWidth(plain(row ?? ""))).toBe(120);
	});
	test("reports omp problems and shutdown", () => {
		expect(plain(renderHeader(view({ status: { ...STATUS, ompStatus: "missing", ompVersion: null } }))[0] ?? "")).toContain("omp not installed");
		expect(plain(renderHeader(view({ status: { ...STATUS, ompStatus: "no-models" } }))[0] ?? "")).toContain("no model provider");
		expect(plain(renderHeader(view({ phase: "stopping" }))[0] ?? "")).toContain("stopping…");
	});
	test("narrow terminals shorten the URL, then drop the version and hints, never overflow", () => {
		for (const cols of [20, 40, 60, 80, 100]) {
			for (const row of renderHeader(view({ cols }))) expect(Bun.stringWidth(plain(row))).toBe(cols);
		}
		expect(plain(renderHeader(view({ cols: 40 }))[0] ?? "")).not.toContain("v1.2.3");
	});
});

describe("frame", () => {
	const logs = Array.from({ length: 30 }, (_, i) => ({ at: 0, level: "info" as const, text: `line ${i}` }));

	test("the log fills the rows under the status bar and follows the newest line", () => {
		const rows = screen(renderFrame(view({ logs })));
		expect(rows).toHaveLength(10);
		expect(rows.slice(HEADER_ROWS).map(r => r.trim().split(/\s+/).slice(1).join(" "))).toEqual(logs.slice(-8).map(l => l.text));
	});
	test("scrolling shows older lines and the hint says how to follow again", () => {
		const rows = screen(renderFrame(view({ logs, scroll: 5 })));
		expect(rows.at(-1)).toContain("line 24");
		expect(rows[1]).toContain("End: follow log");
		// Scrolling past the oldest line stops at it.
		expect(screen(renderFrame(view({ logs, scroll: 999 })))[HEADER_ROWS]).toContain("line 0");
	});
	test("long lines wrap under the timestamp column; an empty log leaves blank rows", () => {
		const rows = screen(renderFrame(view({ cols: 30, logs: [{ at: 0, level: "info", text: "x".repeat(30) }] })));
		expect(rows.slice(HEADER_ROWS).filter(r => r.includes("x"))).toHaveLength(2);
		expect(screen(renderFrame(view()))).toHaveLength(10);
	});
	test("errors are red", () => {
		expect(renderFrame(view({ logs: [{ at: 0, level: "error", text: "boom" }] }))).toContain("\x1b[31mboom");
	});
});

describe("keys", () => {
	test("raw terminal input maps to console keys; unknown sequences are skipped whole", () => {
		expect(parseKeys("\x1b[5~\x1b[6~\x1b[A\x1b[B")).toEqual(["pageUp", "pageDown", "up", "down"]);
		expect(parseKeys("\x1b[H\x1b[F\x1b[1~\x1b[4~")).toEqual(["top", "bottom", "top", "bottom"]);
		expect(parseKeys("q")).toEqual(["quit"]);
		expect(parseKeys("\x03")).toEqual(["quit"]);
		expect(parseKeys("o")).toEqual(["open"]);
		expect(parseKeys("\x1b[1;5Cq")).toEqual(["quit"]);
		expect(parseKeys("x")).toEqual([]);
	});
});
