/**
 * Gyre omp extension: plan mode over RPC.
 *
 * omp's built-in plan mode is wired only into its TUI (and ACP); over
 * `--mode rpc-ui` the `/plan` builtin has no handler and the review overlay
 * cannot be shown. This extension provides the same workflow through omp's
 * public extension API so Gyre can drive it:
 *
 *   /plan → plan-role model, read-only tree (writes only under local://),
 *   hidden plan instructions every turn → the agent writes local://<slug>-plan.md
 *   and calls submit_plan → review in a Gyre pane (Plannotator's page when
 *   the Plannotator extension is installed, otherwise Gyre's own card) →
 *   feedback loops back as a message; approval restores tools, switches to the
 *   chosen role's model, applies fresh/compact/keep context and sends the plan.
 *
 * State is published as JSON in the `gyre.plan` widget, which Gyre
 * reads; Gyre answers through `/gyre-plan <json>` and a prefs file
 * (`GYRE_PLAN_PREFS`) holding the role and context choices.
 */
import { readFileSync } from "node:fs";
import type { PlanPrefs, PlanState } from "@gyre/protocol";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { planApprovedPrompt, planDecisionReminder, planFeedbackPrompt, planModeContext } from "./prompts";

export const PLAN_WIDGET_KEY = "gyre.plan";
export const SUBMIT_TOOL = "submit_plan";
const PLANNOTATOR_REQUEST = "plannotator:request";
const PLANNOTATOR_RESULT = "plannotator:review-result";
const PLANNOTATOR_OPENED = "plannotator:session-opened";
const PLANNOTATOR_CLOSED = "plannotator:session-closed";
const PLANNOTATOR_START_TIMEOUT_MS = 5_000;
const MAX_REMINDERS = 3;

/** Tools that change files; in plan mode they may only target local://. */
const MUTATING_TOOLS = new Set(["write", "edit", "ast_edit", "apply_patch", "notebook_edit", "multi_edit"]);
/** Shell commands that change state. Mirrors omp's example plan-mode extension. */
const DESTRUCTIVE_BASH = [
	/\brm\b/,
	/\brmdir\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\bmkdir\b/,
	/\btouch\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\bln\b/,
	/\btee\b/,
	/\btruncate\b/,
	/\bdd\b/,
	/(^|[^<>&0-9])>(?!&)/,
	/>>/,
	/\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade|link|publish|ci)\b/,
	/\bpip3?\s+(install|uninstall)\b/,
	/\b(apt|apt-get|brew|dnf|yum|pacman)\s+(install|remove|purge|upgrade|update)\b/,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean|restore|am|apply)\b/,
	/\bsed\s+(-[a-zA-Z]*i|--in-place)/,
	/\bsudo\b/,
	/\b(kill|pkill|killall|reboot|shutdown)\b/,
];

type Phase = PlanState["phase"];

interface Saved {
	model: unknown;
	thinking: unknown;
	tools: string[];
}

interface Runtime {
	phase: Phase;
	title?: string;
	planFilePath?: string;
	planContent?: string;
	reviewUrl?: string;
	reviewId?: string;
	requestId?: string;
	revision: number;
	planModel?: string;
	error?: string;
	saved?: Saved;
	/** The agent called ask or submit_plan during the current run. */
	decided: boolean;
	reminders: number;
	/** A decision is being applied; ignore duplicates. */
	busy: boolean;
	/** The approved plan's run has started (executing → idle at its end). */
	executionStarted: boolean;
	/** Latest command context: needed for newSession() on "fresh" approval. */
	commandCtx?: ExtensionCommandContext;
	ctx?: ExtensionContext;
}

function initial(): Runtime {
	return { phase: "idle", revision: 0, decided: false, reminders: 0, busy: false, executionStarted: false };
}

export function isLocalUrl(path: unknown): boolean {
	return typeof path === "string" && path.trim().startsWith("local://");
}

