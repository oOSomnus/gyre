/**
 * Session listing.
 *
 * omp's RPC protocol has no "list sessions" command, so this is the one place the
 * gateway uses an in-process omp API (`SessionManager.list`). It is imported
 * lazily and isolated here; see docs/architecture.md ("Coupling points").
 */
import type { SessionSummary } from "@gyre/protocol";

type SessionManagerModule = typeof import("@oh-my-pi/pi-coding-agent/session/session-manager");

let modulePromise: Promise<SessionManagerModule> | null = null;

function loadSessionManager(): Promise<SessionManagerModule> {
	modulePromise ??= import("@oh-my-pi/pi-coding-agent/session/session-manager");
	return modulePromise;
}

function toSummary(info: Record<string, unknown>): SessionSummary {
	const asIso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? ""));
	return {
		path: String(info.path),
		id: String(info.id),
		cwd: String(info.cwd ?? ""),
		created: asIso(info.created),
		modified: asIso(info.modified),
		messageCount: Number(info.messageCount ?? 0),
		firstMessage: String(info.firstMessage ?? ""),
		title: typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : undefined,
		status: typeof info.status === "string" ? info.status : undefined,
	};
}

export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
	const { SessionManager } = await loadSessionManager();
	const infos = (cwd ? await SessionManager.list(cwd) : await SessionManager.listAll()) as unknown as Array<
		Record<string, unknown>
	>;
	return infos.map(toSummary).sort((a, b) => b.modified.localeCompare(a.modified));
}
