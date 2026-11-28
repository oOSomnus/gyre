/** Review pane helpers: which turns can be reviewed, and turning line comments into a message. */
import type { TurnRecord, TurnsState } from "@gyre/protocol";

export type ReviewMode = "turn" | "since";

export interface ReviewComment {
	id: string;
	turn: number;
	path: string;
	line: number;
	text: string;
}

/** Turns with a "before" snapshot, newest first. */
export function reviewableTurns(state: TurnsState | null | undefined): TurnRecord[] {
	return [...(state?.turns ?? [])].filter(t => !!t.before).reverse();
}

/** A finished turn whose snapshots differ: it changed files. */
export const turnChanged = (turn: TurnRecord) => !!turn.before && !!turn.after && turn.before !== turn.after;

/** The latest finished turn, if it changed files (the chat strip's "Review changes" button). */
export function latestChangedTurn(state: TurnsState | null | undefined): TurnRecord | undefined {
	const last = [...(state?.turns ?? [])].reverse().find(t => t.endedAt !== undefined);
	return last && turnChanged(last) ? last : undefined;
}

/** The tree range a mode compares: the turn's own change, or everything since it started. */
export function rangeFor(turn: TurnRecord, mode: ReviewMode): { from: string; to: string } | null {
	if (!turn.before) return null;
	if (mode === "turn") return turn.after ? { from: turn.before, to: turn.after } : null;
	return { from: turn.before, to: "worktree" };
}

/**
 * The message sent to the chat for a set of review comments, grouped by file in line order.
 * Comments from more than one turn are grouped by turn first, since a line number only
 * means something within the turn it was made on.
 */
export function commentsMessage(comments: ReviewComment[]): string {
	if (!comments.length) return "";
	const turns = [...new Set(comments.map(c => c.turn))].sort((a, b) => a - b);
	const lines = [`Review of your changes (turn${turns.length > 1 ? "s" : ""} ${turns.join(", ")}):`, ""];
	for (const turn of turns) {
		if (turns.length > 1) lines.push(`Turn ${turn}:`);
		const byPath = new Map<string, ReviewComment[]>();
		for (const c of comments) if (c.turn === turn) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
		for (const [path, list] of byPath) {
			for (const c of list.sort((a, b) => a.line - b.line)) lines.push(`- ${path}:${c.line} — ${c.text.trim()}`);
		}
	}
	lines.push("", "Please address these comments.");
	return lines.join("\n");
}

export function timeLabel(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.floor((now - ms) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return new Date(ms).toLocaleDateString();
}
