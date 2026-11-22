import { describe, expect, test } from "bun:test";
import { buildSessionLog, clip, fence, type SessionLogInput } from "../src/lib/sessionLog";

function input(overrides: Partial<SessionLogInput> = {}): SessionLogInput {
	return {
		exportedAt: Date.UTC(2026, 10, 21, 12, 0, 0),
		chatId: "chat-1",
		projectName: "cse594",
		info: { chatId: "chat-1", projectId: "p1", cwd: "/work/cse594", status: "ready", sessionPath: "/s/session.jsonl", generation: "g1" },
		state: { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "max", sessionFile: "/s/session.jsonl" },
		plan: { phase: "reviewing", title: "Health checks", planFilePath: "local://x-plan.md", planContent: "# Plan\n- step", revision: 1, updatedAt: 1 },
		messages: [
			{ role: "user", timestamp: 1, content: [{ type: "text", text: "propose a plan" }] },
			{
				role: "assistant",
				timestamp: 2,
				model: "gpt-6.1-sol",
				provider: "openai-codex",
				stopReason: "toolUse",
				content: [
					{ type: "thinking", thinking: "**Submitting revision 2**" },
					{ type: "toolCall", id: "c1", name: "submit_plan", arguments: { plan: "local://x-plan.md", title: "Health checks" } },
					{ type: "image", mimeType: "image/png", data: "A".repeat(4096) },
				],
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "submit_plan", timestamp: 3, details: { ok: true, revision: 1 }, content: [{ type: "text", text: "R".repeat(20_000) }] },
			{ role: "custom", customType: "gyre-plan-reminder", display: false, timestamp: 4, content: "<system-reminder>keep going</system-reminder>" },
			{ role: "assistant", timestamp: 5, stopReason: "aborted", content: [{ type: "text", text: "code:\n```ts\nx\n```" }] },
		],
		items: [{ kind: "notice", key: "n1", level: "info", message: "Plannotator session ready: http://localhost:45076", ts: 6 }],
		toolExec: { c1: { status: "done", startedAt: 2_000, endedAt: 2_500 } },
		widgets: { "gyre.plan": { lines: ['{"phase":"reviewing"}'] } },
		statuses: {},
		pendingUi: [],
		queue: { steering: [], followUp: [] },
		frames: [{ ts: 7, frame: { type: "tool_execution_end", toolName: "submit_plan" } }],
		...overrides,
	};
}

describe("buildSessionLog", () => {
	test("renders every section with history, hidden messages and frames", () => {
		const log = buildSessionLog(input());
		for (const heading of ["# Gyre session log", "## Plan state", "## Transcript", "## Gyre UI events", "## UI state", "## Raw omp frames (last 1 of 1"]) {
			expect(log).toContain(heading);
		}
		expect(log).toContain("openai-codex/gpt-6.1-sol · thinking max");
		expect(log).toContain("### #4 · custom");
		expect(log).toContain("custom: gyre-plan-reminder · (hidden from UI)");
		expect(log).toContain("**tool call** `submit_plan` (c1)");
		expect(log).toContain("done · 1970-01-01T00:00:02.000Z → 1970-01-01T00:00:02.500Z (0.5s)");
		expect(log).toContain("> **Submitting revision 2**");
		expect(log).toContain("[image omitted: image/png, ~3 KB]");
		expect(log).not.toContain("A".repeat(100));
		expect(log).toContain("chars omitted");
		expect(log).not.toContain("R".repeat(PAYLOAD));
		expect(log).toContain("stop: aborted");
		expect(log).toContain("notice/info: Plannotator session ready");
		expect(log).toContain("tool_execution_end");
		// planContent is shown once, as its own block, not inside the state JSON.
		expect(log).toContain("Plan content (revision 1)");
		expect(log.match(/- step/g)).toHaveLength(1);
	});

	test("fences survive content with backticks", () => {
		expect(fence("a\n```ts\nx\n```")).toStartWith("````\n");
		expect(fence("plain", "json")).toStartWith("```json\n");
		const log = buildSessionLog(input());
		expect(log).toContain("````\ncode:\n```ts");
	});

	test("clip keeps head and tail", () => {
		const text = `${"h".repeat(50)}${"m".repeat(1000)}${"t".repeat(50)}`;
		const clipped = clip(text, 100);
		expect(clipped.startsWith("h".repeat(50))).toBe(true);
		expect(clipped.endsWith("t".repeat(40))).toBe(true);
		expect(clipped).toContain("[1000 chars omitted]");
		expect(clip("short", 100)).toBe("short");
	});

	test("reports collection warnings and empty state", () => {
		const log = buildSessionLog(input({ messages: [], plan: null, items: [], frames: [], state: undefined, warnings: ["get_messages failed (timeout)"] }));
		expect(log).toContain("**warning:** get_messages failed (timeout)");
		expect(log).toContain("_No plan state._");
		expect(log).toContain("_No messages._");
		expect(log).toContain("Model: ? · thinking ?");
	});
});

const PAYLOAD = 9_000;
