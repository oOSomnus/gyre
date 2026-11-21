/** A single message kept visible in its own pane ("view"), or edited and sent back ("review"). */
import type { PaneSpec } from "@gyre/protocol";
import { Send } from "lucide-react";
import { useState } from "react";
import { time } from "../chat/Cards";
import { CopyButton, Markdown } from "../chat/Markdown";
import { sendReview, snapshots } from "../store/actions";
import { useApp } from "../store/app";

export function MessagePane({ pane }: { pane: PaneSpec }) {
	const snap = pane.ref ? snapshots.get(pane.ref) : undefined;
	const [draft, setDraft] = useState(snap?.text ?? "");
	const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
	const reviewing = pane.section === "review";
	if (!snap) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-[12.5px]" style={{ color: "var(--muted)", background: "var(--panel)" }}>
				This message is no longer in memory. Open it again from the chat.
			</div>
		);
	}
	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			<div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "var(--border-strong)", background: snap.role === "user" ? "var(--tint-user)" : "var(--tint-assistant)" }}>
				<span className="font-mono text-[11.5px] font-semibold tracking-widest uppercase">{reviewing ? "Review" : snap.role}</span>
				{snap.model && <span className="font-mono text-[10.5px]" style={{ color: "var(--muted)" }}>{snap.model}</span>}
				<span className="flex-1" />
				<span className="font-mono text-[11px]">{time(snap.timestamp)}</span>
				<CopyButton text={reviewing ? draft : snap.text} />
				{!reviewing && pane.chatId && (
					<button type="button" className="gy-btn" onClick={() => useApp.getState().updatePane(pane.id, { section: "review" })}>
						Review
					</button>
				)}
			</div>
			{reviewing ? (
				<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
					<div className="text-[12px]" style={{ color: "var(--text-dim)" }}>
						Edit the reply, then send it back. The agent treats your version as authoritative.
					</div>
					<textarea className="gy-input min-h-0 flex-1 py-2 font-mono text-[12.5px]" value={draft} onChange={e => setDraft(e.target.value)} data-testid="review-editor" />
					<div className="flex items-center gap-2">
						<span className="flex-1 text-[12px]" style={{ color: state.startsWith("err:") ? "var(--err)" : "var(--muted)" }}>
							{state === "sent" ? "Sent to the agent." : state.startsWith("err:") ? state.slice(4) : ""}
						</span>
						<button
							type="button"
							className="gy-btn primary"
							disabled={!pane.chatId || state === "sending" || draft.trim() === snap.text.trim()}
							onClick={() => {
								if (!pane.chatId) return;
								setState("sending");
								void sendReview(pane.chatId, snap.text, draft)
									.then(() => setState("sent"))
									.catch(e => setState(`err:${(e as Error).message}`));
							}}
						>
							<Send size={12} /> Send as reply
						</button>
					</div>
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto p-4">
					<div className="gy-card">
						<div className="gy-card-body">
							<Markdown text={snap.text} chatId={pane.chatId} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
