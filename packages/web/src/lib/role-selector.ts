/** omp role selectors: `provider/model[:effort]`, or comma-separated fallback lists. */
/** Effort levels a role selector may name (omp's `provider/model:<effort>`). */
export const ROLE_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** The `:<effort>` of a single-model role selector, or "" when it names none or is a fallback list. */
export function selectorEffort(selector: string | undefined): string {
	if (!selector || selector.includes(",") || !selector.includes(":")) return "";
	const suffix = selector.slice(selector.lastIndexOf(":") + 1).trim().toLowerCase();
	return ROLE_EFFORTS.includes(suffix) ? suffix : "";
}

/** A role selector binding a model and an effort, as omp's TUI saves it (no suffix for inherit). */
export function roleSelector(model: string, effort: string | undefined): string {
	return effort && effort !== "inherit" ? `${model}:${effort}` : model;
}

/**
 * A selector typed by hand. One that names its own effort, or `:inherit`, or a fallback
 * list keeps its choice (`:inherit` is saved as omp saves it, without a suffix); anything
 * else gets `effort`.
 */
export function typedRoleSelector(selector: string, effort: string | undefined): string {
	if (selector.includes(",") || selectorEffort(selector)) return selector;
	const at = selector.lastIndexOf(":");
	if (at > 0 && selector.slice(at + 1).trim().toLowerCase() === "inherit") return selector.slice(0, at).trimEnd();
	return roleSelector(selector, effort);
}
