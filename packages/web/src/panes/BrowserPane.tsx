/**
 * A browser pane for the app being built: an address bar over an iframe. Pages on the
 * gateway machine's localhost load directly when Gyre itself runs there; from a remote
 * browser they go through the gateway's preview proxy, which serves them on a separate
 * origin. Navigation inside the page is the page's own; the bar's back and forward move
 * through the addresses entered here.
 */
import type { PaneSpec } from "@gyre/protocol";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { needsProxy, normalizeUrl } from "../lib/browser";
import { api } from "../lib/gateway";
import { useApp } from "../store/app";

export function BrowserPane({ pane }: { pane: PaneSpec }) {
	const updatePane = useApp(s => s.updatePane);
	const url = pane.url ?? "";
	const [address, setAddress] = useState(url);
	const [src, setSrc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);
	const history = useRef<{ entries: string[]; index: number }>({ entries: url ? [url] : [], index: url ? 0 : -1 });
	const [, rerender] = useState(0);

	useEffect(() => setAddress(url), [url]);

	// Resolve what the iframe loads: the page itself, or a preview-proxy link for it.
	useEffect(() => {
		if (!url) {
			setSrc(null);
			return;
		}
		const h = history.current;
		if (h.entries[h.index] !== url) {
			h.entries = [...h.entries.slice(0, h.index + 1), url];
			h.index = h.entries.length - 1;
			rerender(n => n + 1);
		}
		setError(null);
		if (!needsProxy(url, location.hostname)) {
			setSrc(url);
			return;
		}
		let current = true;
		setLoading(true);
		api<{ url: string }>("/api/preview", { method: "POST", body: JSON.stringify({ url, paneId: pane.id }) })
			.then(result => current && setSrc(result.url))
			.catch(e => current && setError((e as Error).message))
			.finally(() => current && setLoading(false));
		return () => {
			current = false;
		};
	}, [url, pane.id, reloadKey]);

	const go = (next: string) => {
		const normalized = normalizeUrl(next);
		if (!normalized) {
			setError(`Not a web address: ${next}`);
			return;
		}
		if (normalized === url) setReloadKey(k => k + 1);
		else updatePane(pane.id, { url: normalized });
	};

	const step = (delta: number) => {
		const h = history.current;
		const index = h.index + delta;
		const target = h.entries[index];
		if (!target) return;
		h.index = index;
		updatePane(pane.id, { url: target });
	};

	const h = history.current;
	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }} data-browser-pane>
			<form
				className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1"
				style={{ borderColor: "var(--border)" }}
				onSubmit={e => {
					e.preventDefault();
					go(address);
				}}
			>
				<button type="button" className="gy-btn" aria-label="Back" disabled={h.index <= 0} onClick={() => step(-1)}>
					<ArrowLeft size={12} />
				</button>
				<button type="button" className="gy-btn" aria-label="Forward" disabled={h.index >= h.entries.length - 1} onClick={() => step(1)}>
					<ArrowRight size={12} />
				</button>
				<button type="button" className="gy-btn" aria-label="Reload" disabled={!url} onClick={() => setReloadKey(k => k + 1)}>
					{loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
				</button>
				<input
					className="gy-input h-7 min-w-0 flex-1 font-mono text-[12px]"
					value={address}
					onChange={e => setAddress(e.target.value)}
					placeholder="localhost:5173"
					aria-label="Address"
					spellCheck={false}
					data-testid="browser-address"
				/>
				<button type="button" className="gy-btn" aria-label="Open in a new tab" disabled={!src} onClick={() => src && window.open(src, "_blank", "noopener")}>
					<ExternalLink size={12} />
				</button>
			</form>
			{error && (
				<div className="gy-row text-[12px]" role="alert" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{src ? (
				<iframe
					key={`${src}#${reloadKey}`}
					src={src}
					title={url}
					className="min-h-0 w-full flex-1 border-0"
					style={{ background: "white" }}
					sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads"
					referrerPolicy="no-referrer"
				/>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: "var(--muted)" }}>
					<Globe size={24} />
					<div className="max-w-sm text-[12.5px]">
						Enter an address, e.g. the dev server the agent started (<span className="font-mono">localhost:5173</span>). From another device, pages on this machine's localhost go
						through Gyre's preview proxy.
					</div>
				</div>
			)}
		</div>
	);
}
