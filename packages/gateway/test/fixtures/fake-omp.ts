#!/usr/bin/env bun
/**
 * Minimal stand-in for `omp --mode rpc-ui`, speaking the documented protocol:
 * ready frame, v2 negotiation (with real chunked encoding via omp's encoder),
 * request/response correlation, a streamed turn and a UI dialog round trip.
 */
import { RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";

const encoder = new RpcFrameEncoder();
const write = (frame: object) => process.stdout.write(encoder.encode(frame));
const respond = (id: unknown, command: string, data?: unknown) => write({ type: "response", id, command, success: true, data });
const fail = (id: unknown, command: string, error: string, code?: string) =>
	write({ type: "response", id, command, success: false, error, code });

let pendingUi: ((response: Record<string, unknown>) => void) | null = null;

write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });

async function runTurn(id: unknown) {
	respond(id, "prompt", { agentInvoked: true });
	write({ type: "agent_start" });
	write({ type: "message_start", messageId: "u1", message: { role: "user", content: "hi", timestamp: Date.now() } });
	write({ type: "message_end", messageId: "u1", message: { role: "user", content: "hi", timestamp: Date.now() } });
	const partial = { role: "assistant", content: [{ type: "text", text: "Hel" }] };
	write({ type: "message_start", messageId: "a1", message: partial });
	write({ type: "message_update", messageId: "a1", message: partial, assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
	write({ type: "message_end", messageId: "a1", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
	const answer = await new Promise<Record<string, unknown>>(resolve => {
		pendingUi = resolve;
		write({ type: "extension_ui_request", id: "ui1", method: "select", title: "Pick", options: ["Red", "Green"] });
	});
	write({ type: "notice", level: "info", message: `picked=${String(answer.value)}` });
	write({ type: "agent_end", messages: [] });
	write({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
	write({ type: "session_settled" });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let nl = buffer.indexOf("\n");
	while (nl !== -1) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		nl = buffer.indexOf("\n");
		if (!line) continue;
		const cmd = JSON.parse(line) as Record<string, unknown>;
		switch (cmd.type) {
			case "negotiate_protocol":
				respond(cmd.id, "negotiate_protocol", { protocolVersion: 2 });
				encoder.setProtocolVersion(2);
				break;
			case "set_ask_dialog":
				respond(cmd.id, "set_ask_dialog", { enabled: true });
				break;
			case "get_state":
				respond(cmd.id, "get_state", { model: { id: "fake", provider: "test" }, sessionId: "s1", sessionFile: "/tmp/fake-session.jsonl", isStreaming: false });
				break;
			case "get_available_commands":
				respond(cmd.id, "get_available_commands", { commands: [{ name: "hello", source: "builtin" }] });
				break;
			case "switch_session":
				respond(cmd.id, "switch_session", { cancelled: false });
				break;
			case "get_env":
				respond(cmd.id, "get_env", {
					planPrefs: process.env.GYRE_PLAN_PREFS,
					browser: process.env.PLANNOTATOR_BROWSER,
					inbox: process.env.PLANNOTATOR_INBOX_TOOL,
					argv: process.argv.slice(2),
				});
				break;
			case "big":
				respond(cmd.id, "big", { blob: "x".repeat(1_500_000) });
				break;
			case "prompt":
				void runTurn(cmd.id);
				break;
			case "extension_ui_response": {
				const resolve = pendingUi as ((response: Record<string, unknown>) => void) | null;
				pendingUi = null;
				resolve?.(cmd);
				break;
			}
			default:
				fail(cmd.id, String(cmd.type), `Unknown command: ${String(cmd.type)}`, "unknown_command");
		}
	}
}
process.exit(0);
