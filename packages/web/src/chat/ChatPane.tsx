import type { PaneSpec } from "@gyre/protocol";
import { ArrowDown, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { gateway } from "../lib/gateway";
import { stripAnsi } from "../lib/omp";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";
import { AssistantMessage, CommandOutputCard, EventRow, GenericMessage, NoticeCard, PlanBanner, UserCard } from "./Cards";
import { ChatStrip } from "./ChatStrip";
import { Composer } from "./Composer";
import { DialogCard } from "./DialogCard";
import { isPlanSubmitAbort } from "./planAbort";
import { Gyroscope } from "../shell/Gyroscope";

const opening = new Set<string>();

export function ensureChat(pane: PaneSpec, force = false): void {
	if (!pane.projectId) return;
	const existing = useChats.getState().chats[pane.id];
	if (!force && (existing?.info.status === "ready" || existing?.info.status === "starting" || opening.has(pane.id))) return;
	opening.add(pane.id);
	void gateway
		.openChat(pane.projectId, { chatId: pane.id, sessionPath: pane.sessionPath })
		.then(info => useChats.getState().setInfo(info))
		.catch(error =>
			useChats.getState().setInfo({
				chatId: pane.id,
				projectId: pane.projectId ?? "",
				cwd: "",
				status: "exited",
				error: String((error as Error).message),
			}),
		)
		.finally(() => opening.delete(pane.id));
}

export function ChatPane({ pane, focused }: { pane: PaneSpec; focused: boolean }) {
	const chat = useChats(s => s.chats[pane.id]);
	const updatePane = useApp(s => s.updatePane);
	const projects = useApp(s => s.projects);
	const scroller = useRef<HTMLDivElement>(null);
	const [stick, setStick] = useState(true);

	useEffect(() => {
		ensureChat(pane);
	}, [pane]);

	// Remember the bound session so the pane reopens it after restart.
	useEffect(() => {
		if (chat?.info.sessionPath && chat.info.sessionPath !== pane.sessionPath) updatePane(pane.id, { sessionPath: chat.info.sessionPath });
	}, [chat?.info.sessionPath, pane.id, pane.sessionPath, updatePane]);

	const onScroll = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
	}, []);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick) el.scrollTop = el.scrollHeight;
	});

	if (!pane.projectId)
		return (
			<div className="p-4">
				Select a project to start this chat.
				<select className="gy-input" value="" onChange={e => updatePane(pane.id, { projectId: e.target.value })}>
					<option value="" disabled>
						Select project
					</option>
					{projects.map(project => (
						<option key={project.id} value={project.id}>
							{project.name}
						</option>
					))}
				</select>
				<button type="button" className="gy-btn" onClick={() => useApp.getState().setAddProjectOpen(true)}>
					Add project
				</button>
			</div>
		);
	if (!chat) {
		return (
			<div className="flex h-full items-center justify-center gap-2" style={{ color: "var(--muted)" }}>
				<Loader2 size={16} className="animate-spin" /> Connecting…
			</div>
		);
	}

	const widgetsAbove = Object.entries(chat.widgets).filter(([, w]) => w.placement !== "belowEditor");
	const widgetsBelow = Object.entries(chat.widgets).filter(([, w]) => w.placement === "belowEditor");
	const visibleItems = chat.items.filter(
		item => !(item.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId && chat.toolResults[item.message.toolCallId]),
	);
	const latestDialog = chat.pendingUi[chat.pendingUi.length - 1];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2" style={{ background: "var(--panel)" }}>
				<div className="mx-auto flex max-w-[1080px] flex-col gap-2.5">
					{chat.info.status === "starting" && (
						<div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
							<Loader2 size={14} className="animate-spin" /> Starting omp in {chat.info.cwd || "project"}…
						</div>
					)}
					{chat.info.status === "ready" && chat.historyLoaded && !visibleItems.some(i => i.kind === "message" || i.kind === "command_output") && (
						<EmptyChat chatId={pane.id} />
					)}
					{visibleItems.map((item, index) => {
						switch (item.kind) {
							case "message": {
								const m = item.message;
								if (m.role === "user") return <UserCard key={item.key} message={m} chatId={pane.id} />;
								if (m.role === "assistant")
									return (
										<AssistantMessage
											key={item.key}
											message={m}
											streaming={!!item.streaming}
											toolExec={chat.toolExec}
											toolResults={chat.toolResults}
											chatId={pane.id}
											hideAbort={isPlanSubmitAbort(visibleItems, index, chat.toolResults)}
										/>
									);
								return <GenericMessage key={item.key} message={m} />;
							}
							case "command_output":
								return <CommandOutputCard key={item.key} text={item.text} ts={item.ts} />;
							case "notice":
								return <NoticeCard key={item.key} item={item} />;
							case "event":
								return <EventRow key={item.key} label={item.label} detail={item.detail} />;
							default:
								return null;
						}
					})}
					<PlanBanner chatId={pane.id} />
					{chat.pendingUi.map(request => (
						<DialogCard key={request.id} chatId={pane.id} request={request} active={focused && request === latestDialog} />
					))}
					{chat.info.status === "exited" && (
						<div className="gy-card notice error">
							<div className="gy-card-body space-y-2">
								<div className="text-[13px] font-medium">omp is not running</div>
								{chat.info.error && <pre className="gy-pre">{stripAnsi(chat.info.error)}</pre>}
								<button type="button" className="gy-btn" onClick={() => ensureChat(pane, true)} data-jump="restart">
									<RotateCw size={13} /> Restart
								</button>
							</div>
						</div>
					)}
				</div>
				{!stick && (
					<button
						type="button"
						className="gy-btn sticky bottom-2 left-full mr-2 shadow"
						onClick={() => {
							setStick(true);
							scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
						}}
					>
						<ArrowDown size={13} /> Latest
					</button>
				)}
			</div>
			<div className="w-full shrink-0 pt-1.5" style={{ background: "var(--panel)", borderTop: "1px solid var(--border-strong)" }}>
				{widgetsAbove.map(([key, w]) => (
					<pre key={key} className="mx-3 mb-1 font-mono text-[11.5px]" style={{ color: "var(--text-dim)" }}>
						{w.lines.map(stripAnsi).join("\n")}
					</pre>
				))}
				<ChatStrip chatId={pane.id} />
				<Composer chatId={pane.id} focused={focused} />
				{widgetsBelow.map(([key, w]) => (
					<pre key={key} className="mx-3 mb-1 font-mono text-[11.5px]" style={{ color: "var(--text-dim)" }}>
						{w.lines.map(stripAnsi).join("\n")}
					</pre>
				))}
			</div>
		</div>
	);
}

function EmptyChat({ chatId }: { chatId: string }) {
	const chat = useChats(s => s.chats[chatId]);
	const openPalette = useApp(s => s.openPalette);
	return (
		<div className="flex flex-col items-center gap-3 py-16 text-center">
			<Gyroscope state="idle" size={48} />
			<div className="text-[15px] font-medium">What are we building?</div>
			<div className="max-w-md text-[12.5px]" style={{ color: "var(--muted)" }}>
				Powered by omp {gateway.ompVersion ?? ""} · {chat?.commands.length ?? 0} commands available · model{" "}
				<span className="font-mono">{chat?.state?.model?.id ?? "…"}</span>
			</div>
			<div className="flex gap-2">
				<button type="button" className="gy-btn" onClick={() => openPalette("/")}>
					Browse commands <span className="gy-kbd">Ctrl K</span>
				</button>
			</div>
		</div>
	);
}
