/**
 * Marks (jump marks): keyboard-first navigation. Every visible actionable
 * element gets a short letter mark; typing it clicks (or focuses) that element.
 * Links, tables, images, code blocks and file paths open a second-step menu of
 * actions (open, copy URL/text, copy as Markdown/TSV, download…).
 */
import { useEffect, useMemo, useState } from "react";
import { tableText } from "../chat/Markdown";
import { useApp } from "../store/app";

interface MarkAction {
	label: string;
	run: () => void;
}

function copy(text: string) {
	void navigator.clipboard.writeText(text);
}

function download(href: string, name: string) {
	const a = document.createElement("a");
	a.href = href;
	a.download = name;
	a.click();
}

/** Second-step actions for rich elements; null means "just click it". */
function actionsFor(el: HTMLElement): { kind: string; actions: MarkAction[] } | null {
	const kindEl = el.closest<HTMLElement>("[data-jump-kind]") ?? (el.matches("[data-jump-kind]") ? el : null);
	const kind = kindEl?.dataset.jumpKind ?? (el instanceof HTMLAnchorElement && el.href ? "link" : undefined);
	if (!kind) return null;
	const text = kindEl?.dataset.jumpText;
	switch (kind) {
		case "link": {
			const a = (el instanceof HTMLAnchorElement ? el : el.querySelector("a")) as HTMLAnchorElement | null;
			if (!a) return null;
			return {
				kind,
				actions: [
					{ label: "Open link", run: () => a.click() },
					{ label: "Copy URL", run: () => copy(a.href) },
					{ label: "Copy text", run: () => copy(a.textContent ?? "") },
				],
			};
		}
		case "table": {
			const table = kindEl?.querySelector("table");
			if (!table) return null;
			return {
				kind,
				actions: [
					{ label: "Copy as Markdown", run: () => copy(tableText(table, "md")) },
					{ label: "Copy as TSV", run: () => copy(tableText(table, "tsv")) },
				],
			};
		}
		case "image": {
			const img = (kindEl?.querySelector("img") ?? null) as HTMLImageElement | null;
			const src = img?.src ?? text ?? "";
			return {
				kind,
				actions: [
					{ label: "Open in a pane", run: () => (kindEl ?? el).click() },
					{ label: "Download", run: () => download(src, "image.png") },
					{ label: "Copy image address", run: () => copy(src) },
				],
			};
		}
		case "code":
			return {
				kind,
				actions: [
					{ label: "Copy code", run: () => copy(text ?? kindEl?.querySelector("pre")?.textContent ?? "") },
					{ label: "Copy as Markdown block", run: () => copy(`\`\`\`\n${text ?? ""}\n\`\`\``) },
				],
			};
		case "file":
			return {
				kind,
				actions: [
					{ label: "Open file", run: () => (kindEl ?? el).click() },
					{ label: "Copy path", run: () => copy(text ?? el.textContent ?? "") },
				],
			};
		default:
			return null;
	}
}

const ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
const SELECTOR = "button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), select, textarea:not(:disabled), [data-jump], [data-jump-kind=table], [data-jump-kind=code]";

interface Mark {
	label: string;
	el: HTMLElement;
	x: number;
	y: number;
}

function labelsFor(count: number): string[] {
	if (count <= ALPHABET.length) return ALPHABET.slice(0, count).split("");
	const out: string[] = [];
	for (const a of ALPHABET) for (const b of ALPHABET) out.push(a + b);
	return out.slice(0, count);
}

function collect(): Mark[] {
	const seen = new Set<HTMLElement>();
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const elements = [...document.querySelectorAll<HTMLElement>(SELECTOR)].filter(el => {
		if (seen.has(el) || el.closest("[data-jump-ignore]")) return false;
		seen.add(el);
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
		// Skip elements covered by something else (e.g. under a dialog overlay).
		const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width / 2, 12))), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
		return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
	});
	const labels = labelsFor(elements.length);
	return elements.map((el, i) => {
		const r = el.getBoundingClientRect();
		return { label: labels[i] ?? "", el, x: Math.max(0, r.left - 4), y: Math.max(0, r.top - 6) };
	});
}

