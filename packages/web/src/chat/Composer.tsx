import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { gateway } from "../lib/gateway";
import type { SlashCommand } from "../lib/omp";
import { useChats } from "../store/chats";
import { findLocalCommand, localCommands } from "./localCommands";

interface PendingImage {
	type: "image";
	data: string;
	mimeType: string;
}

function fileToImage(file: File): Promise<PendingImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve({ type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png" });
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	const q = query.toLowerCase();
	const scored = commands
		.map(cmd => {
			const names = [cmd.name, ...(cmd.aliases ?? [])].map(n => n.toLowerCase());
			const best = names.some(n => n === q)
				? 0
				: names.some(n => n.startsWith(q))
					? 1
					: names.some(n => n.includes(q))
						? 2
						: (cmd.description ?? "").toLowerCase().includes(q)
							? 3
							: 9;
			return { cmd, best };
		})
		.filter(x => x.best < 9)
		.sort((a, b) => a.best - b.best || a.cmd.name.localeCompare(b.cmd.name));
	return scored.slice(0, q ? 20 : 200).map(x => x.cmd);
}

export function Composer({ chatId, focused }: { chatId: string; focused: boolean }) {
	const chat = useChats(s => s.chats[chatId]);
	const [text, setText] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [selected, setSelected] = useState(0);
	const [sending, setSending] = useState(false);
	const inFlight = useRef(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const busy = chat?.busy ?? false;
	const ready = chat?.info.status === "ready";

	// Extensions can push text into the editor (`set_editor_text`).
	useEffect(() => {
		if (chat?.editorInject) {
			const { text: injected, append } = chat.editorInject;
			setText(prev => (append && prev.trim() ? `${prev.trimEnd()}\n\n${injected}` : injected));
			ref.current?.focus();
		}
	}, [chat?.editorInject]);

	useEffect(() => {
		if (focused) ref.current?.focus();
	}, [focused]);

	// Autosize
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(260, el.scrollHeight)}px`;
	}, [text]);

	const slashQuery = /^\/([^\s]*)$/.exec(text)?.[1];
	const suggestions = useMemo(
		() => (slashQuery !== undefined && chat ? matchCommands([...chat.commands, ...localCommands(chat.commands)], slashQuery) : []),
		[slashQuery, chat],
	);
	useEffect(() => setSelected(0), [slashQuery]);

	const send = async (mode: "prompt" | "steer" | "followUp" = busy ? "steer" : "prompt") => {
		const message = text.trim();
		if (inFlight.current || (!message && images.length === 0) || !ready) return;
		inFlight.current = true;
		const submittedText = text;
		const submittedImages = images;
		setText("");
		setImages([]);
		setSending(true);
		const payload = images.length > 0 ? { images } : {};
		try {
			const local = images.length === 0 ? findLocalCommand(chatId, message) : undefined;
			if (local) {
				await local();
				return;
			}
			if (mode === "prompt") await gateway.rpc(chatId, { type: "prompt", message, ...payload });
			else await gateway.rpc(chatId, { type: "prompt", message, streamingBehavior: mode, ...payload });
		} catch (error) {
			setText(current => (current ? `${submittedText}\n${current}` : submittedText));
			setImages(current => [...submittedImages, ...current]);
			useChats.getState().apply(chatId, { type: "notice", level: "error", message: String((error as Error).message) });
		} finally {
			inFlight.current = false;
			setSending(false);
		}
	};

	const accept = (cmd: SlashCommand) => {
		setText(`/${cmd.name}${cmd.input || cmd.subcommands?.length ? " " : ""}`);
		ref.current?.focus();
	};

	const abort = () => void gateway.rpc(chatId, { type: "abort" }).catch(() => undefined);

	return (
		<div className="relative">
			{suggestions.length > 0 && (
				<div className="gy-panel absolute bottom-full left-2 right-2 z-30 mb-1 max-h-80 overflow-auto p-1" style={{ boxShadow: "var(--shadow)" }}>
					{suggestions.map((cmd, i) => (
						<button
							type="button"
							key={cmd.name}
							onMouseDown={e => {
								e.preventDefault();
								accept(cmd);
							}}
							className="flex w-full items-baseline gap-3 px-2 py-1.5 text-left"
							style={{ background: i === selected ? "var(--tint-tool)" : "transparent" }}
						>
							<span className="font-mono text-[12.5px]" style={{ color: "var(--accent)" }}>
								/{cmd.name}
							</span>
							{cmd.input?.hint && (
								<span className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
									{cmd.input.hint}
								</span>
							)}
							<span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-dim)" }}>
								{cmd.description}
							</span>
							<span className="gy-label">{cmd.source}</span>
						</button>
					))}
				</div>
			)}

			{chat && (chat.queue.steering.length > 0 || chat.queue.followUp.length > 0) && (
				<div className="mx-2 mt-1.5 flex flex-wrap gap-1.5">
					{(["steering", "followUp"] as const).flatMap(queue =>
						chat.queue[queue].map(message => (
							<span key={`${queue}:${message}`} className="gy-chip">
								<span className="gy-label" style={{ letterSpacing: "0.05em" }}>
									{queue === "steering" ? "steer" : "next"}
								</span>
								<span className="max-w-64 truncate">{message}</span>
								<button
									type="button"
									className="opacity-60 hover:opacity-100"
									onClick={() => void gateway.rpc(chatId, { type: "remove_queued_message", message, queue })}
								>
									<X size={11} />
								</button>
							</span>
						)),
					)}
				</div>
			)}

			{images.length > 0 && (
				<div className="mx-2 mt-1.5 flex gap-2">
					{images.map((img, i) => (
						<div key={img.data.slice(0, 32) + i} className="relative">
							<img alt="pending" src={`data:${img.mimeType};base64,${img.data}`} className="h-14 rounded border" style={{ borderColor: "var(--border)" }} />
							<button
								type="button"
								className="absolute -right-1 -top-1 rounded-full p-0.5"
								style={{ background: "var(--panel-3)" }}
								onClick={() => setImages(imgs => imgs.filter((_, j) => j !== i))}
							>
								<X size={10} />
							</button>
						</div>
					))}
				</div>
			)}

			<div className="gy-composer" style={focused ? { boxShadow: "2px 2px 0 var(--border-strong)" } : undefined}>
				<textarea
					ref={ref}
					data-composer={chatId}
					rows={1}
					value={text}
					disabled={!ready}
					placeholder={
						!ready ? "Starting omp…" : busy ? "Steer the agent (Enter) · queue a follow-up (Alt+Enter) · Esc to stop" : "Type your message… (/ for commands)"
					}
					onChange={e => setText(e.target.value)}
					onPaste={async e => {
						const files = [...e.clipboardData.files].filter(f => f.type.startsWith("image/"));
						if (files.length === 0) return;
						e.preventDefault();
						const added = await Promise.all(files.map(fileToImage));
						setImages(imgs => [...imgs, ...added]);
					}}
					onKeyDown={e => {
						if (e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (suggestions.length > 0) {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setSelected(s => (s + 1) % suggestions.length);
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setSelected(s => (s - 1 + suggestions.length) % suggestions.length);
								return;
							}
							if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && suggestions[selected] && slashQuery !== suggestions[selected]?.name)) {
								e.preventDefault();
								const cmd = suggestions[selected];
								if (cmd) accept(cmd);
								return;
							}
						}
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void send(e.altKey && busy ? "followUp" : undefined);
						}
						if (e.key === "Escape" && busy) {
							e.preventDefault();
							abort();
						}
					}}
					className="max-h-64 min-h-[30px] flex-1 resize-none bg-transparent py-1 font-mono text-[13px] leading-relaxed outline-none"
				/>
				<label className="gy-icon-btn mb-0.5" title="Attach image">
					<ImagePlus size={15} />
					<input
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={async e => {
							const files = [...(e.target.files ?? [])];
							const added = await Promise.all(files.map(fileToImage));
							setImages(imgs => [...imgs, ...added]);
							e.target.value = "";
						}}
					/>
				</label>
				{busy && (
					<button type="button" className="gy-btn danger mb-0.5" onClick={abort} data-jump="stop">
						<Square size={11} fill="currentColor" /> Stop
					</button>
				)}
				<button
					type="button"
					className="gy-btn mb-0.5"
					disabled={!ready || sending || (!text.trim() && images.length === 0)}
					onClick={() => void send()}
					data-jump="send"
				>
					<ArrowUp size={13} /> {busy ? "Steer" : "Send"}
				</button>
			</div>
		</div>
	);
}