/** Every path-like argument of a mutating tool call. */
export function targetPaths(input: Record<string, unknown>, toolName?: string): string[] {
	const out: string[] = [];
	const visit = (value: unknown, key?: string) => {
		if (typeof value === "string") {
			if (key && /^(path|file|filePath|file_path|target|targetPath|dest|destination|from|to)$/.test(key)) out.push(value);
			if (toolName !== undefined && !(["edit", "apply_patch", "multi_edit"].includes(toolName) && ["input", "patch", "diff"].includes(key ?? ""))) return;
			for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (match[1]) out.push(match[1].trim());
			for (const match of value.matchAll(/^\*\*\* Move to: (.+)$/gm)) if (match[1]) out.push(match[1].trim());
			// omp hashline edits address files as `[path#hash]` section headers.
			for (const match of value.matchAll(/^\[([^\]\s#]+)(?:#[^\]]*)?\]\s*$/gm)) if (match[1]) out.push(match[1].trim());
		} else if (Array.isArray(value)) {
			for (const item of value) visit(item, key);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value)) visit(v, k);
		}
	};
	visit(input);
	return out;
}

export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_BASH.some(pattern => pattern.test(command));
}

function readPrefs(): PlanPrefs {
	const path = process.env.GYRE_PLAN_PREFS;
	const fallback: PlanPrefs = { role: "default", context: "compact" };
	if (!path) return fallback;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PlanPrefs>;
		return {
			role: typeof parsed.role === "string" && parsed.role ? parsed.role : fallback.role,
			context: parsed.context === "fresh" || parsed.context === "keep" ? parsed.context : "compact",
		};
	} catch {
		return fallback;
	}
}

function modelLabel(model: unknown): string | undefined {
	const m = model as { provider?: string; id?: string } | undefined;
	return m?.provider && m.id ? `${m.provider}/${m.id}` : undefined;
}

async function readPlan(ctx: ExtensionContext, planFilePath: string): Promise<string | null> {
	const localProtocolOptions = ctx.localProtocolOptions;
	if (localProtocolOptions) {
		try {
			const { readPlanFile } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-files");
			return await readPlanFile(planFilePath, { cwd: ctx.cwd, localProtocolOptions });
		} catch (error) {
			if (!(error instanceof Error) || !/Cannot find module|not found/i.test(error.message)) throw error;
		}
	}
	// Fallback: local://name lives next to the session file.
	const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.();
	if (!isLocalUrl(planFilePath) || !sessionFile) return null;
	const name = planFilePath.trim().slice("local://".length);
	if (!name || name.includes("..")) return null;
	const file = Bun.file(`${sessionFile.replace(/\.jsonl$/, "")}/local/${name}`);
	return (await file.exists()) ? file.text() : null;
}

