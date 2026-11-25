/**
 * The model picker's role view: every role with the model it resolves to and its
 * effort. Pure, so it can be tested without the gateway.
 */
import type { ModelPickerRow } from "./omp";
import { selectorEffort, selectorModel } from "./role-selector";
import type { RoleInfo } from "./roles";

export interface RoleModel {
	provider: string;
	id: string;
	name?: string;
}

export interface RoleViewRow {
	role: RoleInfo;
	/** The role's configured selector; undefined when omp picks the model. */
	selector?: string;
	/** The model the role runs: omp's resolution when the picker reports it, else the configured one. */
	model?: RoleModel;
	/** omp picks the model (nothing configured). */
	auto: boolean;
	/** The role's explicit effort, or "" (the chat's level applies). */
	effort: string;
	/** Effort steps the model offers, when known. */
	thinking?: string[];
	/** This chat runs the role's model. */
	current: boolean;
}

/** `provider/id` (ids may contain slashes) as a model, or undefined. */
export function parseModel(base: string): RoleModel | undefined {
	const slash = base.indexOf("/");
	if (slash <= 0 || slash === base.length - 1) return undefined;
	return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
}

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/**
 * One row per role. `pickerRows` are model-view rows: the roles each model holds
 * (including omp's automatic picks) say what every role resolves to.
 */
export function roleViewRows(
	roles: readonly RoleInfo[],
	assignments: Readonly<Record<string, string>>,
	pickerRows: readonly ModelPickerRow[],
	current?: { provider: string; id: string } | null,
): RoleViewRow[] {
	const held = new Map<string, { row: ModelPickerRow; auto: boolean }>();
	for (const row of pickerRows) {
		if (row.role) continue;
		for (const chip of row.roles ?? []) if (!held.has(chip.role)) held.set(chip.role, { row, auto: Boolean(chip.auto) });
	}
	return roles.map(role => {
		const selector = assignments[role.id] || undefined;
		const resolved = held.get(role.id);
		const model = resolved ? { provider: resolved.row.provider, id: resolved.row.id, name: resolved.row.name } : parseModel(selectorModel(selector));
		return {
			role,
			selector,
			model,
			auto: !selector || Boolean(resolved?.auto),
			effort: selectorEffort(selector),
			thinking: resolved?.row.thinking,
			current: Boolean(model && current && modelKey(model) === modelKey(current)),
		};
	});
}

/** Rows whose role or model matches every word of `query`. */
export function filterRoleRows(rows: readonly RoleViewRow[], query: string): RoleViewRow[] {
	const words = query.toLowerCase().replace(/^@/, "").split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...rows];
	return rows.filter(row => {
		const text = [row.role.id, row.role.name, row.selector, row.model && modelKey(row.model), row.model?.name].filter(Boolean).join(" ").toLowerCase();
		return words.every(word => text.includes(word));
	});
}
