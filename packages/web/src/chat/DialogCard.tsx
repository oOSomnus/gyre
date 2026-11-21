/**
 * Renders omp `extension_ui_request` dialogs as transcript cards, answerable by
 * mouse or keyboard (Alt+1..9 picks options of the newest dialog).
 */
import type { OmpUiResponse } from "@gyre/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { gateway } from "../lib/gateway";
import type { AskQuestion, UiRequest } from "../lib/omp";

function Choice({
	index,
	label,
	description,
	checked,
	marker,
	onPick,
}: {
	index: number;
	label: string;
	description?: string;
	checked?: boolean;
	marker?: "radio" | "checkbox";
	onPick: () => void;
}) {
	return (
		<button type="button" data-jump="choice" onClick={onPick} data-active={index === 0} className="gy-choice">
			<span className="gy-kbd mt-[1px]">{index < 9 ? index + 1 : "·"}</span>
			{marker && <span className="mt-[1px] font-mono text-[12px]" style={{ color: "var(--highlight)" }}>{marker === "checkbox" ? (checked ? "[x]" : "[ ]") : checked ? "(•)" : "( )"}</span>}
			<span className="min-w-0 flex-1">
				<span className="block text-[13px]">{label}</span>
				{description && <span className="block text-[12px]" style={{ color: "var(--muted)" }}>{description}</span>}
			</span>
			<span className="gy-kbd hidden sm:inline-flex">↵</span>
		</button>
	);
}

export function DialogCard({ chatId, request, active }: { chatId: string; request: UiRequest; active: boolean }) {
	const respond = (response: Omit<OmpUiResponse, "id"> & Record<string, unknown>) =>
		gateway.respondUi(chatId, { id: request.id, ...response } as OmpUiResponse);
	const cancel = () => respond({ cancelled: true });

	const title =
		request.title ??
		(request.method === "confirm" ? "Confirm" : request.method === "ask" ? "Questions" : request.method === "form" ? "Form" : "Choose");
	// omp's tool approval prompts arrive as selects whose options end with "Deny".
	const safety = request.method === "select" && (request.options ?? []).some(o => o === "Deny") && (request.options ?? []).some(o => /^Approve/.test(o));
	const kind = safety ? "Tool safety" : request.method === "confirm" ? "Confirmation" : request.method === "select" ? "Completion choice" : request.method === "ask" ? "Question" : request.method;
	const optionCount = request.method === "select" ? (request.options?.length ?? 0) : request.method === "confirm" ? 2 : 0;

	return (
		<div className={`gy-card dialog ${safety ? "safety" : ""}`} data-dialog-id={request.id}>
			<div className="gy-card-head">
				<div className="gy-card-label">{kind}</div>
				<div className="gy-card-meta">
					{request.timeout ? <span>timeout {Math.round(request.timeout / 1000)}s</span> : null}
					<button type="button" onClick={cancel} data-jump="cancel">
						dismiss
					</button>
				</div>
			</div>
			<div className="gy-card-body space-y-2">
				<div className="whitespace-pre-wrap text-[13.5px]">{title}</div>
				{request.method === "select" && <SelectBody request={request} active={active} onPick={value => respond({ value })} />}
				{request.method === "confirm" && <ConfirmBody request={request} active={active} onAnswer={confirmed => respond({ confirmed })} />}
				{(request.method === "input" || request.method === "editor") && (
					<InputBody request={request} onSubmit={value => respond({ value })} onCancel={cancel} />
				)}
				{request.method === "ask" && <AskBody request={request} onSubmit={answers => respond({ answers })} />}
				{request.method === "form" && <FormBody request={request} onSubmit={data => respond({ data })} onCancel={cancel} />}
				{optionCount > 0 && (
					<div className="flex items-center gap-1.5 pt-1 font-mono text-[11px]" style={{ color: "var(--muted)" }}>
						<span className="gy-kbd">Alt</span>+<span className="gy-kbd">1</span>…<span className="gy-kbd">{Math.min(9, optionCount)}</span>
						<span>· choose options</span>
						<span className="mx-1">·</span>
						<span className="gy-kbd">Esc</span>
						<span>· dismiss</span>
					</div>
				)}
			</div>
		</div>
	);
}