export default function gyrePlanMode(pi: ExtensionAPI): void {
	let rt = initial();
	const z = pi.zod;

	const isMain = (ctx: ExtensionContext | undefined) => !ctx || (ctx as { agent?: { kind?: string } }).agent?.kind !== "sub";

	const publish = (ctx: ExtensionContext | undefined = rt.ctx) => {
		if (!ctx?.hasUI) return;
		const state: PlanState = {
			phase: rt.phase,
			title: rt.title,
			planFilePath: rt.planFilePath,
			planContent: rt.planContent,
			reviewUrl: rt.reviewUrl,
			reviewId: rt.reviewId,
			revision: rt.revision,
			planModel: rt.planModel,
			error: rt.error,
			updatedAt: Date.now(),
		};
		try {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, rt.phase === "idle" && !rt.error ? undefined : [JSON.stringify(state)]);
		} catch (error) {
			pi.logger.warn("gyre plan: publish failed", { error: String(error) });
		}
	};

	const notify = (ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "warning") => {
		try {
			ctx?.ui.notify(message, type);
		} catch {}
	};

	async function enter(ctx: ExtensionContext, prompt?: string): Promise<void> {
		rt = { ...initial(), commandCtx: rt.commandCtx, ctx };
		rt.saved = { model: ctx.model, thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() };
		const planModel = ctx.models.resolve("@plan");
		if (planModel && modelLabel(planModel) !== modelLabel(ctx.model)) {
			const ok = await pi.setModel(planModel).catch(() => false);
			if (!ok) notify(ctx, `Plan mode: could not switch to the plan-role model ${modelLabel(planModel)}; staying on the current model.`);
		}
		rt.planModel = modelLabel(ctx.models.current() ?? planModel ?? ctx.model);
		await pi.setActiveTools([...new Set([...rt.saved.tools, SUBMIT_TOOL])]);
		rt.phase = "planning";
		publish(ctx);
		if (prompt?.trim()) await pi.sendUserMessage(prompt.trim()).catch(() => undefined);
	}

	/** Leave plan mode. `restoreModel` puts the pre-plan model back (cancel); approval picks a role instead. */
	async function leave(ctx: ExtensionContext, restoreModel: boolean): Promise<void> {
		const saved = rt.saved;
		const tools = (saved?.tools ?? pi.getActiveTools()).filter(name => name !== SUBMIT_TOOL);
		await pi.setActiveTools(tools);
		if (restoreModel && saved?.model && modelLabel(saved.model) !== modelLabel(ctx.models.current())) {
			await pi.setModel(saved.model as Parameters<typeof pi.setModel>[0]).catch(() => false);
		}
		if (saved?.thinking) {
			try {
				pi.setThinkingLevel(saved.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
			} catch {}
		}
	}

	async function cancel(ctx: ExtensionContext): Promise<void> {
		await leave(ctx, true);
		rt = { ...initial(), commandCtx: rt.commandCtx, ctx };
		publish(ctx);
	}

	async function requestPlannotatorReview(ctx: ExtensionContext): Promise<void> {
		const requestId = crypto.randomUUID();
		rt.requestId = requestId;
		const content = rt.planContent ?? "";
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, PLANNOTATOR_START_TIMEOUT_MS);
			try {
				pi.events.emit(PLANNOTATOR_REQUEST, {
					requestId,
					action: "plan-review",
					payload: { planContent: content, planFilePath: rt.planFilePath },
					respond: (response: unknown) => {
						clearTimeout(timer);
						const shaped = response as { status?: string; result?: { reviewId?: unknown }; error?: unknown };
						if (rt.requestId === requestId && shaped?.status === "handled" && typeof shaped.result?.reviewId === "string") {
							rt.reviewId = shaped.result.reviewId;
							publish(ctx);
						}
						resolve();
					},
				});
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});
	}

	async function decide(ctx: ExtensionContext, decision: { approved: boolean; feedback?: string; reviewId?: string }): Promise<void> {
		if (rt.phase !== "reviewing" || rt.busy) return;
		if (decision.reviewId !== undefined && decision.reviewId !== rt.reviewId) return;
		rt.busy = true;
		try {
			if (!decision.approved) {
				rt.phase = "planning";
				rt.reviewUrl = undefined;
				rt.reviewId = undefined;
				rt.decided = false;
				rt.reminders = 0;
				publish(ctx);
				await pi.sendUserMessage(planFeedbackPrompt({ revision: rt.revision, feedback: decision.feedback ?? "" }));
				return;
			}
			await approve(ctx, decision.feedback);
		} catch (error) {
			rt.phase = "reviewing";
			rt.error = error instanceof Error ? error.message : String(error);
			notify(ctx, `Plan approval failed: ${rt.error}`, "error");
			publish(ctx);
		} finally {
			rt.busy = false;
		}
	}

	async function approve(ctx: ExtensionContext, notes?: string): Promise<void> {
		const planFilePath = rt.planFilePath;
		if (!planFilePath) throw new Error("no plan was submitted");
		const content = await readPlan(ctx, planFilePath);
		if (content !== rt.planContent) throw new Error("The plan changed after submission. Submit it again for review before approval.");
		if (!content?.trim()) throw new Error(`the plan file ${planFilePath} is empty or missing`);
		const prefs = readPrefs();

		await leave(ctx, false);
		const target = ctx.models.resolve(`@${prefs.role}`) ?? (rt.saved?.model as ReturnType<typeof ctx.models.resolve>);
		if (target && modelLabel(target) !== modelLabel(ctx.models.current())) {
			const ok = await pi.setModel(target).catch(() => false);
			if (!ok) notify(ctx, `Could not switch to the ${prefs.role} role's model; continuing on the current model.`);
		}

		rt.phase = "executing";
		let context = prefs.context;
		if (context === "fresh") {
			const commandCtx = rt.commandCtx;
			if (commandCtx) {
				const result = await commandCtx
					.newSession({
						setup: async manager => {
							const artifacts = manager.getArtifactsDir();
							if (!artifacts) throw new Error("The new session has no artifact directory for the approved plan.");
							const name = planFilePath.slice("local://".length);
							if (!name || name.includes("..") || name.includes("\\")) throw new Error("Invalid local plan path");
							await Bun.write(`${artifacts}/local/${name}`, content);
						},
					})
					.catch(() => ({ cancelled: true }));
				if (result.cancelled) context = "compact";
			} else {
				context = "compact";
			}
		}
		if (context === "compact") {
			await ctx.compact("The user approved the plan below; keep what an implementer needs.").catch(error => {
				notify(ctx, `Compaction skipped: ${error instanceof Error ? error.message : String(error)}`, "info");
			});
		}

		rt.phase = "executing";
		rt.executionStarted = false;
		rt.planContent = content;
		rt.reviewUrl = undefined;
		publish(ctx);
		await pi.sendUserMessage(planApprovedPrompt({ planFilePath, planContent: content, contextPreserved: context !== "fresh", notes }));
	}

	// ---------------------------------------------------------------- commands

	pi.registerCommand("plan", {
		description: "Toggle plan mode (Gyre): plan read-only, review, then execute",
		handler: async (args, ctx) => {
			rt.commandCtx = ctx;
			rt.ctx = ctx;
			if (rt.phase === "idle" || rt.phase === "executing") {
				await enter(ctx, args);
				return;
			}
			if (args.trim()) {
				// Already planning: treat the text as a new instruction.
				await pi.sendUserMessage(args.trim()).catch(() => undefined);
				return;
			}
			await cancel(ctx);
			notify(ctx, "Plan mode off (plan not approved).", "info");
		},
	});

	pi.registerCommand("gyre-plan", {
		description: "Gyre plan-mode control channel",
		handler: async (args, ctx) => {
			rt.commandCtx = ctx;
			rt.ctx = ctx;
			let body: { action?: string; feedback?: string; prompt?: string };
			try {
				body = JSON.parse(args || "{}");
			} catch {
				notify(ctx, "gyre-plan: expected JSON");
				return;
			}
			switch (body.action) {
				case "enter":
					if (rt.phase === "idle" || rt.phase === "executing") await enter(ctx, body.prompt);
					return;
				case "cancel":
					if (rt.phase !== "idle") await cancel(ctx);
					return;
				case "approve":
					await decide(ctx, { approved: true, feedback: body.feedback });
					return;
				case "refine":
					await decide(ctx, { approved: false, feedback: body.feedback ?? "" });
					return;
				case "status":
					publish(ctx);
					return;
				default:
					notify(ctx, `gyre-plan: unknown action ${String(body.action)}`);
			}
		},
	});

	// ---------------------------------------------------------------- tool

	pi.registerTool({
		name: SUBMIT_TOOL,
		label: "Submit plan",
		description:
			"Plan mode only: submit the finished plan file (local://<slug>-plan.md) for the user's review. Returns immediately; end your turn afterwards. The user's decision arrives as the next message.",
		parameters: z.object({
			plan: z.string().describe("The plan file, e.g. local://auth-token-refresh-plan.md"),
			title: z.string().describe("Short human-readable title of the plan"),
		}),
		defaultInactive: true,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { plan?: string; title?: string };
			rt.ctx = ctx;
			rt.decided = true;
			if (rt.phase !== "planning" && rt.phase !== "reviewing") {
				return { content: [{ type: "text", text: "Plan mode is not active; nothing to submit." }], details: { ok: false } };
			}
			const plan = String(params.plan ?? "").trim();
			if (!isLocalUrl(plan)) {
				return { content: [{ type: "text", text: "The plan must be a local:// file, e.g. local://my-task-plan.md." }], details: { ok: false } };
			}
			const content = await readPlan(ctx, plan);
			if (!content?.trim()) {
				return { content: [{ type: "text", text: `${plan} is missing or empty. Write the plan there first.` }], details: { ok: false } };
			}
			rt.planFilePath = plan;
			rt.title = String(params.title ?? "").trim() || plan;
			rt.planContent = content;
			rt.revision += 1;
			rt.phase = "reviewing";
			rt.reviewUrl = undefined;
			rt.reviewId = undefined;
			rt.error = undefined;
			publish(ctx);
			void requestPlannotatorReview(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Plan "${rt.title}" (revision ${rt.revision}) submitted for review in Gyre. End your turn now; the user's decision arrives as the next message.`,
					},
				],
				details: { ok: true, planFilePath: plan, title: rt.title, revision: rt.revision },
			};
		},
	});

	// ---------------------------------------------------------------- hooks

	pi.on("context", (event, ctx) => {
		if (!isMain(ctx) || (rt.phase !== "planning" && rt.phase !== "reviewing")) return;
		const content = planModeContext({ planFilePath: rt.planFilePath, planExists: Boolean(rt.planFilePath), revision: rt.revision });
		const message = {
			role: "custom",
			customType: "gyre-plan-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		} as unknown as (typeof event.messages)[number];
		return { messages: [...event.messages, message] };
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isMain(ctx) || (rt.phase !== "planning" && rt.phase !== "reviewing")) return;
		const name = event.toolName;
		if (name === "ask" || name === SUBMIT_TOOL) {
			rt.decided = true;
			return;
		}
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (name === "bash") {
			const command = String(input.command ?? "");
			if (isDestructiveCommand(command)) {
				return {
					block: true,
					reason: "Plan mode: the working tree is read-only; this command could change state. Use read-only commands, or write the plan under local://.",
				};
			}
			return;
		}
		if (MUTATING_TOOLS.has(name)) {
			const paths = targetPaths(input, name);
			if (paths.length === 0 || paths.some(path => !isLocalUrl(path))) {
				return { block: true, reason: "Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead." };
			}
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		rt.ctx = ctx;
		rt.decided = false;
		if (rt.phase === "executing") rt.executionStarted = true;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!isMain(ctx)) return;
		if (rt.phase === "executing" && rt.executionStarted) {
			rt = { ...initial(), commandCtx: rt.commandCtx, ctx };
			publish(ctx);
			return;
		}
		if (rt.phase !== "planning") return;
		if (rt.decided) {
			rt.reminders = 0;
			return;
		}
		if (rt.reminders >= MAX_REMINDERS) return;
		rt.reminders += 1;
		pi.sendMessage({ customType: "gyre-plan-reminder", content: planDecisionReminder(), display: false }, { triggerTurn: true, deliverAs: "followUp" });
	});

	const resetOnTransition = (_event: unknown, ctx: ExtensionContext) => {
		if (!isMain(ctx)) return;
		// Approval with a fresh context switches sessions while executing; keep that state.
		if (rt.phase === "executing") {
			rt.ctx = ctx;
			publish(ctx);
			return;
		}
		rt = { ...initial(), commandCtx: rt.commandCtx, ctx };
		publish(ctx);
	};
	pi.on("session_switch", resetOnTransition);
	pi.on("session_branch", resetOnTransition);
	pi.on("session_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		rt.ctx = ctx;
		publish(ctx);
	});

	// ---------------------------------------------------------------- Plannotator (public bus API)

	const offOpened = pi.events.on(PLANNOTATOR_OPENED, (data: unknown) => {
		const event = data as { url?: unknown; reviewId?: unknown; requestId?: unknown };
		if (rt.phase !== "reviewing" || typeof event.url !== "string") return;
		if (event.requestId !== rt.requestId && (event.reviewId === undefined || event.reviewId !== rt.reviewId)) return;
		if (typeof event.reviewId === "string") rt.reviewId = event.reviewId;
		rt.reviewUrl = event.url;
		publish();
	});
	const offResult = pi.events.on(PLANNOTATOR_RESULT, (data: unknown) => {
		const result = data as { reviewId?: unknown; approved?: unknown; feedback?: unknown };
		if (typeof result.reviewId !== "string" || result.reviewId !== rt.reviewId || typeof result.approved !== "boolean") return;
		const ctx = rt.ctx;
		if (!ctx) return;
		void decide(ctx, {
			approved: result.approved,
			feedback: typeof result.feedback === "string" ? result.feedback : undefined,
			reviewId: result.reviewId,
		});
	});
	const offClosed = pi.events.on(PLANNOTATOR_CLOSED, (data: unknown) => {
		const event = data as { reviewId?: unknown; outcome?: unknown };
		if (event.reviewId !== rt.reviewId || event.outcome !== "closed") return;
		// Review page closed without a decision: fall back to Gyre's own review card.
		rt.reviewUrl = undefined;
		publish();
	});

	pi.on("session_shutdown", () => {
		offOpened();
		offResult();
		offClosed();
	});
}
