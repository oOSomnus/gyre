/**
 * Plan review pane (Gyre plan mode). Shows Plannotator's review page when
 * the Plannotator omp extension is installed, otherwise Gyre's own review
 * card. The toolbar holds the execution choices (role + context) that the
 * Gyre omp extension applies on approval.
 */
import type { PaneSpec, PlanPrefs } from "@gyre/protocol";
import { Check, ClipboardList, ExternalLink, History, Loader2, MessageSquareWarning, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown";
import { api, gateway } from "../lib/gateway";
import { sameSiteReviewUrl } from "../lib/plannotatorUrl";
import { useRoles } from "../lib/roles";
import { useChats } from "../store/chats";

interface Revision {
	revision: number;
	title?: string;
	content: string;
}
/** Earlier revisions per chat (this UI session). */
const history = new Map<string, Revision[]>();

function sendControl(chatId: string, body: Record<string, unknown>) {
	return gateway.rpc(chatId, { type: "prompt", message: `/gyre-plan ${JSON.stringify(body)}` }, 120_000);
}

function splitSections(markdown: string): Array<{ heading: string; body: string }> {
	const lines = markdown.split("\n");
	const sections: Array<{ heading: string; body: string }> = [];
	let current = { heading: "", body: "" };
	for (const line of lines) {
		if (/^#{1,3}\s/.test(line)) {
			if (current.heading || current.body.trim()) sections.push(current);
			current = { heading: line.replace(/^#+\s*/, ""), body: `${line}\n` };
		} else {
			current.body += `${line}\n`;
		}
	}
	if (current.heading || current.body.trim()) sections.push(current);
	return sections;
}

export function PlanPane({ pane }: { pane: PaneSpec }) {
	const chatId = pane.chatId ?? "";
	const plan = useChats(s => s.chats[chatId]?.plan ?? null);
	const status = useChats(s => s.chats[chatId]?.info.status);
	const hasExtension = useChats(s => s.chats[chatId]?.commands.some(c => c.name === "gyre-plan") ?? false);
	const { roles } = useRoles();
	const [prefs, setPrefs] = useState<PlanPrefs>({ role: "default", context: "compact" });
	const [comments, setComments] = useState<Record<number, string>>({});
	const [overall, setOverall] = useState("");
	const [prefRetry, setPrefRetry] = useState(0);
	const [prefsLoaded, setPrefsLoaded] = useState(false);
	const [savingPrefs, setSavingPrefs] = useState(false);
	const prefWrites = useRef<Promise<unknown>>(Promise.resolve());
	const actionPending = useRef(false);
	const prefGeneration = useRef(0);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [useNative, setUseNative] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [task, setTask] = useState("");
	const lastRevision = useRef<Revision | null>(null);

	useEffect(() => {
		if (!chatId) return;
		const generation = ++prefGeneration.current;
		setPrefsLoaded(false);
		// A save for the previous context can no longer clear this flag (its generation is stale).
		setSavingPrefs(false);
		setError(null);
		void api<PlanPrefs>(`/api/chats/${encodeURIComponent(chatId)}/plan-prefs`)
			.then(value => {
				if (prefGeneration.current === generation) {
					setPrefs(value);
					setPrefsLoaded(true);
				}
			})
			.catch(e => {
				if (prefGeneration.current === generation) setError((e as Error).message);
			});
		return () => {
			prefGeneration.current++;
		};
	}, [chatId, prefRetry]);

	// Track revisions so replaced plans collapse into history.
	useEffect(() => {
		if (!plan?.planContent || !plan.revision) return;
		const prev = lastRevision.current;
		if (prev && prev.revision !== plan.revision) history.set(chatId, [prev, ...(history.get(chatId) ?? [])].slice(0, 20));
		lastRevision.current = { revision: plan.revision, title: plan.title, content: plan.planContent };
		setComments({});
		setOverall("");
	}, [chatId, plan?.revision, plan?.planContent, plan?.title]);

	const sections = useMemo(() => splitSections(plan?.planContent ?? ""), [plan?.planContent]);

	const savePrefs = (next: PlanPrefs) => {
		if (!prefsLoaded || actionPending.current) return;
		setPrefs(next);
		setSavingPrefs(true);
		const generation = prefGeneration.current;
		const save = prefWrites.current
			.catch(() => {})
			.then(() => api(`/api/chats/${encodeURIComponent(chatId)}/plan-prefs`, { method: "PUT", body: JSON.stringify(next) }));
		const tail = save.catch(() => {});
		prefWrites.current = tail;
		void save
			.catch(e => {
				if (generation === prefGeneration.current) setError((e as Error).message);
			})
			.finally(() => {
				if (prefWrites.current === tail && generation === prefGeneration.current) setSavingPrefs(false);
			});
	};

	const act = async (label: string, body: Record<string, unknown>) => {
		if (actionPending.current || !prefsLoaded) return;
		actionPending.current = true;
		setPending(label);
		setError(null);
		try {
			await prefWrites.current;
			await api(`/api/chats/${encodeURIComponent(chatId)}/plan-prefs`, { method: "PUT", body: JSON.stringify(prefs) });
			await sendControl(chatId, { ...body, revision: plan?.revision });
		} catch (e) {
			setError(String((e as Error).message));
		} finally {
			actionPending.current = false;
			setPending(null);
		}
	};

	const feedback = () => {
		const parts = sections.map((section, i) => (comments[i]?.trim() ? `On "${section.heading || "intro"}":\n${comments[i]?.trim()}` : "")).filter(Boolean);
		if (overall.trim()) parts.push(overall.trim());
		return parts.join("\n\n");
	};

	if (!chatId) return <Empty text="This plan pane is not attached to a chat." />;
	if (!hasExtension && status === "ready")
		return <Empty text="Plan mode needs Gyre's omp extension, which this chat did not load. Restart the gateway with GYRE_OMP_EXTENSION unset." />;

	const reviewing = plan?.phase === "reviewing";
	const showIframe = reviewing && plan?.reviewUrl && !useNative;
	// Same loopback host as this page, so Plannotator's settings cookies persist across reviews.
	const reviewUrl = plan?.reviewUrl ? sameSiteReviewUrl(plan.reviewUrl, window.location.hostname) : undefined;
	const chatRoles = roles.filter(r => r.section === "chat");

	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			{/* toolbar */}
			<div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5" style={{ borderColor: "var(--border-strong)", background: "var(--panel-2)" }}>
				<ClipboardList size={14} />
				<span className={`gy-chip ${reviewing ? "warn" : plan?.phase === "executing" ? "ok" : plan?.phase === "planning" ? "info" : ""}`}>
					{plan?.phase ?? "idle"}
				</span>
				{plan?.revision ? <span className="gy-label">rev {plan.revision}</span> : null}
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{plan?.title ?? (plan?.phase === "planning" ? "Planning…" : "No plan yet")}</span>
				<label className="flex items-center gap-1.5">
					<span className="gy-label">Continue with</span>
					<select
						className="gy-input h-7 text-[12px]"
						disabled={!prefsLoaded || pending !== null}
						value={prefs.role}
						onChange={e => savePrefs({ ...prefs, role: e.target.value })}
						data-testid="plan-role"
					>
						{chatRoles.map(role => (
							<option key={role.id} value={role.id}>
								{role.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-1.5">
					<span className="gy-label">Context</span>
					<select
						className="gy-input h-7 text-[12px]"
						disabled={!prefsLoaded || pending !== null}
						value={prefs.context}
						onChange={e => savePrefs({ ...prefs, context: e.target.value as PlanPrefs["context"] })}
						data-testid="plan-context"
					>
						<option value="fresh">Fresh (clear session)</option>
						<option value="compact">Compact, then execute</option>
						<option value="keep">Keep full context</option>
					</select>
				</label>
				{(history.get(chatId)?.length ?? 0) > 0 && (
					<button type="button" className="gy-icon-btn" title="Earlier revisions" onClick={() => setShowHistory(h => !h)}>
						<History size={14} />
					</button>
				)}
			</div>
			{!prefsLoaded && error && <button type="button" className="gy-btn" onClick={() => setPrefRetry(n => n + 1)}>Retry preferences</button>}
			{error && (
				<div className="px-3 py-1.5 text-[12px]" style={{ background: "var(--tint-error)" }}>
					{error}
				</div>
			)}
			{plan?.error && (
				<div className="px-3 py-1.5 text-[12px]" style={{ background: "var(--tint-error)" }}>
					{plan.error}
				</div>
			)}

			{showHistory && (
				<div className="max-h-48 overflow-auto border-b" style={{ borderColor: "var(--border-strong)" }}>
					{(history.get(chatId) ?? []).map(rev => (
						<details key={rev.revision} className="gy-row block">
							<summary className="cursor-pointer text-[12.5px]">
								<span className="gy-label mr-2">rev {rev.revision}</span>
								{rev.title}
							</summary>
							<div className="mt-2">
								<Markdown text={rev.content} />
							</div>
						</details>
					))}
				</div>
			)}

			{/* body */}
			<div className="relative min-h-0 flex-1 overflow-auto">
				{!plan || plan.phase === "idle" ? (
					<div className="mx-auto flex max-w-lg flex-col gap-3 p-6">
						<div className="text-[15px] font-medium">Plan mode is off</div>
						<div className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							In plan mode the agent switches to your <b>plan</b>-role model, explores read-only and writes a plan. You review it here, send feedback until it
							is right, then approve: it runs with the role and context handling chosen above.
						</div>
						<textarea className="gy-input min-h-20 py-2" placeholder="What should it plan? (optional)" value={task} onChange={e => setTask(e.target.value)} />
						<div>
							<button
								type="button"
								className="gy-btn primary"
								disabled={!prefsLoaded || savingPrefs || pending !== null || status !== "ready"}
								onClick={() => void act("enter", { action: "enter", prompt: task })}
								data-jump="enter-plan"
							>
								<Play size={12} /> Enter plan mode
							</button>
						</div>
					</div>
				) : plan.phase === "planning" ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
						<Loader2 size={20} className="animate-spin" style={{ color: "var(--warn)" }} />
						<div className="text-[14px] font-medium">The agent is planning{plan.planModel ? ` on ${plan.planModel}` : ""}…</div>
						<div className="max-w-md text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							The working tree is read-only. The plan opens here for review when the agent submits it.
						</div>
						<button
							type="button"
							className="gy-btn"
							disabled={!prefsLoaded || savingPrefs || pending !== null}
							onClick={() => void act("cancel", { action: "cancel" })}
						>
							<X size={12} /> Leave plan mode
						</button>
					</div>
				) : plan.phase === "executing" ? (
					<div className="p-4">
						<div className="gy-card plan mb-3">
							<div className="gy-card-head">
								<div className="gy-card-label">Approved · executing</div>
							</div>
							<div className="gy-card-body text-[12.5px]">The agent is implementing the plan below with full tool access.</div>
						</div>
						<Markdown text={plan.planContent ?? ""} />
					</div>
				) : showIframe ? (
					<iframe
						title="Plannotator plan review"
						src={reviewUrl}
						className="h-full w-full border-0"
						style={{ background: "#fff", pointerEvents: savingPrefs || !prefsLoaded ? "none" : "auto" }}
						data-testid="plannotator-frame"
					/>
				) : (
					<div className="space-y-2 p-3">
						{sections.map((section, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: positional sections
							<div key={i} className="gy-card">
								<div className="gy-card-body">
									<Markdown text={section.body} />
								</div>
								<div
									className="border-t px-3 py-2"
									style={{ borderColor: "color-mix(in srgb, var(--border-strong) 25%, transparent)", background: "var(--panel)" }}
								>
									<textarea
										className="gy-input min-h-8 w-full py-1.5 text-[12.5px]"
										placeholder={`Comment on ${section.heading ? `“${section.heading}”` : "this part"}…`}
										value={comments[i] ?? ""}
										onChange={e => setComments(c => ({ ...c, [i]: e.target.value }))}
									/>
								</div>
							</div>
						))}
						<textarea
							className="gy-input min-h-16 w-full py-2"
							placeholder="Overall feedback, or notes for the implementer when approving…"
							value={overall}
							onChange={e => setOverall(e.target.value)}
							data-testid="plan-feedback"
						/>
					</div>
				)}
			</div>

			{/* decision bar */}
			{reviewing && (
				<div className="flex flex-wrap items-center gap-2 border-t px-2 py-2" style={{ borderColor: "var(--border-strong)", background: "var(--panel-2)" }}>
					{plan?.reviewUrl && (
						<>
							<button type="button" className="gy-btn ghost" onClick={() => setUseNative(n => !n)}>
								{useNative ? "Use Plannotator" : "Use Gyre review"}
							</button>
							<a className="gy-icon-btn" href={reviewUrl} target="_blank" rel="noreferrer" title="Open Plannotator in the browser">
								<ExternalLink size={14} />
							</a>
						</>
					)}
					<span className="flex-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
						{showIframe ? "Approve or deny in Plannotator, or decide here." : "Comment on sections, then request changes or approve."}
					</span>
					<button
						type="button"
						className="gy-btn"
						disabled={!prefsLoaded || savingPrefs || pending !== null}
						onClick={() => void act("refine", { action: "refine", feedback: feedback() })}
						data-jump="request-changes"
						data-testid="plan-refine"
					>
						{pending === "refine" ? <Loader2 size={12} className="animate-spin" /> : <MessageSquareWarning size={12} />} Request changes
					</button>
					<button
						type="button"
						className="gy-btn primary"
						disabled={!prefsLoaded || savingPrefs || pending !== null}
						onClick={() => void act("approve", { action: "approve", feedback: feedback() })}
						data-jump="approve-plan"
						data-testid="plan-approve"
					>
						{pending === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
					</button>
				</div>
			)}
		</div>
	);
}

function Empty({ text }: { text: string }) {
	return (
		<div className="flex h-full items-center justify-center p-6 text-center text-[12.5px]" style={{ color: "var(--muted)", background: "var(--panel)" }}>
			{text}
		</div>
	);
}
