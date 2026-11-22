import { Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { JumpMarks } from "./marks/JumpMarks";
import { useConnectionState } from "./lib/gateway";
import { CommandPalette } from "./palette/CommandPalette";
import { ModelPicker } from "./palette/ModelPicker";
import { AddProjectDialog } from "./projects/AddProjectDialog";
import { MobileShell } from "./shell/MobileShell";
import { PaneGrid } from "./shell/PaneGrid";
import { TopBar } from "./shell/TopBar";
import { installShortcuts } from "./shell/shortcuts";
import { useApp } from "./store/app";
import { Gyroscope } from "./shell/Gyroscope";

function useIsPhone(): boolean {
	const query = "(max-width: 767px)";
	const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const media = window.matchMedia(query);
		const onChange = () => setPhone(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);
	return phone;
}

export function App() {
	const conn = useConnectionState();
	const loaded = useApp(s => s.loaded);
	const saveError = useApp(s => s.saveError);
	const kbdMode = useApp(s => s.kbdMode);
	const [loadError, setLoadError] = useState<string | null>(null);
	const phone = useIsPhone();

	useEffect(() => installShortcuts(), []);
	useEffect(() => {
		if (conn === "open" && !loaded)
			void useApp
				.getState()
				.load()
				.catch(e => setLoadError((e as Error).message));
	}, [conn, loaded]);

	if (conn === "unauthorized") return <Login />;

	if (!loaded) {
		return (
			<Centered>
				{loadError ? (
					<div style={{ color: "var(--err)" }}>
						{loadError}
						<button
							className="gy-btn"
							type="button"
							onClick={() => {
								setLoadError(null);
								void useApp
									.getState()
									.load()
									.catch(e => setLoadError((e as Error).message));
							}}
						>
							Retry
						</button>
					</div>
				) : (
					<>
						<Gyroscope state="working" size={56} />
						<div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--chrome-muted)" }}>
							<Loader2 size={13} className="animate-spin" />
							{conn === "open" ? "Loading workspace…" : "Connecting to the Gyre gateway…"}
						</div>
					</>
				)}
			</Centered>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<TopBar />
			{saveError && (
				<div role="alert" className="gy-row" style={{ color: "var(--err)" }}>
					{saveError}
					<button type="button" className="gy-btn" onClick={() => useApp.setState({ saveError: null })}>
						Dismiss
					</button>
				</div>
			)}
			<main className="flex min-h-0 flex-1 flex-col">{phone ? <MobileShell /> : <PaneGrid />}</main>
			<CommandPalette />
			<ModelPicker />
			<AddProjectDialog />
			<JumpMarks />
			{kbdMode && (
				<div
					className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 px-3 py-1.5 font-mono text-[11px]"
					style={{ background: "var(--mark-bg)", color: "var(--mark-ink)", border: "1px solid #000", boxShadow: "3px 3px 0 #000" }}
					data-testid="kbd-mode"
				>
					KEYBOARD MODE · WASD focus · ⇧WASD swap · Ctrl+WASD resize · Q/E workspace · 1-9 jump · H hide · F float · Z max · X close · Esc exit
				</div>
			)}
			{conn !== "open" && (
				<div
					className="fixed top-16 left-1/2 z-50 -translate-x-1/2 px-3 py-1.5 text-[12px]"
					style={{ background: "var(--panel-2)", border: "1px solid var(--border-strong)", color: "var(--warn)" }}
				>
					Reconnecting to gateway…
				</div>
			)}
		</div>
	);
}

/** Remote browsers sign in once with the gateway token (an HttpOnly cookie remembers them). */
function Login() {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const remote = Boolean(window.__GYRE__?.remote);
	const submit = async () => {
		setError(null);
		try {
			const response = await fetch("/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: value.trim() }),
			});
			if (response.ok) location.replace(location.pathname);
			else setError("That token is not valid.");
		} catch {
			setError("Could not reach the gateway. Check your connection and try again.");
		}
	};
	return (
		<Centered>
			{remote ? <Gyroscope state="idle" size={56} /> : <ShieldAlert size={22} style={{ color: "var(--err)" }} />}
			<div className="text-[15px] font-medium" style={{ color: "var(--chrome-text)" }}>
				{remote ? "Sign in to Gyre" : "Not authorized"}
			</div>
			<div className="max-w-sm text-center text-[12.5px]" style={{ color: "var(--chrome-muted)" }}>
				Open the link the gateway printed (it ends in <span className="font-mono">#token=…</span>), or paste the token.
			</div>
			<form
				className="flex gap-2"
				onSubmit={e => {
					e.preventDefault();
					void submit();
				}}
			>
				<input
					className="gy-input w-72 font-mono"
					type="password"
					placeholder="gateway token"
					value={value}
					onChange={e => setValue(e.target.value)}
					autoFocus
				/>
				<button type="submit" className="gy-btn primary" disabled={!value.trim()}>
					Sign in
				</button>
			</form>
			{error && (
				<div className="text-[12px]" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
		</Centered>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-full flex-col items-center justify-center gap-4">{children}</div>;
}