export function JumpMarks() {
	const jumpMode = useApp(s => s.jumpMode);
	const setJumpMode = useApp(s => s.setJumpMode);
	const [marks, setMarks] = useState<Mark[]>([]);
	const [typed, setTyped] = useState("");
	const [menu, setMenu] = useState<{ kind: string; actions: MarkAction[]; x: number; y: number } | null>(null);

	useEffect(() => {
		if (!jumpMode) {
			setMarks([]);
			setTyped("");
			setMenu(null);
			return;
		}
		setMarks(collect());
		const onResize = () => setMarks(collect());
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [jumpMode]);

	useEffect(() => {
		if (!jumpMode) return;
		const onKey = (event: KeyboardEvent) => {
			if (menu) {
				event.preventDefault();
				event.stopPropagation();
				const index = Number.parseInt(event.key, 10) - 1;
				if (event.key === "Escape") setMenu(null);
				else if (menu.actions[index]) {
					setJumpMode(false);
					menu.actions[index].run();
				}
				return;
			}
			if (event.key === "Escape" || (event.altKey && ["j", "w"].includes(event.key.toLowerCase()))) {
				event.preventDefault();
				event.stopPropagation();
				setJumpMode(false);
				return;
			}
			if (event.key === "Backspace") {
				event.preventDefault();
				setTyped(t => t.slice(0, -1));
				return;
			}
			const key = event.key.toLowerCase();
			if (key.length !== 1 || !ALPHABET.includes(key) || event.ctrlKey || event.metaKey || event.altKey) return;
			event.preventDefault();
			event.stopPropagation();
			const next = typed + key;
			const exact = marks.find(m => m.label === next);
			if (exact) {
				const rich = actionsFor(exact.el);
				if (rich) {
					setMenu({ ...rich, x: exact.x, y: exact.y + 20 });
					return;
				}
				setJumpMode(false);
				const el = exact.el;
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.focus();
				else el.click();
				return;
			}
			if (marks.some(m => m.label.startsWith(next))) setTyped(next);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [jumpMode, marks, typed, setJumpMode, menu]);

	const visible = useMemo(() => marks.map(m => ({ ...m, dim: typed !== "" && !m.label.startsWith(typed) })), [marks, typed]);

	if (!jumpMode) return null;
	return (
		<div data-jump-ignore>
			{visible.map(mark => (
				<span key={mark.label} className={`gy-mark ${mark.dim ? "dim" : ""}`} style={{ left: mark.x, top: mark.y }}>
					{mark.label}
				</span>
			))}
			{menu && (
				<div className="gy-menu fixed z-[1002]" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 140) }} data-testid="jump-menu">
					<div className="px-2 py-1 font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--muted)" }}>
						{menu.kind}
					</div>
					{menu.actions.map((action, i) => (
						<button
							type="button"
							key={action.label}
							className="gy-menu-item w-full"
							onClick={() => {
								setJumpMode(false);
								action.run();
							}}
						>
							<span className="gy-kbd">{i + 1}</span> {action.label}
						</button>
					))}
				</div>
			)}
			<div className="fixed bottom-14 left-1/2 z-[1001] flex -translate-x-1/2 items-center gap-3 border px-4 py-2 text-[12px]" style={{ background: "var(--panel-2)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}>
				<span className="gy-label" style={{ color: "var(--text)" }}>
					marks
				</span>
				<span>
					Type a mark{typed && (
						<>
							: <span className="font-mono" style={{ color: "var(--highlight)" }}>{typed}</span>
						</>
					)}
				</span>
				<span style={{ color: "var(--muted)" }}>{menu ? "· 1-9 to pick · Esc back" : "· Backspace to undo · Esc to exit"}</span>
			</div>
		</div>
	);
}
