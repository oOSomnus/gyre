import { describe, expect, test } from "bun:test";
import { isPlanSubmitAbort } from "../src/chat/planAbort";
import type { AgentMessage } from "../src/lib/omp";
import type { TranscriptItem } from "../src/store/chats";

const msg = (message: AgentMessage, key = Math.random().toString(36)): TranscriptItem => ({ kind: "message", key, message });
const call = (name: string, id = "c1"): AgentMessage => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: {} }] });
const result = (id: string, ok: boolean, isError = false): AgentMessage => ({ role: "toolResult", toolCallId: id, isError, details: { ok }, content: [] });
const aborted = (content: AgentMessage["content"] = []): AgentMessage => ({ role: "assistant", stopReason: "aborted", content });

function check(items: TranscriptItem[], results: Record<string, AgentMessage>): boolean {
	return isPlanSubmitAbort(items, items.length - 1, results);
}

describe("isPlanSubmitAbort", () => {
	test("hides the empty abort that follows a successful submit_plan", () => {
		const items = [msg(call("submit_plan")), { kind: "notice", key: "n", level: "info", message: "Plannotator ready", ts: 1 } as TranscriptItem, msg(aborted())];
		expect(check(items, { c1: result("c1", true) })).toBe(true);
		// Empty thinking/text blocks still count as empty.
		expect(check([msg(call("submit_plan")), msg(aborted([{ type: "thinking", thinking: " " }]))], { c1: result("c1", true) })).toBe(true);
	});

	test("keeps user aborts and real failures", () => {
		expect(check([msg(call("read")), msg(aborted())], { c1: result("c1", true) })).toBe(false);
		expect(check([msg(call("submit_plan")), msg(aborted([{ type: "text", text: "partial answer" }]))], { c1: result("c1", true) })).toBe(false);
		expect(check([msg(call("submit_plan")), msg(aborted())], { c1: result("c1", false) })).toBe(false);
		expect(check([msg(call("submit_plan")), msg(aborted())], { c1: result("c1", true, true) })).toBe(false);
		expect(check([msg(call("submit_plan")), msg(aborted())], {})).toBe(false);
		expect(check([msg(aborted())], {})).toBe(false);
		expect(check([msg(call("submit_plan")), msg({ role: "assistant", stopReason: "error", content: [] })], { c1: result("c1", true) })).toBe(false);
	});
});
