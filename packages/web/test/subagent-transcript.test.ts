import { expect, test } from "bun:test";
import type { AgentMessage } from "../src/lib/omp";
import {
	createSubagentWatchers,
	emptySubagentTranscript,
	foldSessionEvent,
	foldSubagentEvent,
	mergeSubagentMessages,
	type SessionEvent,
	type SubagentTranscript,
} from "../src/store/session-events";

const assistant = (text: string, timestamp?: number): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp }) as AgentMessage;
const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp }) as AgentMessage;
const fold = (events: SessionEvent[], from: SubagentTranscript = emptySubagentTranscript()) => events.reduce((t, e) => foldSubagentEvent(t, e, 1), from);
const texts = (t: SubagentTranscript) =>
	t.items.flatMap(item => (item.kind === "message" ? [`${item.message.role}:${JSON.stringify(item.message.content)}${item.streaming ? "…" : ""}`] : []));

test("keys sub-agent messages without a messageId the way omp does", () => {
	const t = fold([
		{ type: "agent_start" },
		{ type: "message_start", message: user("go", 1) },
		{ type: "message_end", message: user("go", 1) },
		{ type: "message_start", message: assistant("He") },
		{ type: "message_update", message: assistant("Hell") },
	]);
	expect(t.busy).toBe(true);
	expect(t.live).toBe(true);
	expect(t.items).toHaveLength(2);
	expect(t.items[1]).toMatchObject({ kind: "message", streaming: true, message: { content: [{ text: "Hell" }] } });

	const done = fold([{ type: "message_end", message: assistant("Hello", 2) }, { type: "agent_end" }], t);
	expect(done.items).toHaveLength(2);
	expect(done.items[1]).toMatchObject({ streaming: false, message: { content: [{ text: "Hello" }] } });
	expect(done.busy).toBe(false);
	expect(done.openKeys).toEqual([]);
});

test("an update or end without a start still lands in its own item", () => {
	const t = fold([{ type: "message_update", message: assistant("a") }, { type: "message_end", message: assistant("a", 5) }, { type: "message_end", message: user("b", 6) }]);
	expect(texts(t)).toEqual(['assistant:[{"type":"text","text":"a"}]', 'user:"b"']);
});

test("tool executions run, stream partial output and finish, like the main chat", () => {
	const t = fold([
		{ type: "tool_execution_start", toolCallId: "c1", args: { cmd: "ls" }, intent: "list" },
		{ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "a" }] } },
	]);
	expect(t.toolExec.c1).toMatchObject({ status: "running", intent: "list", partial: { content: [{ text: "a" }] } });
	const done = fold([{ type: "tool_execution_end", toolCallId: "c1", isError: true, result: "boom" }], t);
	expect(done.toolExec.c1).toMatchObject({ status: "error", result: "boom", endedAt: 1 });
});

test("the main chat keeps keying messages by messageId", () => {
	const view = { items: [], toolExec: {}, toolResults: {} };
	const a = foldSessionEvent(view, { type: "message_start", messageId: "x", message: assistant("1") }, "mx");
	const b = foldSessionEvent(a, { type: "message_end", messageId: "x", message: { role: "toolResult", toolCallId: "c", content: [] } as AgentMessage }, "mx");
	expect(b.items).toHaveLength(1);
	expect(b.toolResults.c).toBeDefined();
});

test("merging the session file does not repeat messages that arrived live", () => {
	const liveOnly = fold([
		{ type: "message_end", message: user("go", 1) },
		{ type: "message_end", message: assistant("first", 2) },
		{ type: "message_start", message: assistant("sec") },
	]);
	const merged = mergeSubagentMessages(liveOnly, [user("go", 1), assistant("first", 2)]);
	expect(texts(merged)).toEqual(['user:"go"', 'assistant:[{"type":"text","text":"first"}]', 'assistant:[{"type":"text","text":"sec"}]…']);
	expect(merged.seeded).toBe(true);
});

