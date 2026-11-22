/**
 * Whether omp can run chats (installed, with at least one model provider). The
 * gateway checks with `omp models --json`; the UI shows setup guidance instead
 * of dead chats until it reports "ok".
 */
import type { HealthInfo, OmpStatus } from "@gyre/protocol";
import { create } from "zustand";
import { api, gateway } from "./gateway";

/** Statuses in which chats cannot start until the user sets omp up. */
export function needsSetup(status: OmpStatus): status is "missing" | "no-models" {
	return status === "missing" || status === "no-models";
}

/** omp's own message when it refuses to start without a provider. */
export const NO_MODELS_TEXT = /No models available|no model provider configured|omp is not installed/i;

interface OmpStatusStore {
	status: OmpStatus;
	ompVersion: string | null;
	rechecking: boolean;
	refresh(): Promise<void>;
	/** Ask the gateway to re-run its checks (after installing omp or adding a provider). */
	recheck(): Promise<OmpStatus>;
}

let polling: ReturnType<typeof setTimeout> | undefined;

export const useOmpStatus = create<OmpStatusStore>((set, get) => {
	const apply = (health: HealthInfo) => {
		set({ status: health.ompStatus ?? "unknown", ompVersion: health.ompVersion });
		// The first check runs in the background on the gateway; follow it until it settles.
		clearTimeout(polling);
		if (health.ompStatus === "checking") polling = setTimeout(() => void get().refresh(), 1500);
	};
	return {
		status: "checking",
		ompVersion: null,
		rechecking: false,
		async refresh() {
			apply(await api<HealthInfo>("/api/health").catch(() => ({ ok: false, version: "", ompVersion: get().ompVersion, ompStatus: "unknown" as const })));
		},
		async recheck() {
			set({ rechecking: true });
			try {
				const health = await api<HealthInfo>("/api/omp/recheck", { method: "POST" });
				apply(health);
				return health.ompStatus;
			} finally {
				set({ rechecking: false });
			}
		},
	};
});

/** Called once at startup. */
export function wireOmpStatus(): void {
	gateway.on(message => {
		if (message.t === "welcome") {
			if (message.ompStatus) useOmpStatus.setState({ status: message.ompStatus, ompVersion: message.ompVersion });
			if (!message.ompStatus || message.ompStatus === "checking") void useOmpStatus.getState().refresh();
		} else if (message.t === "chat" && message.chat.status === "exited" && NO_MODELS_TEXT.test(message.chat.error ?? "")) {
			// A chat died because omp lost its provider: the gateway has updated its status.
			void useOmpStatus.getState().refresh();
		}
	});
}
