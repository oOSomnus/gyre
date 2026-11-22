/**
 * Setup guidance shown while omp cannot run chats: omp missing, or no model
 * provider configured (omp refuses to start without one). Replaces dead chat
 * cards, the empty workspace and the Providers settings until "Re-check" passes.
 */
import { AlertTriangle, Check, Copy, Loader2, RotateCw, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { ensureChat } from "../chat/ChatPane";
import { needsSetup, useOmpStatus } from "../lib/ompStatus";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";

/** Reads the key without echoing it or putting it in shell history or argv. */
const API_KEY_IMPORT = `read -rsp "API key: " KEY && printf '{"version":1,"credentials":[{"provider":"anthropic","credential":{"type":"api_key","key":"%s"}}]}' "$KEY" | omp auth import - ; unset KEY`;

const MODELS_YML = `# ~/.omp/agent/models.yml: any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, …)
providers:
  local:
    baseUrl: http://127.0.0.1:11434/v1
    apiKey: none
    api: openai-completions
    models:
      - id: qwen2.5-coder:14b`;

export function CopyCommand({ command, multiline = false }: { command: string; multiline?: boolean }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-start gap-1.5">
			<pre className={`gy-pre min-w-0 flex-1 ${multiline ? "" : "overflow-x-auto whitespace-pre"}`}>{command}</pre>
			<button
				type="button"
				className="gy-icon-btn shrink-0"
				title="Copy"
				onClick={() =>
					void navigator.clipboard?.writeText(command).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
				{copied ? <Check size={13} /> : <Copy size={13} />}
			</button>
		</div>
	);
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1.5">
			<div className="text-[12.5px] font-semibold">
				{n}. {title}
			</div>
			<div className="space-y-1.5 text-[12.5px]" style={{ color: "var(--text-dim)" }}>
				{children}
			</div>
		</div>
	);
}

/** Restart chat panes that died while omp was not set up. */
function restartDeadChats() {
	const chats = useChats.getState().chats;
	for (const ws of useApp.getState().workspaces) {
		for (const pane of Object.values(ws.panes)) {
			if (pane.kind === "chat" && (!chats[pane.id] || chats[pane.id]?.info.status === "exited")) ensureChat(pane, true);
		}
	}
}

export function RecheckButton() {
	const { rechecking, recheck } = useOmpStatus();
	const [result, setResult] = useState<string | null>(null);
	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				className="gy-btn primary"
				disabled={rechecking}
				onClick={() =>
					void recheck()
						.then(status => {
							if (needsSetup(status)) setResult(status === "missing" ? "omp still not found." : "Still no provider found.");
							else {
								setResult(null);
								restartDeadChats();
							}
						})
						.catch(e => setResult((e as Error).message))
				}
				data-testid="omp-recheck"
			>
				{rechecking ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Re-check
			</button>
			{result && <span className="text-[12px]" style={{ color: "var(--warn)" }}>{result}</span>}
		</div>
	);
}

/** Full guidance card. Renders nothing once omp is ready. */
export function OmpSetupGuide({ projectId }: { projectId?: string }) {
	const status = useOmpStatus(s => s.status);
	const projects = useApp(s => s.projects);
	const addPane = useApp(s => s.addPane);
	if (!needsSetup(status)) return null;
	const terminalProject = projectId ?? projects[0]?.id;
	const openTerminal = terminalProject ? (
		<button type="button" className="gy-btn" onClick={() => addPane({ kind: "terminal", projectId: terminalProject })}>
			<SquareTerminal size={12} /> Open a terminal
		</button>
	) : null;

	return (
		<div className="gy-card notice mx-auto w-full max-w-[680px]" data-testid="omp-setup">
			<div className="gy-card-body space-y-4">
				<div className="flex items-center gap-2 text-[14px] font-semibold">
					<AlertTriangle size={16} style={{ color: "var(--warn)" }} />
					{status === "missing" ? "omp is not installed" : "Add a model provider to start chatting"}
				</div>
				{status === "missing" ? (
					<>
						<p className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							Gyre runs the omp coding agent. Install it with Bun, then press Re-check. If Gyre still cannot find it, restart Gyre or set{" "}
							<span className="font-mono">OMP_PATH</span> to the omp binary.
						</p>
						<Step n={1} title="Install Bun (skip if you have it)">
							<CopyCommand command="curl -fsSL https://bun.sh/install | bash" />
						</Step>
						<Step n={2} title="Install omp">
							<CopyCommand command="bun install -g @oh-my-pi/pi-coding-agent" />
							<div>
								More options:{" "}
								<a href="https://omp.sh" target="_blank" rel="noreferrer" style={{ color: "var(--highlight)" }}>
									omp.sh
								</a>
							</div>
						</Step>
						<Step n={3} title="Optional: Plannotator for plan review">
							<CopyCommand command="omp plugin install @plannotator/pi-extension" />
						</Step>
					</>
				) : (
					<>
						<p className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							omp has no model provider, so it cannot start. Set one up with any of the options below, run in a terminal on the machine running Gyre, then press
							Re-check. Credentials are stored by omp and shared with the omp CLI.
						</p>
						<Step n={1} title="Sign in with a subscription (Claude, ChatGPT/Codex, Copilot, …)">
							<CopyCommand command="omp login" />
							<div>Pick a provider and follow the sign-in link.</div>
							{openTerminal}
						</Step>
						<Step n={2} title="Or store an API key (here: Anthropic; change the provider id as needed)">
							<CopyCommand command={API_KEY_IMPORT} multiline />
							<div>
								Environment variables work too (<span className="font-mono">ANTHROPIC_API_KEY</span>, <span className="font-mono">OPENAI_API_KEY</span>,{" "}
								<span className="font-mono">GEMINI_API_KEY</span>, <span className="font-mono">OPENROUTER_API_KEY</span>, …), but only if they are set where Gyre
								starts; restart Gyre after setting them.
							</div>
						</Step>
						<Step n={3} title="Or add a local / custom endpoint">
							<CopyCommand command={MODELS_YML} multiline />
						</Step>
					</>
				)}
				<RecheckButton />
			</div>
		</div>
	);
}
