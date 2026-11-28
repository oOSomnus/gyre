/** URL handling for the browser pane. */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const UI_LOOPBACK = new Set([...LOOPBACK, "tauri.localhost"]);

/** What the user typed, as a URL: `localhost:5173` and `example.com` get a scheme. */
export function normalizeUrl(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${/^(localhost|127\.|\[::1\])/i.test(text) ? "http" : "https"}://${text}`;
	try {
		const url = new URL(withScheme);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

export function isLoopbackUrl(url: string): boolean {
	try {
		return LOOPBACK.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * A loopback URL means the gateway machine. A browser on that machine can load it
 * directly; a remote one needs the gateway's preview proxy.
 */
export function needsProxy(url: string, uiHostname: string): boolean {
	return isLoopbackUrl(url) && new URL(url).protocol === "http:" && !UI_LOOPBACK.has(uiHostname);
}

/**
 * A preview address without its one-time token, which the iframe has already spent (a
 * reused token is refused). The proxy's cookie, set by that first load, lets a new tab in.
 * Direct addresses have no token and come back unchanged.
 */
export function withoutPreviewToken(src: string): string {
	try {
		const url = new URL(src);
		if (!url.searchParams.has("gyre_preview")) return src;
		url.searchParams.delete("gyre_preview");
		return url.toString();
	} catch {
		return src;
	}
}