function useAltDigits(active: boolean, count: number, pick: (index: number) => void) {
	const pickRef = useRef(pick);
	pickRef.current = pick;
	useEffect(() => {
		if (!active) return;
		const handler = (event: KeyboardEvent) => {
			if (!event.altKey || event.ctrlKey || event.metaKey) return;
			const digit = Number.parseInt(event.key, 10);
			if (digit >= 1 && digit <= Math.min(9, count)) {
				event.preventDefault();
				pickRef.current(digit - 1);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [active, count]);
}

function SelectBody({ request, active, onPick }: { request: UiRequest; active: boolean; onPick: (value: string) => void }) {
	const options = request.options ?? [];
	useAltDigits(active, options.length, i => options[i] !== undefined && onPick(options[i] as string));
	const markable = request.selectionMarker ? (request.markableCount ?? options.length) : 0;
	return (
		<div className="space-y-1.5">
			{request.message && <div style={{ color: "var(--text-dim)" }}>{request.message}</div>}
			{options.map((option, i) => (
				<Choice
					key={`${i}-${option}`}
					index={i}
					label={option}
					description={request.optionDetails?.[i]?.description}
					marker={i < markable ? request.selectionMarker : undefined}
					checked={request.checkedIndices?.includes(i)}
					onPick={() => onPick(option)}
				/>
			))}
		</div>
	);
}

function ConfirmBody({ request, active, onAnswer }: { request: UiRequest; active: boolean; onAnswer: (yes: boolean) => void }) {
	useAltDigits(active, 2, i => onAnswer(i === 0));
	return (
		<div className="space-y-2">
			{request.message && <div className="whitespace-pre-wrap" style={{ color: "var(--text-dim)" }}>{request.message}</div>}
			<div className="space-y-1.5">
				<Choice index={0} label="Yes" onPick={() => onAnswer(true)} />
				<Choice index={1} label="No" onPick={() => onAnswer(false)} />
			</div>
		</div>
	);
}

function InputBody({ request, onSubmit, onCancel }: { request: UiRequest; onSubmit: (v: string) => void; onCancel: () => void }) {
	const [value, setValue] = useState(request.prefill ?? "");
	const multiline = request.method === "editor";
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={event => {
				event.preventDefault();
				onSubmit(value);
			}}
		>
			{multiline ? (
				<textarea
					autoFocus
					className="gy-input min-h-32 py-2 font-mono"
					value={value}
					onChange={e => setValue(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmit(value);
						if (e.key === "Escape") onCancel();
					}}
				/>
			) : (
				<input
					autoFocus
					className="gy-input"
					type={request.secret ? "password" : "text"}
					placeholder={request.placeholder}
					value={value}
					onChange={e => setValue(e.target.value)}
					onKeyDown={e => e.key === "Escape" && onCancel()}
				/>
			)}
			<div className="flex justify-end gap-2">
				<button type="submit" className="gy-btn primary">
					Submit {multiline && <span className="gy-kbd">Ctrl ↵</span>}
				</button>
			</div>
		</form>
	);
}

function optionLabel(option: AskQuestion["options"][number]): { label: string; description?: string } {
	return typeof option === "string" ? { label: option } : option;
}

function AskBody({ request, onSubmit }: { request: UiRequest; onSubmit: (answers: unknown) => void }) {
	const questions = (request.questions ?? []) as Array<AskQuestion & { multi?: boolean; recommended?: number }>;
	const [selected, setSelected] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(
			questions.map(q => {
				const rec = typeof q.recommended === "number" ? q.options[q.recommended] : undefined;
				return [q.id, rec && !q.multi ? [optionLabel(rec).label] : []];
			}),
		),
	);
	const [custom, setCustom] = useState<Record<string, string>>({});
	const toggle = (q: AskQuestion & { multi?: boolean }, label: string) =>
		setSelected(prev => {
			const cur = prev[q.id] ?? [];
			if (q.multi) return { ...prev, [q.id]: cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label] };
			return { ...prev, [q.id]: cur[0] === label ? [] : [label] };
		});
	return (
		<div className="space-y-4">
			{questions.map(q => (
				<div key={q.id} className="space-y-1.5">
					{q.header && <div className="gy-label">{q.header}</div>}
					<div className="text-[13px]">{q.question}</div>
					{q.options.map((raw, i) => {
						const { label, description } = optionLabel(raw);
						return (
							<Choice
								key={label}
								index={i}
								label={label}
								description={description}
								marker={q.multi ? "checkbox" : "radio"}
								checked={(selected[q.id] ?? []).includes(label)}
								onPick={() => {
									toggle(q, label);
									if (!q.multi) setCustom(prev => ({ ...prev, [q.id]: "" }));
								}}
							/>
						);
					})}
					<input
						className="gy-input w-full"
						placeholder="Other (free text)…"
						value={custom[q.id] ?? ""}
						onChange={e => {
							const text = e.target.value;
							setCustom(prev => ({ ...prev, [q.id]: text }));
							if (!q.multi && text.trim()) setSelected(prev => ({ ...prev, [q.id]: [] }));
						}}
					/>
				</div>
			))}
			<div className="flex justify-end">
				<button
					type="button"
					className="gy-btn primary"
					onClick={() =>
						onSubmit(
							questions.map(q => {
								const customInput = (custom[q.id] ?? "").trim();
								return {
									id: q.id,
									selectedOptions: q.multi || !customInput ? (selected[q.id] ?? []) : [],
									...(customInput ? { customInput } : {}),
								};
							}),
						)
					}
				>
					Submit answers
				</button>
			</div>
		</div>
	);
}

// ---------- HTML form rendering (the `ask` tool's form protocol) ----------

