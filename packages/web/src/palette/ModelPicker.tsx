import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import type { ModelPickerRow } from "../lib/omp";
import { BUILTIN_ROLES, useRolesStore } from "../lib/roles";
import { useApp } from "../store/app";
import { refreshState, useChats } from "../store/chats";

/** omp's own model picker (ranking, recents, roles) served over RPC. */
export function ModelPicker() {
	const chatId = useApp(s => s.modelPickerChatId);
	const close = () => useApp.getState().openModelPicker(null);
	const state = useChats(s => (chatId ? s.chats[chatId]?.state : undefined));
	const [query, setQuery] = useState("");
	const roles = useRolesStore();
	useEffect(() => {
		if (chatId) void roles.load().catch(() => {});
	}, [chatId, roles.load]);
	const [result, setResult] = useState<{ chatId: string; query: string; rows: ModelPickerRow[] } | null>(null);
	const rows = result?.chatId === chatId && result?.query === query ? result.rows : null;
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!chatId) return;
		let current = true;
		setError(null);
		const timer = setTimeout(() => {
			void gateway
				.rpc<{ rows: ModelPickerRow[] }>(chatId, { type: "get_model_picker", query, limit: 80 })
				.then(data => {
					if (current) setResult({ chatId, query, rows: data?.rows ?? [] });
				})
				.catch(e => {
					if (current) setError((e as Error).message);
				});
		}, 120);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [chatId, query]);

	useEffect(() => {
		if (!chatId) {
			setResult(null);
			setQuery("");
		}
	}, [chatId]);

	const choose = async (row: ModelPickerRow) => {
		if (!chatId) return;
		try {
			await gateway.rpc(chatId, { type: "set_model", provider: row.provider, modelId: row.id, ...(row.role ? { role: row.role } : {}) }, 60_000);
			refreshState(chatId, 0);
			close();
		} catch (e) {
			setError((e as Error).message);
		}
	};

	const setThinking = async (level: string) => {
		if (!chatId) return;
		await gateway.rpc(chatId, { type: "set_thinking_level", level }).catch(e => setError((e as Error).message));
		refreshState(chatId, 0);
	};

	const levels = state?.thinkingLevels ?? [];
	const assignRole = useRolesStore(s => s.assign);
	const [assigned, setAssigned] = useState<string | null>(null);
	const assign = async (row: ModelPickerRow, role: string) => {
		try {
			if (!roles.loaded || roles.error) throw new Error(roles.error ?? "Model roles are still loading.");
			await assignRole(role, `${row.provider}/${row.id}`);
			setAssigned(`@${role} → ${row.provider}/${row.id}`);
		} catch (e) {
			setError((e as Error).message);
		}
	};

	return (
		<Dialog.Root open={chatId !== null} onOpenChange={open => !open && close()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgb(0 0 0 / 0.35)" }} />
				<Dialog.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[12vh] z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden border"
					style={{ background: "var(--panel-2)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
				>
					<Dialog.Title className="sr-only">Model picker</Dialog.Title>
					{levels.length > 0 && (
						<div className="flex items-center gap-1 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
							<span className="gy-label mr-2">thinking</span>
							{levels.map(level => (
								<button
									type="button"
									key={level}
									className="gy-btn"
									style={{ height: 24, ...(state?.thinkingLevel === level ? { borderColor: "var(--think)", color: "var(--think)" } : {}) }}
									onClick={() => void setThinking(level)}
								>
									{level}
								</button>
							))}
						</div>
					)}
					{roles.error && (
						<div role="alert" className="p-3">
							{roles.error}
							<button type="button" className="gy-btn" onClick={() => void roles.load().catch(() => {})}>
								Retry loading roles
							</button>
						</div>
					)}
					<Command shouldFilter={false} loop>
						<Command.Input
							autoFocus
							value={query}
							onValueChange={setQuery}
							placeholder="Search models · provider/ to filter · @ for roles"
							className="h-12 w-full border-b bg-transparent px-4 text-[14px] outline-none"
							style={{ borderColor: "var(--border)" }}
						/>
						<Command.List className="max-h-[56vh] overflow-auto p-1">
							{rows === null && !error && (
								<div className="flex items-center gap-2 p-4" style={{ color: "var(--muted)" }}>
									<Loader2 size={14} className="animate-spin" /> Loading models…
								</div>
							)}
							{error && (
								<div className="p-4 text-[12.5px]" style={{ color: "var(--err)" }}>
									{error}
								</div>
							)}
							{rows?.length === 0 && <Command.Empty className="p-4 text-[12.5px]">No models match.</Command.Empty>}
							{rows?.map(row => (
								<Command.Item
									key={`${row.role ?? ""}${row.provider}/${row.id}`}
									value={`${row.role ?? ""}${row.provider}/${row.id}`}
									onSelect={() => void choose(row)}
									className="flex cursor-pointer items-center gap-3 px-3 py-2"
								>
									<span className="w-4">{row.current && <Check size={14} style={{ color: "var(--ok)" }} />}</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px]">
											{row.role ? <span style={{ color: "var(--highlight)" }}>@{row.role} → </span> : null}
											{row.name ?? row.id}
										</span>
										<span className="block truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
											{row.provider}/{row.id}
										</span>
									</span>
									{row.roles?.slice(0, 3).map(r => (
										<span key={r.role} className="gy-chip">
											{r.label ?? r.role}
										</span>
									))}
									{row.overContext && (
										<span className="gy-chip" style={{ color: "var(--warn)" }}>
											over context
										</span>
									)}
									{!row.role && (
										<select
											className="gy-input h-6 text-[11px]"
											value=""
											disabled={!roles.loaded || roles.error !== null}
											title="Assign this model to a role (saved in omp's modelRoles)"
											onClick={e => e.stopPropagation()}
											onKeyDown={e => e.stopPropagation()}
											onChange={e => {
												if (e.target.value) void assign(row, e.target.value);
											}}
										>
											<option value="">Assign to role…</option>
											{BUILTIN_ROLES.filter(r => r.section === "chat").map(r => (
												<option key={r.id} value={r.id}>
													@{r.id} · {r.name}
												</option>
											))}
										</select>
									)}
								</Command.Item>
							))}
						</Command.List>
					</Command>
					<div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11.5px]" style={{ borderColor: "var(--border-strong)", color: "var(--muted)" }}>
						{assigned ? (
							<span style={{ color: "var(--ok)" }}>Saved {assigned}</span>
						) : (
							<span>Enter: use for this chat · “Assign to role…”: save as a role in omp · type @ to switch the chat to a role</span>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
