/**
 * Background jobs for Gyre's Jobs pane. omp has no RPC command for its async jobs;
 * the extension API offers a read-only snapshot (`ctx.getAsyncJobSnapshot()`), so
 * this polls it while the session lives and publishes changes as the `gyre.jobs`
 * widget (sticky, so Gyre replays it to every UI that attaches). Gyre cancels a job
 * with omp's `/jobs kill <id>`.
 */
import { JOBS_WIDGET_KEY, type JobInfo, type JobsState } from "@gyre/protocol";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const STATUSES = new Set(["running", "completed", "failed", "cancelled"]);

/** The snapshot's jobs in widget form: running first, then recent; unknown shapes are skipped. */
export function jobsFromSnapshot(snapshot: unknown): JobInfo[] {
	const s = snapshot as { running?: unknown[]; recent?: unknown[] } | null | undefined;
	const jobs: JobInfo[] = [];
	const seen = new Set<string>();
	for (const raw of [...(s?.running ?? []), ...(s?.recent ?? [])]) {
		const job = raw as Partial<JobInfo> | null;
		if (!job || typeof job.id !== "string" || seen.has(job.id) || !STATUSES.has(String(job.status)) || typeof job.startTime !== "number") continue;
		seen.add(job.id);
		jobs.push({
			id: job.id,
			type: String(job.type ?? "bash"),
			status: job.status as JobInfo["status"],
			label: String(job.label ?? job.id),
			intent: typeof job.intent === "string" ? job.intent : undefined,
			command: typeof job.command === "string" ? job.command : undefined,
			caption: typeof job.caption === "string" ? job.caption : undefined,
			startTime: job.startTime,
			endTime: typeof job.endTime === "number" ? job.endTime : undefined,
		});
	}
	return jobs;
}

export function registerJobs(pi: ExtensionAPI, options: { intervalMs?: number } = {}): void {
	let ctx: ExtensionContext | undefined;
	let last = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	const isMain = (c: ExtensionContext | undefined) => !!c && (c as { agent?: { kind?: string } }).agent?.kind !== "sub";

	const publish = () => {
		if (!ctx?.hasUI) return;
		let snapshot: unknown;
		try {
			snapshot = ctx.getAsyncJobSnapshot?.();
		} catch {
			return;
		}
		const jobs = jobsFromSnapshot(snapshot);
		const text = jobs.length ? JSON.stringify({ jobs } satisfies JobsState) : "";
		if (text === last) return;
		last = text;
		try {
			ctx.ui.setWidget(JOBS_WIDGET_KEY, text ? [text] : undefined);
		} catch (error) {
			pi.logger.warn("gyre jobs: publish failed", { error: String(error) });
		}
	};

	const track = (_event: unknown, c: ExtensionContext) => {
		if (!isMain(c)) return;
		ctx = c;
		publish();
		if (!timer) {
			timer = setInterval(publish, options.intervalMs ?? 1000);
			(timer as { unref?: () => void }).unref?.();
		}
	};
	for (const event of ["session_start", "agent_start", "agent_end", "tool_execution_end"] as const) pi.on(event as "session_start", track);
	pi.on("session_switch", (event, c) => {
		last = "";
		track(event, c);
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
