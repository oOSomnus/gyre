/**
 * The notification center: notifications raised from chat-store transitions, kept in
 * localStorage (newest 200), shown in the top bar's bell. A notification about a pane the
 * user is looking at is not raised; with desktop notifications on, a hidden tab also gets
 * a system notification.
 */
import { create } from "zustand";
import { detectNotifications, hookTarget, type NotificationDraft } from "../lib/notifications";
import { paneTitle } from "../shell/panes";
import { openChatPane, openJobsPane, openOrRevealPane, useApp } from "./app";
import { useChats } from "./chats";

export interface Notification extends NotificationDraft {
	id: string;
	ts: number;
	read: boolean;
}

const STORAGE_KEY = "gyre.notifications";
const SETTINGS_KEY = "gyre.desktopNotifications";
export const MAX_NOTIFICATIONS = 200;

function load(): Notification[] {
	try {
		const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Notification[];
		return Array.isArray(list) ? list.slice(0, MAX_NOTIFICATIONS) : [];
	} catch {
		return [];
	}
}

interface NotificationStore {
	items: Notification[];
	open: boolean;
	desktop: boolean;
	push(drafts: NotificationDraft[]): void;
	markAllRead(): void;
	markRead(id: string): void;
	clear(): void;
	setOpen(open: boolean): void;
	setDesktop(on: boolean): void;
}

const save = (items: Notification[]) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
	} catch {}
};

export const useNotifications = create<NotificationStore>((set, get) => ({
	items: load(),
	open: false,
	desktop: localStorage.getItem(SETTINGS_KEY) === "1",
	push(drafts) {
		if (!drafts.length) return;
		const known = new Set(get().items.map(n => n.key));
		const fresh = drafts.filter(d => !known.has(d.key)).map(d => ({ ...d, id: crypto.randomUUID(), ts: Date.now(), read: false }));
		if (!fresh.length) return;
		const items = [...fresh.reverse(), ...get().items].slice(0, MAX_NOTIFICATIONS);
		set({ items });
		save(items);
		if (get().desktop) for (const n of fresh) showDesktop(n);
	},
	markAllRead() {
		const items = get().items.map(n => (n.read ? n : { ...n, read: true }));
		set({ items });
		save(items);
	},
	markRead(id) {
		const items = get().items.map(n => (n.id === id ? { ...n, read: true } : n));
		set({ items });
		save(items);
	},
	clear() {
		set({ items: [] });
		save([]);
	},
	setOpen: open => set({ open }),
	setDesktop(on) {
		localStorage.setItem(SETTINGS_KEY, on ? "1" : "0");
		set({ desktop: on });
	},
}));

export const desktopNotificationsSupported = () => typeof Notification !== "undefined";

function showDesktop(n: Notification): void {
	if (!desktopNotificationsSupported() || Notification.permission !== "granted" || !document.hidden) return;
	try {
		const shown = new Notification(n.title, { body: n.body, tag: n.key });
		shown.onclick = () => {
			window.focus();
			openNotification(n);
		};
	} catch {}
}

/** The pane the user is looking at: focused in the active workspace while the page is visible. */
function watching(chatId: string): boolean {
	if (typeof document !== "undefined" && document.hidden) return false;
	const ws = useApp.getState().activeWorkspace();
	const focused = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined;
	return !!focused && (focused.id === chatId || focused.chatId === chatId);
}

/** Go to what a notification is about: Hook Studio for a failing hook, else its chat. */
export function openNotification(n: Notification): void {
	useNotifications.getState().markRead(n.id);
	const projectId = useChats.getState().chats[n.chatId]?.info.projectId;
	const project = useApp.getState().projects.find(p => p.id === projectId);
	const hook = hookTarget(n.extensionPath, project?.path);
	if (hook) {
		openOrRevealPane({ kind: "hooks", projectId, section: hook }, p => p.kind === "hooks");
		return;
	}
	if (n.kind === "plan") {
		openChatPane("plan", n.chatId);
		return;
	}
	if (n.kind === "job") {
		openJobsPane();
		return;
	}
	useApp.getState().revealPane(n.chatId);
}

/** Raise notifications from chat-store changes. Call once at startup. */
export function wireNotifications(): () => void {
	return useChats.subscribe((state, prev) => {
		const drafts = detectNotifications(prev.chats, state.chats, chatId => paneTitle({ id: chatId, kind: "chat" })).filter(
			d => !(watching(d.chatId) && (d.kind === "done" || d.kind === "needs-you" || d.kind === "plan")),
		);
		useNotifications.getState().push(drafts);
	});
}
