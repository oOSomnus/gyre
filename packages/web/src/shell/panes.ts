/** Pane kind registry: icon, default title and whether the kind needs a project. */
import type { PaneKind, PaneSpec } from "@gyre/protocol";
import {
	Bot,
	ClipboardList,
	FileText,
	GitBranch,
	History,
	Image,
	ListChecks,
	MessageSquareText,
	MessagesSquare,
	Network,
	ScrollText,
	Settings,
	SquareTerminal,
	Workflow,
	Activity,
	Sparkles,
	Webhook,
	Cpu,
	type LucideIcon,
} from "lucide-react";
import { useChats } from "../store/chats";

export interface PaneMeta {
	icon: LucideIcon;
	title: string;
	/** Needs a project (cwd) to work. */
	needsProject: boolean;
	/** Attached to a chat (opened from it). */
	chatBound?: boolean;
	/** Shown in the "New" menu and the palette's Open group. */
	creatable?: boolean;
}

export const PANE_META: Record<PaneKind, PaneMeta> = {
	chat: { icon: MessagesSquare, title: "Chat", needsProject: true, creatable: true },
	terminal: { icon: SquareTerminal, title: "Terminal", needsProject: true, creatable: true },
	file: { icon: FileText, title: "Files", needsProject: true, creatable: true },
	sessions: { icon: History, title: "Sessions", needsProject: true, creatable: true },
	tasks: { icon: Activity, title: "Task Manager", needsProject: false, creatable: true },
	subagents: { icon: Network, title: "Agents", needsProject: false, creatable: true },
	studio: { icon: Sparkles, title: "Agent Studio", needsProject: false, creatable: true },
	git: { icon: GitBranch, title: "Git", needsProject: true, creatable: true },
	hooks: { icon: Webhook, title: "Hook Studio", needsProject: false, creatable: true },
	jobs: { icon: Cpu, title: "Background jobs", needsProject: false, creatable: true },
	settings: { icon: Settings, title: "Settings", needsProject: false, creatable: true },
	events: { icon: ScrollText, title: "Events", needsProject: false, chatBound: true, creatable: true },
	plan: { icon: ClipboardList, title: "Plan", needsProject: false, chatBound: true },
	objectives: { icon: ListChecks, title: "Objectives", needsProject: false, chatBound: true },
	graph: { icon: Workflow, title: "Event graph", needsProject: false, chatBound: true },
	message: { icon: MessageSquareText, title: "Message", needsProject: false, chatBound: true },
	image: { icon: Image, title: "Image", needsProject: false, chatBound: true },
	subagent: { icon: Bot, title: "Sub-agent", needsProject: false, chatBound: true },
};

function chatName(chatId: string): string {
	const chat = useChats.getState().chats[chatId];
	const name = chat?.state?.sessionName ?? chat?.title;
	if (name) return String(name);
	const firstUser = chat?.items.find(i => i.kind === "message" && i.message.role === "user");
	if (firstUser?.kind === "message") {
		const c = firstUser.message.content;
		const text = typeof c === "string" ? c : Array.isArray(c) ? ((c.find(b => b.type === "text") as { text?: string })?.text ?? "") : "";
		if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text;
	}
	return "New chat";
}

export function paneTitle(pane: PaneSpec): string {
	if (pane.title) return pane.title;
	if (pane.kind === "chat") return chatName(pane.id);
	if (pane.kind === "git") return pane.revision ? `Git · ${pane.revision}` : "Git";
	if (pane.kind === "file") return pane.filePath ? (pane.filePath.split("/").pop() ?? "Files") : "Files";
	const base = PANE_META[pane.kind]?.title ?? pane.kind;
	if (pane.kind === "subagent") {
		const sub = pane.chatId ? useChats.getState().chats[pane.chatId]?.subagents[pane.ref ?? ""] : undefined;
		if (sub?.agent) return `${String(sub.agent)} · ${base}`;
	}
	if (pane.chatId && PANE_META[pane.kind]?.chatBound) return `${base} · ${chatName(pane.chatId)}`;
	return base;
}