const ALLOWED_TAGS = new Set([
	"FORM", "FIELDSET", "LEGEND", "LABEL", "INPUT", "SELECT", "OPTION", "OPTGROUP", "TEXTAREA", "DIV", "SPAN", "P",
	"BR", "STRONG", "EM", "B", "I", "CODE", "PRE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "SMALL", "DETAILS", "SUMMARY", "HR",
]);

function sanitizeForm(html: string): HTMLFormElement {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const walk = (el: Element) => {
		for (const child of [...el.children]) {
			if (!ALLOWED_TAGS.has(child.tagName)) {
				child.remove();
				continue;
			}
			for (const attr of [...child.attributes]) {
				const name = attr.name.toLowerCase();
				if (name.startsWith("on") || name === "style" || name === "action" || name === "formaction" || name === "src" || name === "href") {
					child.removeAttribute(attr.name);
				}
			}
			walk(child);
		}
	};
	walk(doc.body);
	let form = doc.body.querySelector("form");
	if (!form) {
		form = doc.createElement("form");
		form.append(...doc.body.childNodes);
	}
	return form;
}

/** Collect submitted values following omp's documented `data` shape. */
function collectFormData(form: HTMLFormElement): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	const names = new Set<string>();
	for (const el of form.elements) {
		const name = (el as HTMLInputElement).name;
		if (name && !name.startsWith("__mc_other__")) names.add(name);
	}
	for (const name of names) {
		const fields = [...form.elements].filter(el => (el as HTMLInputElement).name === name) as Array<
			HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
		>;
		const first = fields[0];
		if (!first) continue;
		const other = (form.elements.namedItem(`__mc_other__${name}`) as HTMLInputElement | null)?.value.trim();
		if (first instanceof HTMLInputElement && (first.type === "checkbox" || first.type === "radio")) {
			const group = fields as HTMLInputElement[];
			const chosen = group.filter(f => f.checked && !f.disabled).map(f => f.value);
			if (first.type === "checkbox" && group.length >= 2) {
				data[name] = other ? [...chosen, other] : chosen;
			} else if (other && group.length >= 2) {
				data[name] = other;
			} else if (chosen.length > 0) {
				data[name] = chosen[0];
			}
		} else if (first instanceof HTMLSelectElement) {
			if (first.multiple && first.options.length >= 2) data[name] = [...first.selectedOptions].map(o => o.value);
			else if (first.value !== "") data[name] = first.value;
		} else if (first instanceof HTMLInputElement && first.type === "hidden") {
			data[name] = first.value;
		} else if (first instanceof HTMLInputElement && (first.type === "number" || first.type === "range")) {
			if (first.value !== "") data[name] = Number(first.value);
		} else {
			data[name] = first.value;
		}
	}
	return data;
}

function FormBody({ request, onSubmit, onCancel }: { request: UiRequest; onSubmit: (d: Record<string, unknown>) => void; onCancel: () => void }) {
	const host = useRef<HTMLDivElement>(null);
	const form = useMemo(() => sanitizeForm(request.html ?? ""), [request.html]);
	useEffect(() => {
		const container = host.current;
		if (!container) return;
		container.replaceChildren(form);
		form.className = "gy-form space-y-3";
		// Offer free-text "Other" for radio/checkbox groups of 2+ options without one.
		const groups = new Map<string, HTMLInputElement[]>();
		for (const input of form.querySelectorAll<HTMLInputElement>("input[type=radio],input[type=checkbox]")) {
			if (!input.name) continue;
			groups.set(input.name, [...(groups.get(input.name) ?? []), input]);
		}
		for (const [name, inputs] of groups) {
			if (inputs.length < 2) continue;
			const hasOther = inputs.some(i => (i.closest("label")?.textContent ?? i.value).trim().toLowerCase() === "other");
			if (hasOther || form.querySelector(`[name="__mc_other__${CSS.escape(name)}"]`)) continue;
			const other = document.createElement("input");
			other.name = `__mc_other__${name}`;
			other.placeholder = "Other…";
			other.className = "gy-input mt-1 w-full";
			const last = inputs[inputs.length - 1];
			(last?.closest("label") ?? last)?.after(other);
		}
		for (const el of form.querySelectorAll<HTMLElement>("input:not([type=radio]):not([type=checkbox]):not([type=hidden]),select,textarea")) {
			if (!el.classList.contains("gy-input")) el.classList.add("gy-input");
		}
		const submit = (event: SubmitEvent) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			onSubmit(collectFormData(form));
		};
		form.addEventListener("submit", submit);
		return () => form.removeEventListener("submit", submit);
	}, [form, onSubmit]);
	return (
		<div className="space-y-3">
			<div ref={host} />
			<div className="flex justify-end gap-2">
				<button type="button" className="gy-btn" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="gy-btn primary" onClick={() => form.requestSubmit()}>
					Submit
				</button>
			</div>
		</div>
	);
}
