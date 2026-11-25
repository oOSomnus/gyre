import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import type { ModelPickerRow } from "../lib/omp";
import { ROLE_EFFORTS, roleSelector, selectorEffort, selectorModel } from "../lib/role-selector";
import { filterRoleRows, modelKey, type RoleViewRow, roleViewRows } from "../lib/role-view";
import { BUILTIN_ROLES, useRoles, useRolesStore } from "../lib/roles";
import { type ModelPickerView, useApp } from "../store/app";
import { refreshState, useChats } from "../store/chats";

/**
 * omp's own model picker (ranking, recents, roles) served over RPC, with a second
 * view listing every role and the model (and effort) it runs. Ctrl+M switches views.
 */
export function ModelPicker() {
	const chatId = useApp(s => s.modelPickerChatId);
	const view = useApp(s => s.modelPickerView);
	const setView = useApp(s => s.setModelPickerView);
	const close = () => useApp.getState().openModelPicker(null);
	const state = useChats(s => (chatId ? s.chats[chatId]?.state : undefined));
	const [query, setQuery] = useState("");
	const roles = useRolesStore();
	const { roles: allRoles, assignments } = useRoles();
	useEffect(() => {
		if (chatId) void roles.load().catch(() => {});
	}, [chatId, roles.load]);
	/** The role whose model is being picked in the model view ("Change…" in the role view). */
	const [assigning, setAssigning] = useState<string | null>(null);
	/** The role view lists every role from omp's browse order (role-held models come first). */
	const pickerQuery = view === "roles" ? "" : query;
	const [result, setResult] = useState<{ chatId: string; query: string; rows: ModelPickerRow[] } | null>(null);
	const rows = result?.chatId === chatId && result?.query === pickerQuery ? result.rows : null;
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	/** The highlighted item (cmdk), for Shift+Enter in the role view. */
	const [selected, setSelected] = useState("");
	/** Per-model effort picked in a row (omp's thinking slider), keyed by provider/id. */
	const [efforts, setEfforts] = useState<Record<string, string>>({});
	const rowKey = (row: ModelPickerRow) => `${row.provider}/${row.id}`;
	/** The effort a row applies: a role row's own level, else the row's pick or the level the model would run at. */
	const rowEffort = (row: ModelPickerRow) => (row.role ? row.thinkingLevel : (efforts[rowKey(row)] ?? row.thinkingLevel));
	/** Picking a model for a role keeps the role's effort unless one is picked in the row. */
	const assigningEffort = (row: ModelPickerRow, role: string) => efforts[rowKey(row)] ?? selectorEffort(assignments[role]);

	useEffect(() => {
		if (!chatId) return;
		let current = true;
		setError(null);
		const timer = setTimeout(() => {
			void gateway
				.rpc<{ rows: ModelPickerRow[] }>(chatId, { type: "get_model_picker", query: pickerQuery, limit: view === "roles" ? 200 : 80 })
				.then(data => {
					if (current) setResult({ chatId, query: pickerQuery, rows: data?.rows ?? [] });
				})
				.catch(e => {
					if (current) setError((e as Error).message);
				});
		}, 120);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [chatId, pickerQuery, view, reload]);

	useEffect(() => {
		if (!chatId) {
			setResult(null);
			setQuery("");
			setAssigning(null);
		}
	}, [chatId]);

	// An effort picked in a row belongs to one pass through the model view: a new "Change…"
	// (or leaving one) starts from the role's own effort again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets on these changes only
	useEffect(() => setEfforts({}), [chatId, view, assigning]);

	// Each view starts with an empty search; leaving the model view ends a "Change…".
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on view changes only
	useEffect(() => {
		setQuery("");
		setSelected("");
		if (view === "roles") setAssigning(null);
	}, [view]);

	const changed = (message: string) => {
		setAssigned(message);
		// Role chips and resolutions changed: re-read the rows.
		setResult(null);
		setReload(n => n + 1);
	};

	const choose = async (row: ModelPickerRow) => {
		if (!chatId) return;
		if (assigning) {
			if (await saveRole(assigning, roleSelector(rowKey(row), assigningEffort(row, assigning)))) setView("roles");
			return;
		}
		try {
			// A role binds a model and an effort; a model row applies the effort picked in it.
			const thinkingLevel = row.role ? row.thinkingLevel : efforts[rowKey(row)];
			await gateway.rpc(
				chatId,
				{ type: "set_model", provider: row.provider, modelId: row.id, ...(row.role ? { role: row.role } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) },
				60_000,
			);
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
		// Rows report the level each model would run at; re-read them so unpicked rows follow the chat.
		setResult(null);
		setReload(n => n + 1);
	};

	const levels = state?.thinkingLevels ?? [];
	const assignRole = useRolesStore(s => s.assign);
	const [assigned, setAssigned] = useState<string | null>(null);
	const saveRole = async (role: string, selector: string): Promise<boolean> => {
		try {
			if (!roles.loaded || roles.error) throw new Error(roles.error ?? "Model roles are still loading.");
			await assignRole(role, selector);
			changed(`@${role} → ${selector}`);
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		}
	};
	// Saved as omp's TUI does: `provider/model:effort` (no suffix for inherit).
	const assign = (row: ModelPickerRow, role: string) => saveRole(role, roleSelector(rowKey(row), rowEffort(row)));

	// ---------------------------------------------------------------- role view

	const roleRows = view === "roles" && rows ? filterRoleRows(roleViewRows(allRoles, assignments, rows, state?.model), query) : null;
	const startChange = (role: string) => {
		setAssigning(role);
		setView("models");
	};
	/** Run this chat on the role: its model and effort. Capability roles (images, speech…) are only re-assigned. */
	const runRole = async (row: RoleViewRow) => {
		if (!chatId) return;
		if (!row.model || row.role.section !== "chat") {
			startChange(row.role.id);
			return;
		}
		try {
			await gateway.rpc(
				chatId,
				{ type: "set_model", provider: row.model.provider, modelId: row.model.id, role: row.role.id, ...(row.effort ? { thinkingLevel: row.effort } : {}) },
				60_000,
			);
			refreshState(chatId, 0);
			close();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	/** The model a role's effort is saved with: its configured model, else the one omp picked (which pins it). */
	const effortBase = (row: RoleViewRow) => selectorModel(row.selector) || (row.selector ? "" : row.model ? modelKey(row.model) : "");

	const title = view === "roles" ? "Roles" : assigning ? `Model for @${assigning}` : "Models";
	const switchView = (next: ModelPickerView) => {
		if (next !== view || assigning) {
			setAssigning(null);
			setView(next);
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
					onEscapeKeyDown={e => {
						// Esc while picking a role's model goes back to the role view.
						if (assigning) {
							e.preventDefault();
							setView("roles");
						}
					}}
				>
					<Dialog.Title className="sr-only">Model picker: {title}</Dialog.Title>
					<div className="flex flex-wrap items-center gap-1 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
						<div role="tablist" aria-label="Model picker view" className="mr-3 flex gap-1">
							{(["models", "roles"] as const).map(id => (
								<button
									type="button"
									role="tab"
									key={id}
									aria-selected={view === id}
									className="gy-btn"
									data-testid={`model-picker-view-${id}`}
									style={{ height: 24, ...(view === id ? { borderColor: "var(--border-strong)", background: "var(--choice-active)" } : {}) }}
									onClick={() => switchView(id)}
								>
									{id === "models" ? "Models" : "Roles"}
								</button>
							))}
						</div>
						{levels.length > 0 && (
							<>
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
							</>
						)}
					</div>
					{roles.error && (
						<div role="alert" className="p-3">
							{roles.error}
							<button type="button" className="gy-btn" onClick={() => void roles.load().catch(() => {})}>
								Retry loading roles
							</button>
						</div>
					)}
					{assigning && (
						<div className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px]" style={{ borderColor: "var(--border)", background: "var(--tint-tool)" }}>
							<span className="min-w-0 flex-1">
								Pick the model for <b>@{assigning}</b>. Its effort is kept unless you pick one in the row.
							</span>
							<button type="button" className="gy-btn" style={{ height: 22 }} onClick={() => setView("roles")}>
								Cancel
							</button>
						</div>
					)}
					<Command shouldFilter={false} loop value={selected} onValueChange={setSelected}>
						<Command.Input
							autoFocus
							value={query}
							onValueChange={setQuery}
							placeholder={view === "roles" ? "Filter roles or models" : assigning ? `Search a model for @${assigning}` : "Search models · provider/ to filter · @ for roles"}
							className="h-12 w-full border-b bg-transparent px-4 text-[14px] outline-none"
							style={{ borderColor: "var(--border)" }}
							onKeyDown={e => {
								// Shift+Enter in the role view: change the highlighted role's model.
								if (view === "roles" && e.key === "Enter" && e.shiftKey && selected.startsWith("role:")) {
									e.preventDefault();
									e.stopPropagation();
									startChange(selected.slice("role:".length));
								}
							}}
						/>
						<Command.List className="max-h-[56vh] overflow-auto p-1">
							{rows === null && !error && (
								<div className="flex items-center gap-2 p-4" style={{ color: "var(--muted)" }}>
									<Loader2 size={14} className="animate-spin" /> {view === "roles" ? "Loading roles…" : "Loading models…"}
								</div>
							)}
							{error && (
								<div className="p-4 text-[12.5px]" style={{ color: "var(--err)" }}>
									{error}
								</div>
							)}
							{view === "roles" ? (
								<>
									{roleRows?.length === 0 && <Command.Empty className="p-4 text-[12.5px]">No roles match.</Command.Empty>}
									{(["chat", "kind"] as const).map(section => {
										const group = roleRows?.filter(row => row.role.section === section) ?? [];
										if (group.length === 0) return null;
										return (
											<Command.Group
												key={section}
												heading={section === "chat" ? "Chat roles" : "Capability roles"}
											>
												{group.map(row => (
													<RoleItem
														key={row.role.id}
														row={row}
														effortBase={effortBase(row)}
														disabled={!roles.loaded || roles.error !== null}
														onUse={() => void runRole(row)}
														onChange={() => startChange(row.role.id)}
														onEffort={effort => {
															const base = effortBase(row);
															if (base) void saveRole(row.role.id, roleSelector(base, effort));
														}}
													/>
												))}
											</Command.Group>
										);
									})}
								</>
							) : (
								<>
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
													{row.role && row.thinkingLevel ? <span style={{ color: "var(--think)" }}> · {row.thinkingLevel}</span> : null}
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
											{!row.role && row.thinking && row.thinking.length > 0 && (
												<select
													className="gy-input h-6 text-[11px]"
													aria-label={`Effort for ${rowKey(row)}`}
													value={(assigning ? assigningEffort(row, assigning) : rowEffort(row)) ?? ""}
													title="Effort for this model: used when you pick it and saved with a role assignment"
													onClick={e => e.stopPropagation()}
													onKeyDown={e => e.stopPropagation()}
													onChange={e => {
														const level = e.target.value;
														setEfforts(prev => ({ ...prev, [rowKey(row)]: level }));
													}}
												>
													{!(assigning ? assigningEffort(row, assigning) : rowEffort(row)) && (
														<option value="">effort</option>
													)}
													{row.thinking.map(level => (
														<option key={level} value={level}>
															{level}
														</option>
													))}
												</select>
											)}
											{!row.role && !assigning && (
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
								</>
							)}
						</Command.List>
					</Command>
					<div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11.5px]" style={{ borderColor: "var(--border-strong)", color: "var(--muted)" }}>
						{assigned ? (
							<span style={{ color: "var(--ok)" }}>Saved {assigned}</span>
						) : view === "roles" ? (
							<span>Enter: run this chat on the role · Shift+Enter: change its model · Ctrl+M: models</span>
						) : assigning ? (
							<span>Enter: save as @{assigning}'s model · Esc: back to roles</span>
						) : (
							<span>Enter: use for this chat · “Assign to role…”: save the model and its effort as a role · Ctrl+M: roles</span>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function RoleItem({
	row,
	effortBase,
	disabled,
	onUse,
	onChange,
	onEffort,
}: {
	row: RoleViewRow;
	/** The model the effort is saved with; "" when it can't be (fallback list, role reference). */
	effortBase: string;
	disabled: boolean;
	onUse: () => void;
	onChange: () => void;
	onEffort: (effort: string) => void;
}) {
	const steps = row.thinking?.length ? row.thinking : ROLE_EFFORTS;
	const options = row.effort && !steps.includes(row.effort) ? [...steps, row.effort] : steps;
	return (
		<Command.Item
			value={`role:${row.role.id}`}
			onSelect={onUse}
			className="flex cursor-pointer items-center gap-3 px-3 py-2"
			data-role-row={row.role.id}
		>
			<span className="w-4">{row.current && <Check size={14} style={{ color: "var(--ok)" }} />}</span>
			<span className="w-40 shrink-0">
				<span className="block truncate text-[13px]">{row.role.name}</span>
				<span className="block truncate font-mono text-[11px]" style={{ color: "var(--highlight)" }}>
					@{row.role.id}
				</span>
			</span>
			<span className="min-w-0 flex-1">
				{row.model ? (
					<>
						<span className="block truncate text-[13px]">{row.model.name ?? row.model.id}</span>
						<span className="block truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
							{row.selector && !selectorModel(row.selector) ? row.selector : modelKey(row.model)}
						</span>
					</>
				) : (
					<span className="block truncate text-[12.5px]" style={{ color: "var(--muted)" }}>
						{row.selector ? <span className="font-mono">{row.selector}</span> : "No model: omp has nothing to pick"}
					</span>
				)}
			</span>
			{row.auto && (
				<span className="gy-chip" title="No model is set for this role; omp picks one">
					auto
				</span>
			)}
			<select
				className="gy-input h-6 w-32 text-[11px]"
				aria-label={`Effort for @${row.role.id}`}
				value={row.effort}
				disabled={disabled || !effortBase}
				title={
					!effortBase
						? "Set a single model for this role to give it an effort"
						: row.auto
							? "Saving an effort also pins the model omp picked to this role"
							: "Effort saved with this role's model"
				}
				onClick={e => e.stopPropagation()}
				onKeyDown={e => e.stopPropagation()}
				onChange={e => onEffort(e.target.value)}
			>
				<option value="">effort: inherit</option>
				{options.map(level => (
					<option key={level} value={level}>
						effort: {level}
					</option>
				))}
			</select>
			<button
				type="button"
				className="gy-btn"
				style={{ height: 24 }}
				disabled={disabled}
				onClick={e => {
					e.stopPropagation();
					onChange();
				}}
			>
				Change…
			</button>
		</Command.Item>
	);
}
