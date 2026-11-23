/**
 * What an omp `extension_ui_request` means, shared by the gateway (which
 * replays unanswered requests to late subscribers) and the web (which renders
 * them), so the two can never disagree about which requests await an answer.
 *
 * Frames still pass through unchanged; this only classifies them.
 */

/** Requests that wait for an `extension_ui_response`. */
export const UI_DIALOG_METHODS = ["select", "confirm", "input", "editor", "ask", "form"] as const;

/** Fire-and-forget presentation updates (no response expected). */
export const UI_PRESENTATION_METHODS = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"] as const;

/** Withdraws an earlier request (`targetId`). */
export const UI_CANCEL_METHOD = "cancel";

export type UiRequestKind = "dialog" | "presentation" | "cancel";

const PRESENTATION = new Set<string>(UI_PRESENTATION_METHODS);
const KNOWN = new Set<string>([...UI_DIALOG_METHODS, ...UI_PRESENTATION_METHODS, UI_CANCEL_METHOD]);

/** Whether Gyre has a dedicated rendering for this method (unknown ones get a generic dialog). */
export function isKnownUiMethod(method: string): boolean {
	return KNOWN.has(method);
}

/**
 * Classify a request method. A method Gyre does not know yet is a dialog: omp
 * may be waiting for an answer, so it is kept, replayed and shown (with its raw
 * payload and a dismiss action) rather than silently dropped.
 */
export function uiRequestKind(method: string): UiRequestKind {
	if (method === UI_CANCEL_METHOD) return "cancel";
	if (PRESENTATION.has(method)) return "presentation";
	return "dialog";
}
