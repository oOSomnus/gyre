/**
 * Plannotator stores every UI setting (plan look, full/lite, …) in
 * `SameSite=Lax` cookies and advertises `http://localhost:<port>`. Gyre is
 * normally served from `127.0.0.1`, which is a different site, so inside
 * Gyre's iframe those cookies are dropped and Plannotator's first-run dialog
 * returns on every review. Pointing the iframe at the page's own loopback host
 * makes the cookies first-party; cookies ignore ports, so every review shares them.
 */

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

function isLoopback(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host.endsWith(".localhost") || IPV4_LOOPBACK.test(host) || host === "[::1]" || host === "::1";
}

/** The review URL rewritten onto the Gyre page's loopback host when both are local. */
export function sameSiteReviewUrl(reviewUrl: string, pageHostname: string): string {
	let url: URL;
	try {
		url = new URL(reviewUrl);
	} catch {
		return reviewUrl;
	}
	const page = pageHostname.toLowerCase();
	// Plannotator binds IPv4 loopback only, so only rewrite onto localhost or 127.x.
	if (page !== "localhost" && !IPV4_LOOPBACK.test(page)) return reviewUrl;
	if (!isLoopback(url.hostname) || url.hostname.toLowerCase() === page) return reviewUrl;
	url.hostname = page;
	return url.toString();
}
