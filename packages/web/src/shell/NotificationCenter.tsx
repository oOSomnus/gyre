/** The top bar's bell: unread count, and a popover listing notifications (Alt+N). */
import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, Bell, CheckCheck, CircleCheck, ClipboardList, Cpu, MessageCircleQuestion, Trash2, XCircle } from "lucide-react";
import type { NotificationKind } from "../lib/notifications";
import { timeLabel } from "../lib/review";
import { useChats } from "../store/chats";
import { openNotification, useNotifications } from "../store/notifications";

const ICONS: Record<NotificationKind, typeof Bell> = {
	"needs-you": MessageCircleQuestion,
	done: CircleCheck,
	error: XCircle,
	plan: ClipboardList,
	job: Cpu,
	warning: AlertTriangle,
};
const COLORS: Partial<Record<NotificationKind, string>> = { "needs-you": "var(--st-waiting)", error: "var(--err)", warning: "var(--warn)", done: "var(--ok)" };

export function NotificationCenter({ onJumpToWaiting }: { onJumpToWaiting: () => void }) {
	const { items, open, setOpen, markAllRead, clear } = useNotifications();
	const unread = items.filter(n => !n.read).length;
	// Chats waiting on the user right now (questions, approvals, plan reviews) keep the badge hot.
	const waiting = useChats(s => Object.values(s.chats).filter(c => c.pendingUi.length > 0 || c.plan?.phase === "reviewing").length);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="gy-chrome-icon relative shrink-0"
					title={`Notifications (Alt+N)${waiting ? ` · ${waiting} chat(s) need you` : ""}`}
					data-jump="needs-you"
					data-testid="notifications"
				>
					<Bell size={14} />
					{/* The count is chats waiting on the user; a dot marks unread notifications. */}
					<span className={`gy-badge ${waiting ? "hot" : ""}`}>{waiting}</span>
					{unread > 0 && (
						<span
							className="absolute top-0.5 left-0.5 h-2 w-2 rounded-full border border-black"
							style={{ background: "var(--highlight)" }}
							title={`${unread} unread`}
							data-unread={unread}
						/>
					)}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content sideOffset={8} align="end" className="gy-menu z-50 flex max-h-[70vh] w-[360px] max-w-[92vw] flex-col p-0" data-notification-center>
					<div className="flex items-center gap-1 border-b px-2 py-1.5" style={{ borderColor: "var(--border-strong)" }}>
						<span className="flex-1 font-mono text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--muted)" }}>
							Notifications {unread ? `· ${unread} new` : ""}
						</span>
						<button type="button" className="gy-btn" disabled={!unread} onClick={markAllRead} title="Mark all read">
							<CheckCheck size={11} />
						</button>
						<button type="button" className="gy-btn" disabled={!items.length} onClick={clear} title="Clear all">
							<Trash2 size={11} />
						</button>
					</div>
					{waiting > 0 && (
						<button
							type="button"
							className="gy-row w-full text-left text-[12.5px]"
							style={{ background: "var(--panel-3)" }}
							onClick={() => {
								setOpen(false);
								onJumpToWaiting();
							}}
						>
							<MessageCircleQuestion size={14} style={{ color: "var(--st-waiting)" }} />
							<span className="flex-1">
								{waiting} chat{waiting === 1 ? "" : "s"} need{waiting === 1 ? "s" : ""} you: go there
							</span>
						</button>
					)}
					<div className="min-h-0 flex-1 overflow-auto">
						{items.length === 0 && (
							<div className="p-4 text-center text-[12px]" style={{ color: "var(--muted)" }}>
								Nothing yet. Finished runs, questions, plan reviews, background jobs and errors show up here.
							</div>
						)}
						{items.map(n => {
							const Icon = ICONS[n.kind] ?? Bell;
							return (
								<button
									type="button"
									key={n.id}
									className="flex w-full gap-2 border-b px-2 py-1.5 text-left"
									style={{ borderColor: "var(--border)", background: n.read ? undefined : "var(--tint-tool)" }}
									onClick={() => {
										setOpen(false);
										openNotification(n);
									}}
									data-notification={n.kind}
								>
									<Icon size={14} className="mt-0.5 shrink-0" style={{ color: COLORS[n.kind] }} />
									<div className="min-w-0 flex-1">
										<div className="flex gap-2 text-[12.5px]">
											<span className="min-w-0 flex-1 truncate font-medium">{n.title}</span>
											<span className="shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>
												{timeLabel(n.ts)}
											</span>
										</div>
										{n.body && (
											<div className="line-clamp-2 text-[11.5px]" style={{ color: "var(--text-dim)" }}>
												{n.body}
											</div>
										)}
									</div>
								</button>
							);
						})}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
