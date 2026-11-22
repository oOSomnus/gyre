/**
 * Gyre's themes. Colours for the DOM live in styles.css as per-theme tokens;
 * this registry holds what non-CSS consumers need (xterm, the graph minimap,
 * shiki/mermaid/Monaco light-or-dark choice) and what the pickers show.
 */
export type ThemeId = "graphite" | "carbon" | "riso" | "blacklight" | "greenbar" | "phosphor" | "dune" | "dusk";
export type ThemeFamilyId = "graphite" | "riso" | "phosphor" | "dune";

export interface ThemeMeta {
	id: ThemeId;
	label: string;
	/** The light/dark pair this theme belongs to. */
	family: ThemeFamilyId;
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
		family: "graphite",
		description: "Ink-blue chrome around cool porcelain panes; cyan while working, orange when it needs you.",
		scheme: "light",
		swatches: ["#0f1420", "#e3e8ee", "#22b8c8", "#ff7a2f"],
		xterm: { background: "#0d121c", foreground: "#cfe1f0", cursor: "#2ad0e0", selectionBackground: "#2ad0e055" },
		graph: { prompt: "#dce6f4", assistant: "#c9d2dd", tool: "#b9e3e6", result: "#cfe0d8", subagent: "#bfe2e0", objective: "#e5e2f7" },
	},
	carbon: {
		id: "carbon",
		label: "Carbon",
		family: "graphite",
		description: "Graphite after hours: ink-blue chrome around slate panes; cyan while working, orange when it needs you.",
		scheme: "dark",
		swatches: ["#0a0e17", "#1a2130", "#2ad0e0", "#ff7a2f"],
		xterm: { background: "#0a0e17", foreground: "#cfe1f0", cursor: "#2ad0e0", selectionBackground: "#2ad0e055" },
		graph: { prompt: "#1f2d45", assistant: "#283246", tool: "#163a40", result: "#1d3330", subagent: "#173a3a", objective: "#2a2850" },
	},
	riso: {
		id: "riso",
		label: "Riso",
		family: "riso",
		description: "Pink and blue spot inks on off-white paper, a strong halftone and square corners.",
		scheme: "light",
		swatches: ["#0a6fd6", "#faf8f3", "#ff4fa3", "#ffe14d"],
		xterm: { background: "#161616", foreground: "#f3f0e8", cursor: "#ff4fa3", selectionBackground: "#0a6fd666" },
		graph: { prompt: "#ffd5e9", assistant: "#e8e2d6", tool: "#d2e4fa", result: "#dde7f3", subagent: "#d7e6f8", objective: "#e4daf2" },
	},
	blacklight: {
		id: "blacklight",
		label: "Blacklight",
		family: "riso",
		description: "Riso on black paper: fluorescent pink and blue inks, light outlines and square corners.",
		scheme: "dark",
		swatches: ["#0c3d78", "#1c1b19", "#ff4fa3", "#ffe14d"],
		xterm: { background: "#0e0e0e", foreground: "#f3eee3", cursor: "#ff4fa3", selectionBackground: "#3f9bff55" },
		graph: { prompt: "#4a1d34", assistant: "#2e2b27", tool: "#17304f", result: "#1f2c3a", subagent: "#172c45", objective: "#33264a" },
	},
	greenbar: {
		id: "greenbar",
		label: "Greenbar",
		family: "phosphor",
		description: "Phosphor on printer paper: pale green panes in green-black chrome; green while working, amber when it needs you.",
		scheme: "light",
		swatches: ["#0c1a12", "#e6f0e4", "#1f8f4e", "#ffb000"],
		xterm: { background: "#06100a", foreground: "#9ff0b4", cursor: "#7cf29a", selectionBackground: "#7cf29a40" },
		graph: { prompt: "#f4e6c2", assistant: "#d4e3d3", tool: "#d3ebe6", result: "#d8eadb", subagent: "#d1e9e4", objective: "#f4e6c2" },
	},
	phosphor: {
		id: "phosphor",
		label: "Phosphor",
		family: "phosphor",
		description: "Dark and terminal-native; green while working, amber when it needs you.",
		scheme: "dark",
		swatches: ["#070b09", "#0d1411", "#7cf29a", "#ffb000"],
		xterm: { background: "#040705", foreground: "#9ff0b4", cursor: "#7cf29a", selectionBackground: "#7cf29a40" },
		graph: { prompt: "#2c4a36", assistant: "#1f3328", tool: "#1d3b35", result: "#24382c", subagent: "#1d3b35", objective: "#4a3a14" },
	},
	dune: {
		id: "dune",
		label: "Dune",
		family: "dune",
		description: "Warm sand panes in dark slate chrome, with gradient title bars.",
		scheme: "light",
		swatches: ["#22262c", "#e9e1cb", "#2e8b7f", "#e8903a"],
		xterm: { background: "#15171b", foreground: "#e3e0d4", cursor: "#f2c84b", selectionBackground: "#f2c84b55" },
		graph: { prompt: "#f6dc7c", assistant: "#d9cfb3", tool: "#a8d3c4", result: "#cadccd", subagent: "#bfdcd2", objective: "#f1d58a" },
	},
	dusk: {
		id: "dusk",
		label: "Dusk",
		family: "dune",
		description: "Dune after sundown: warm greys, gradient title bars, teal accents.",
		scheme: "dark",
		swatches: ["#1a1d22", "#2b3038", "#4fb9a8", "#f0c14b"],
		xterm: { background: "#0f1114", foreground: "#e3e0d4", cursor: "#f0c14b", selectionBackground: "#4fb9a855" },
		graph: { prompt: "#5c4d1e", assistant: "#3a4049", tool: "#23504a", result: "#2c4434", subagent: "#24453d", objective: "#5a4a1c" },
	},
};

export interface ThemeFamily {
	id: ThemeFamilyId;
	label: string;
	light: ThemeId;
	dark: ThemeId;
}

/** Every theme comes in a light/dark pair; the pickers line them up by family. */
export const THEME_FAMILIES: readonly ThemeFamily[] = [
	{ id: "graphite", label: "Graphite", light: "graphite", dark: "carbon" },
	{ id: "riso", label: "Riso", light: "riso", dark: "blacklight" },
	{ id: "phosphor", label: "Phosphor", light: "greenbar", dark: "phosphor" },
	{ id: "dune", label: "Dune", light: "dune", dark: "dusk" },
];

export const THEME_ORDER: ThemeId[] = THEME_FAMILIES.flatMap(f => [f.light, f.dark]);
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
