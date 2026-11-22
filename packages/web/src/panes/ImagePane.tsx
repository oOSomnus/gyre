/** An image at actual size, with download (and zoom to fit). */
import type { PaneSpec } from "@gyre/protocol";
import { Download, Maximize, Minimize } from "lucide-react";
import { useState } from "react";
import { images } from "../store/actions";

export function ImagePane({ pane }: { pane: PaneSpec }) {
	const image = pane.ref ? images.get(pane.ref) : undefined;
	const [fit, setFit] = useState(false);
	if (!image) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-[12.5px]" style={{ color: "var(--muted)", background: "var(--panel)" }}>
				This image is no longer in memory. Open it again from the chat.
			</div>
		);
	}
	const name = image.name || "image";
	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			<div className="flex items-center gap-2 border-b px-2 py-1" style={{ borderColor: "var(--border-strong)", background: "var(--panel-2)" }}>
				<span className="truncate font-mono text-[12px]">{name}</span>
				<span className="flex-1" />
				<button type="button" className="gy-btn" onClick={() => setFit(f => !f)}>
					{fit ? <Maximize size={12} /> : <Minimize size={12} />} {fit ? "Actual size" : "Fit"}
				</button>
				<a className="gy-btn" href={image.src} download={name.includes(".") ? name : `${name}.png`}>
					<Download size={12} /> Download
				</a>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3" style={{ background: "repeating-conic-gradient(var(--panel-3) 0 25%, var(--panel-2) 0 50%) 0 0 / 16px 16px" }}>
				<img src={image.src} alt={name} draggable style={fit ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : undefined} />
			</div>
		</div>
	);
}
