/** omp role selectors: `provider/model[:effort]`, or comma-separated fallback lists. */
/** Effort levels a role selector may name (omp's `provider/model:<effort>`). */
export const ROLE_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** The `:<effort>` of a single-model role selector, or "" when it names none or is a fallback list. */
export function selectorEffort(selector: string | undefined): string {
	if (!selector || selector.includes(",") || !selector.includes(":")) return "";
	const suffix = selector.slice(selector.lastIndexOf(":") + 1);
	return ROLE_EFFORTS.includes(suffix) ? suffix : "";
}

/** A role selector binding a model and an effort, as omp's TUI saves it (no suffix for inherit). */
export function roleSelector(model: string, effort: string | undefined): string {
	return effort && effort !== "inherit" ? `${model}:${effort}` : model;
}
