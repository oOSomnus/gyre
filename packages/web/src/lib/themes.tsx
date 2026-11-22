/**
 * Gyre's themes. Colours for the DOM live in styles.css as per-theme tokens;
 * this registry holds what non-CSS consumers need (xterm, the graph minimap,
 * shiki/mermaid/Monaco light-or-dark choice) and what the pickers show.
 */
export type ThemeId = "graphite" | "riso" | "phosphor" | "dune" | "dusk";

export interface ThemeMeta {
	id: ThemeId;
	label: string;
	description: string;
	scheme: "light" | "dark";
	/** Chrome, panel, accent, alert: shown in the pickers. */
	swatches: [string, string, string, string];
	xterm: { background: string; foreground: string; cursor: string; selectionBackground: string };
	/** Fill colours for the event graph's minimap (a canvas, so it cannot read CSS variables). */
	graph: Record<"prompt" | "assistant" | "tool" | "result" | "subagent" | "objective", string>;
}

export const THEMES: Record<ThemeId, ThemeMeta> = {
	graphite: {
		id: "graphite",
		label: "Graphite",
		description: "Ink-blue chrome around cool porcelain panes; cyan while working, orange when it needs you.",
		scheme: "light",
		swatches: ["#0f1420", "#e3e8ee", "#22b8c8", "#ff7a2f"],
		xterm: { background: "#0d121c", foreground: "#cfe1f0", cursor: "#2ad0e0", selectionBackground: "#2ad0e055" },
		graph: { prompt: "#dce6f4", assistant: "#c9d2dd", tool: "#b9e3e6", result: "#cfe0d8", subagent: "#bfe2e0", objective: "#e5e2f7" },
	},
	riso: {
		id: "riso",
		label: "Riso",
		description: "Pink and blue spot inks on off-white paper, a strong halftone and square corners.",
		scheme: "light",
		swatches: ["#0a6fd6", "#faf8f3", "#ff4fa3", "#ffe14d"],
		xterm: { background: "#161616", foreground: "#f3f0e8", cursor: "#ff4fa3", selectionBackground: "#0a6fd666" },
		graph: { prompt: "#ffd5e9", assistant: "#e8e2d6", tool: "#d2e4fa", result: "#dde7f3", subagent: "#d7e6f8", objective: "#e4daf2" },
	},
	phosphor: {
		id: "phosphor",
		label: "Phosphor",
		description: "Dark and terminal-native; green while working, amber when it needs you.",
		scheme: "dark",
		swatches: ["#070b09", "#0d1411", "#7cf29a", "#ffb000"],
		xterm: { background: "#040705", foreground: "#9ff0b4", cursor: "#7cf29a", selectionBackground: "#7cf29a40" },
		graph: { prompt: "#2c4a36", assistant: "#1f3328", tool: "#1d3b35", result: "#24382c", subagent: "#1d3b35", objective: "#4a3a14" },
	},
	dune: {
		id: "dune",
		label: "Dune",
		description: "Warm sand panes in dark slate chrome, with gradient title bars.",
		scheme: "light",
		swatches: ["#22262c", "#e9e1cb", "#2e8b7f", "#e8903a"],
		xterm: { background: "#15171b", foreground: "#e3e0d4", cursor: "#f2c84b", selectionBackground: "#f2c84b55" },
		graph: { prompt: "#f6dc7c", assistant: "#d9cfb3", tool: "#a8d3c4", result: "#cadccd", subagent: "#bfdcd2", objective: "#f1d58a" },
	},
	dusk: {
		id: "dusk",
		label: "Dusk",
		description: "Dune after sundown: warm greys, gradient title bars, teal accents.",
		scheme: "dark",
		swatches: ["#1a1d22", "#2b3038", "#4fb9a8", "#f0c14b"],
		xterm: { background: "#0f1114", foreground: "#e3e0d4", cursor: "#f0c14b", selectionBackground: "#4fb9a855" },
		graph: { prompt: "#5c4d1e", assistant: "#3a4049", tool: "#23504a", result: "#2c4434", subagent: "#24453d", objective: "#5a4a1c" },
	},
};

export const THEME_ORDER: ThemeId[] = ["graphite", "riso", "phosphor", "dune", "dusk"];
export const DEFAULT_THEME: ThemeId = "graphite";

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && Object.hasOwn(THEMES, value);
}

/** A theme's four signature colours as a small strip. */
export function ThemeSwatch({ theme, height = 10 }: { theme: ThemeMeta; height?: number }) {
	return (
		<span className="inline-flex shrink-0 overflow-hidden" style={{ border: "1px solid var(--border-strong)", borderRadius: "var(--radius)" }} aria-hidden>
			{theme.swatches.map(color => (
				<span key={color} style={{ width: height * 1.4, height, background: color }} />
			))}
		</span>
	);
}
