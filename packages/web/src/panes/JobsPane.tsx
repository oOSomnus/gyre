/**
 * Background jobs the agent started (backgrounded bash commands, async tasks, eval):
 * every chat's `gyre.jobs` widget in one list. Kill runs omp's `/jobs kill <id>` in
 * the job's chat; a settled job shows the result omp delivered to the transcript.
 */
import type { PaneSpec } from "@gyre/protocol";
import { ChevronDown, ChevronRight, Cpu, MessagesSquare, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import { allJobs, type ChatJob, duration, jobResult } from "../lib/jobs";
import { paneTitle } from "../shell/panes";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";

const STATUS_LIGHT: Record<string, string> = { running: "gy-light-running", completed: "gy-light-idle", failed: "gy-light-error", cancelled: "gy-light-none" };

export function JobsPane(_props: { pane: PaneSpec }) {
	const chats = useChats(s => s.chats);
	const revealPane = useApp(s => s.revealPane);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [killing, setKilling] = useState<Set<string>>(new Set());
	const [, tick] = useState(0);
	const jobs = allJobs(chats);
	const anyRunning = jobs.some(j => j.status === "running");
	useEffect(() => {
		if (!anyRunning) return;
		const timer = setInterval(() => tick(n => n + 1), 1000);
		return () => clearInterval(timer);
	}, [anyRunning]);

	const kill = async (job: ChatJob) => {
		setError(null);
		setKilling(s => new Set(s).add(job.id));
		try {
			await gateway.rpc(job.chatId, { type: "prompt", message: `/jobs kill ${job.id}` });
		} catch (e) {
			setError(`Could not stop ${job.label}: ${(e as Error).message}`);
		} finally {
			setKilling(s => {
				const next = new Set(s);
				next.delete(job.id);
				return next;
			});
		}
	};

	return (
		<div className="h-full overflow-auto" style={{ background: "var(--panel)" }} data-jobs-pane>
			{error && (
				<div className="gy-row text-[12px]" role="alert" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{jobs.length === 0 && (
				<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: "var(--muted)" }}>
					<Cpu size={24} />
					<div className="text-[12.5px]">No background jobs.</div>
					<div className="max-w-sm text-[12px]">Long-running commands, async tasks and evals the agent starts in the background show here while they run and for a few minutes after.</div>
				</div>
			)}
			{jobs.map(job => {
				const key = `${job.chatId}:${job.id}`;
				const open = expanded === key;
				const result = open && job.status !== "running" ? jobResult(chats[job.chatId], job.id) : undefined;
				return (
					<div key={key} className="border-b" style={{ borderColor: "var(--border)" }} data-job={job.id}>
						<div className="gy-row">
							<button type="button" className="gy-btn" aria-label={open ? "Collapse" : "Expand"} onClick={() => setExpanded(open ? null : key)}>
								{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
							</button>
							<span className={`${STATUS_LIGHT[job.status] ?? "gy-light-none"} inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-black`} title={job.status} />
							<div className="min-w-0 flex-1">
								<div className="truncate text-[12.5px]">
									<span className="gy-chip mr-1.5">{job.type}</span>
									{job.intent ?? job.label}
								</div>
								<div className="truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
									{job.caption ?? job.command ?? job.label}
								</div>
							</div>
							<span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--muted)" }}>
								{job.status === "running" ? duration(job) : `${job.status} · ${duration(job)}`}
							</span>
							<button type="button" className="gy-btn" title="Show the chat" onClick={() => revealPane(job.chatId)}>
								<MessagesSquare size={11} /> <span className="max-w-32 truncate">{paneTitle({ id: job.chatId, kind: "chat" })}</span>
							</button>
							{job.status === "running" && (
								<button type="button" className="gy-btn danger" disabled={killing.has(job.id)} onClick={() => void kill(job)}>
									<Square size={10} /> Kill
								</button>
							)}
						</div>
						{open && (
							<div className="space-y-1 px-3 pb-2 text-[12px]">
								{job.command && <pre className="overflow-auto rounded p-2 font-mono text-[11.5px]" style={{ background: "var(--panel-2)" }}>{job.command}</pre>}
								<div style={{ color: "var(--muted)" }}>
									Job <span className="font-mono">{job.id}</span>, started {new Date(job.startTime).toLocaleTimeString()}
									{job.endTime ? `, ended ${new Date(job.endTime).toLocaleTimeString()}` : ""}
								</div>
								{job.status === "running" ? (
									<div style={{ color: "var(--muted)" }}>Output is delivered to the chat when the job ends.</div>
								) : result ? (
									<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded p-2 font-mono text-[11.5px]" style={{ background: "var(--panel-2)" }}>{result}</pre>
								) : (
									<div style={{ color: "var(--muted)" }}>No result in the transcript yet.</div>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
