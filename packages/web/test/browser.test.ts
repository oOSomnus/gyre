/** Browser pane URL handling and opening links in it. */
import { expect, test } from "bun:test";

const g = globalThis as Record<string, unknown>;
const memoryStorage = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
g.location ??= new URL("http://localhost/");
g.history ??= { replaceState() {} };
g.localStorage ??= memoryStorage();
g.sessionStorage ??= memoryStorage();
g.window ??= globalThis;
g.fetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });

const { isLoopbackUrl, needsProxy, normalizeUrl, withoutPreviewToken } = await import("../src/lib/browser");
const { openBrowserPane, useApp } = await import("../src/store/app");

test("typed addresses get a scheme: http for localhost, https otherwise", () => {
	expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173/");
	expect(normalizeUrl("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
	expect(normalizeUrl("example.com")).toBe("https://example.com/");
	expect(normalizeUrl("http://localhost:8080/x?y=1")).toBe("http://localhost:8080/x?y=1");
	expect(normalizeUrl("javascript:alert(1)")).toBeNull();
	expect(normalizeUrl("file:///etc/passwd")).toBeNull();
	expect(normalizeUrl("  ")).toBeNull();
});

test("loopback pages need the preview proxy only when the UI is remote", () => {
	expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
	expect(isLoopbackUrl("https://example.com/")).toBe(false);
	expect(needsProxy("http://localhost:3000/", "127.0.0.1")).toBe(false);
	expect(needsProxy("http://localhost:3000/", "tauri.localhost")).toBe(false);
	expect(needsProxy("http://localhost:3000/", "laptop.tailnet.ts.net")).toBe(true);
	expect(needsProxy("https://example.com/", "laptop.tailnet.ts.net")).toBe(false);
});

test("opening a link reuses the workspace's browser pane", () => {
	useApp.setState({ workspaces: [{ id: "w", name: "W", panes: {}, layout: null, updatedAt: 0 }], activeWorkspaceId: "w" });
	const first = openBrowserPane("http://localhost:3000/");
	const second = openBrowserPane("http://localhost:3000/about");
	expect(second).toBe(first);
	const panes = Object.values(useApp.getState().activeWorkspace()!.panes);
	expect(panes.filter(p => p.kind === "browser")).toHaveLength(1);
	expect(panes[0]!.url).toBe("http://localhost:3000/about");
});

test("a new tab gets the preview address without the spent token", () => {
	expect(withoutPreviewToken("http://host:4000/app?x=1&gyre_preview=tok#/a?b")).toBe("http://host:4000/app?x=1#/a?b");
	expect(withoutPreviewToken("http://localhost:5173/")).toBe("http://localhost:5173/");
});