test("history read after the view opened goes before the message still streaming", () => {
	const streaming = fold([{ type: "message_start", message: assistant("now") }]);
	const merged = mergeSubagentMessages(streaming, [user("task", 1), { role: "toolResult", toolCallId: "c9", content: [], timestamp: 2 } as AgentMessage]);
	expect(texts(merged)).toEqual(['user:"task"', 'toolResult:[]', 'assistant:[{"type":"text","text":"now"}]…']);
	expect(merged.toolResults.c9).toBeDefined();
	// Keys stay unique across merges and live events.
	const again = fold([{ type: "message_end", message: assistant("now!", 3) }], mergeSubagentMessages(merged, [user("more", 4)]));
	const keys = again.items.map(item => item.key);
	expect(new Set(keys).size).toBe(keys.length);
});

test("a reset replaces finished messages with the file and keeps the one streaming", () => {
	const t = mergeSubagentMessages(fold([{ type: "message_start", message: assistant("live") }]), [user("old", 1)]);
	const reset = mergeSubagentMessages(t, [user("new", 9)], true);
	expect(texts(reset)).toEqual(['user:"new"', 'assistant:[{"type":"text","text":"live"}]…']);
});

test("older history read after live messages goes before them, in time order", () => {
	const live = fold([
		{ type: "message_end", message: assistant("live 5", 5) },
		{ type: "message_end", message: assistant("live 9", 9) },
	]);
	const merged = mergeSubagentMessages(live, [user("task", 1), assistant("file 7", 7), assistant("live 9", 9), assistant("file 12", 12)]);
	expect(texts(merged)).toEqual([
		'user:"task"',
		'assistant:[{"type":"text","text":"live 5"}]',
		'assistant:[{"type":"text","text":"file 7"}]',
		'assistant:[{"type":"text","text":"live 9"}]',
		'assistant:[{"type":"text","text":"file 12"}]',
	]);
	// Live keys are kept.
	expect(merged.items.filter(item => item.key.startsWith("s"))).toHaveLength(2);
});

test("a finished message in the file ends its partial live copy, and a late live end does not add another", () => {
	const t = fold([{ type: "message_start", message: assistant("par", 3) }, { type: "message_update", message: assistant("parti", 3) }]);
	const merged = mergeSubagentMessages(t, [assistant("partial done", 3)]);
	expect(texts(merged)).toEqual(['assistant:[{"type":"text","text":"partial done"}]']);
	expect(merged.openKeys).toEqual([]);
	const late = fold([{ type: "message_end", message: assistant("partial done", 3) }], merged);
	expect(late.items).toHaveLength(1);
	expect(late.items[0]!.key).toBe(t.items[0]!.key);
});

test("tool results that end in the same millisecond stay separate", () => {
	const result = (id: string) => ({ role: "toolResult", toolCallId: id, content: [], timestamp: 4 }) as AgentMessage;
	const t = fold([
		{ type: "message_start", message: result("a") },
		{ type: "message_end", message: result("a") },
		{ type: "message_start", message: result("b") },
		{ type: "message_end", message: result("b") },
	]);
	expect(t.items).toHaveLength(2);
	expect(mergeSubagentMessages(t, [result("a"), result("b")]).items).toHaveLength(2);
});

test("subscribes a chat at events while any of its sub-agent views is open", () => {
	const changes: string[] = [];
	const watchers = createSubagentWatchers((chatId, level) => changes.push(`${chatId}=${level}`));
	expect(watchers.level("c")).toBe("progress");
	const one = watchers.watch("c");
	const two = watchers.watch("c");
	expect(watchers.level("c")).toBe("events");
	one();
	one();
	expect(watchers.level("c")).toBe("events");
	two();
	expect(watchers.level("c")).toBe("progress");
	expect(changes).toEqual(["c=events", "c=progress"]);
});
