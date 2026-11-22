/**
 * Slash commands Gyre runs itself.
 *
 * Some omp builtins (`/new`, `/clear`, `/resume`, `/model`, `/settings`, …) are
 * implemented only in omp's TUI: they are missing from `get_available_commands`
 * and, typed over RPC, reach the model as plain text. Gyre intercepts the
 * useful ones and maps them onto RPC commands or its own panes. If a future omp
 * advertises a command with the same name, omp's version wins.
 */
import { gateway } from "../lib/gateway";
import type { SlashCommand } from "../lib/omp";
import { useApp } from "../store/app";
import { startFreshSession, useChats } from "../store/chats";

interface LocalCommand extends SlashCommand {
	run(chatId: string, args: string): Promise<void> | void;
}

function notice(chatId: string, level: "info" | "warning" | "error", message: string): void {
	useChats.getState().apply(chatId, { type: "notice", level, message });
}

async function freshSession(chatId: string, label: string, linkParent: boolean): Promise<void> {
	const chat = useChats.getState().chats[chatId];
	if (chat?.busy) {
		notice(chatId, "warning", `${label}: wait for the current response to finish, or stop it first.`);
		return;
	}
	const parentSession = linkParent ? chat?.info.sessionPath : undefined;
	const created = await startFreshSession(chatId, parentSession);
	if (!created) notice(chatId, "warning", `${label} was cancelled by an extension.`);
	else if (linkParent) notice(chatId, "info", parentSession ? "Context cleared. The previous conversation is still in Sessions." : "Context cleared.");
}

const LOCAL_COMMANDS: LocalCommand[] = [
	{
		name: "clear",
		description: "Clear the conversation context (previous conversation stays in Sessions)",
		source: "gyre",
		run: chatId => freshSession(chatId, "Clear", true),
	},
	{
		name: "new",
		description: "Start a new session in this pane",
		source: "gyre",
		run: chatId => freshSession(chatId, "New session", false),
	},
	{
		name: "resume",
		description: "Open the session list to resume an earlier session",
		source: "gyre",
		run: chatId => {
			const projectId = useChats.getState().chats[chatId]?.info.projectId;
			useApp.getState().addPane({ kind: "sessions", projectId });
		},
	},
	{
		name: "model",
		description: "Switch model for this chat",
		source: "gyre",
		run: chatId => useApp.getState().openModelPicker(chatId),
	},
	{
		name: "settings",
		description: "Open settings",
		source: "gyre",
		run: () => useApp.getState().addPane({ kind: "settings" }),
	},
];

/** Local commands not shadowed by a command omp advertises. */
export function localCommands(ompCommands: SlashCommand[]): SlashCommand[] {
	const taken = new Set(ompCommands.flatMap(c => [c.name, ...(c.aliases ?? [])]));
	return LOCAL_COMMANDS.filter(c => !taken.has(c.name));
}

/** The local command `text` invokes, bound to its arguments, or undefined when omp should handle it. */
export function findLocalCommand(chatId: string, text: string): (() => Promise<void>) | undefined {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	const ompCommands = useChats.getState().chats[chatId]?.commands ?? [];
	const command = LOCAL_COMMANDS.find(c => c.name === match[1] && localCommands(ompCommands).includes(c));
	if (!command) return undefined;
	return async () => command.run(chatId, match[2]?.trim() ?? "");
}

/** Runs `text` if it is a local command. Returns false when omp should handle it. */
export async function runLocalCommand(chatId: string, text: string): Promise<boolean> {
	const run = findLocalCommand(chatId, text);
	if (!run) return false;
	await run();
	return true;
}
