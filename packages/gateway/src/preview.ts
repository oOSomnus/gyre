/**
 * Preview proxies for the browser pane. A dev server on the gateway machine
 * (http://localhost:3000) is unreachable from a remote browser, so the pane asks the
 * gateway to proxy it. Each target port gets its own listener on its own port, so the
 * proxied app runs on an origin separate from the gateway's and its scripts cannot read
 * the gateway's token or call its API with the user's session (cookies are shared across
 * ports, so the gateway also refuses cross-origin cookie-authenticated writes, and the
 * proxy strips the gateway cookie before forwarding).
 *
 * Access: the URL the gateway hands out carries a one-time token, exchanged on first use
 * for an HttpOnly cookie scoped to that proxy. HTTP is streamed; WebSockets (dev-server
 * hot reload) are bridged. A proxy closes when no pane holds it any more.
 */
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";

const TOKEN_TTL_MS = 60_000;
const PARAM = "gyre_preview";
/** Headers that describe one hop, never forwarded. */
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"];

interface BridgeData {
	target: string;
	protocols: string[];
	upstream?: WebSocket;
	pending: Array<string | Uint8Array>;
}

interface Proxy {
	server: Server<BridgeData>;
	/** Loopback address the dev server answered on (IPv4 or IPv6 localhost). */
	upstreamHost: string;
	targetPort: number;
	cookieName: string;
	secret: string;
	tokens: Map<string, number>;
	holders: Set<string>;
}

export interface PreviewOptions {
	/** Interface the proxies listen on (the gateway's). */
	hostname: string;
	/** The gateway's Host-header check, applied to proxy requests too. */
	isAllowedHost(host: string): boolean;
}

export class PreviewError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

/** The loopback port a preview URL targets, or an error for anything else. */
export function previewTarget(raw: unknown): { port: number; path: string } {
	let url: URL;
	try {
		url = new URL(String(raw));
	} catch {
		throw new PreviewError("not a URL");
	}
	if (url.protocol !== "http:") throw new PreviewError("only http:// dev servers on this machine can be proxied");
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new PreviewError("only localhost addresses can be proxied");
	const port = Number(url.port || 80);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PreviewError("invalid port");
	return { port, path: `${url.pathname}${url.search}${url.hash}` };
}

const cookieValue = (req: Request, name: string) =>
	(req.headers.get("cookie") ?? "")
		.split(/;\s*/)
		.map(part => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)])
		.find(([key]) => key === name)?.[1];

/** Request headers for the upstream: no hop headers, no Gyre cookies. */
function upstreamHeaders(req: Request, targetPort: number): Headers {
	const headers = new Headers(req.headers);
	for (const name of HOP_HEADERS) headers.delete(name);
	const cookies = (req.headers.get("cookie") ?? "")
		.split(/;\s*/)
		.filter(part => part && !part.startsWith("gyre_token=") && !part.startsWith("gyre_preview_"));
	if (cookies.length) headers.set("cookie", cookies.join("; "));
	else headers.delete("cookie");
	headers.set("host", `localhost:${targetPort}`);
	// Dev servers that check Origin (Vite's HMR, for one) expect their own.
	if (headers.has("origin")) headers.set("origin", `http://localhost:${targetPort}`);
	return headers;
}

/**
 * A redirect to the dev server's own address (a loopback host and exactly its port) as a
 * path on the proxy. Anything else, other ports included, is left as it is.
 */
export function rewriteLocation(location: string, targetPort: number): string {
	if (!/^https?:\/\//i.test(location)) return location;
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return location;
	}
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	if (url.protocol !== "http:" || port !== targetPort || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return location;
	return `${url.pathname}${url.search}${url.hash}` || "/";
}

export class PreviewProxies {
	readonly #proxies = new Map<number, Proxy>();

	constructor(private readonly options: PreviewOptions) {}

	/**
	 * Start (or reuse) the proxy for `targetPort`, held by `holder` (a pane id). Returns
	 * the proxy's port and a one-time token for the first request.
	 */
	open(targetPort: number, holder: string): { port: number; token: string } {
		let proxy = this.#proxies.get(targetPort);
		if (!proxy) {
			proxy = this.#start(targetPort);
			this.#proxies.set(targetPort, proxy);
		}
		proxy.holders.add(holder);
		const token = randomBytes(18).toString("base64url");
		const now = Date.now();
		for (const [t, expires] of proxy.tokens) if (expires < now) proxy.tokens.delete(t);
		proxy.tokens.set(token, now + TOKEN_TTL_MS);
		return { port: proxy.server.port!, token };
	}

	/** Release `holder`'s hold on every proxy (or one target); a proxy nobody holds stops. */
	release(holder: string, targetPort?: number): void {
		for (const [port, proxy] of this.#proxies) {
			if (targetPort !== undefined && port !== targetPort) continue;
			proxy.holders.delete(holder);
			if (proxy.holders.size === 0) {
				proxy.server.stop(true);
				this.#proxies.delete(port);
			}
		}
	}

	list(): Array<{ targetPort: number; port: number; holders: number }> {
		return [...this.#proxies.values()].map(p => ({ targetPort: p.targetPort, port: p.server.port!, holders: p.holders.size }));
	}

	stop(): void {
		for (const proxy of this.#proxies.values()) proxy.server.stop(true);
		this.#proxies.clear();
	}

	#start(targetPort: number): Proxy {
		const options = this.options;
		const proxy: Proxy = {
			targetPort,
			cookieName: "",
			secret: randomBytes(24).toString("base64url"),
			tokens: new Map(),
			holders: new Set(),
			upstreamHost: "127.0.0.1",
			server: undefined as unknown as Server<BridgeData>,
		};
		proxy.server = Bun.serve<BridgeData, never>({
			hostname: options.hostname,
			port: 0,
			idleTimeout: 0,
			async fetch(req, server) {
				const url = new URL(req.url);
				const hostName = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
				if (!options.isAllowedHost(hostName)) return new Response("forbidden host", { status: 403 });
				const token = url.searchParams.get(PARAM);
				if (token) {
					const expires = proxy.tokens.get(token);
					proxy.tokens.delete(token);
					if (!expires || expires < Date.now()) return new Response("This preview link has expired. Reload the browser pane.", { status: 401 });
					url.searchParams.delete(PARAM);
					return new Response(null, {
						status: 302,
						headers: {
							location: `${url.pathname}${url.search}`,
							"set-cookie": `${proxy.cookieName}=${proxy.secret}; HttpOnly; SameSite=Lax; Path=/`,
							"cache-control": "no-store",
						},
					});
				}
				if (cookieValue(req, proxy.cookieName) !== proxy.secret) return new Response("Open this preview from Gyre's browser pane.", { status: 401 });
				const path = `${url.pathname}${url.search}`;
				if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
					const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
						.split(",")
						.map(p => p.trim())
						.filter(Boolean);
					const ok = server.upgrade(req, {
						data: { target: `ws://${proxy.upstreamHost}:${targetPort}${path}`, protocols, pending: [] },
						headers: protocols[0] ? { "sec-websocket-protocol": protocols[0] } : undefined,
					});
					return ok ? undefined : new Response("upgrade failed", { status: 400 });
				}
				let upstream: Response | undefined;
				// "localhost" may be served on IPv4 or IPv6 only; try the last one that answered
				// first. Only a refused connection moves on to the other address: a later failure
				// may come after the server received the request, and replaying it could repeat
				// a mutation.
				const hosts = [proxy.upstreamHost, proxy.upstreamHost === "127.0.0.1" ? "[::1]" : "127.0.0.1"];
				const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
				let failure = `Nothing is answering on localhost:${targetPort}.`;
				for (const host of hosts) {
					try {
						upstream = await fetch(`http://${host}:${targetPort}${path}`, {
							method: req.method,
							headers: upstreamHeaders(req, targetPort),
							body,
							redirect: "manual",
							decompress: false,
						} as RequestInit);
						proxy.upstreamHost = host;
						break;
					} catch (error) {
						if ((error as { code?: string }).code === "ECONNREFUSED") continue;
						failure = `localhost:${targetPort} failed to answer: ${(error as Error).message}`;
						break;
					}
				}
				if (!upstream) return new Response(failure, { status: 502, headers: { "content-type": "text/plain" } });
				const headers = new Headers(upstream.headers);
				for (const name of ["connection", "keep-alive", "transfer-encoding"]) headers.delete(name);
				// Redirects to the dev server's own address stay inside the proxy.
				const location = headers.get("location");
				if (location) headers.set("location", rewriteLocation(location, targetPort));
				return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
			},
			websocket: {
				open(ws: ServerWebSocket<BridgeData>) {
					const upstream = new WebSocket(ws.data.target, ws.data.protocols);
					upstream.binaryType = "arraybuffer";
					ws.data.upstream = upstream;
					upstream.onopen = () => {
						for (const message of ws.data.pending.splice(0)) upstream.send(message);
					};
					upstream.onmessage = event => ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
					upstream.onclose = event => ws.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
					upstream.onerror = () => ws.close(1011, "upstream error");
				},
				message(ws: ServerWebSocket<BridgeData>, message) {
					const upstream = ws.data.upstream;
					const data = typeof message === "string" ? message : new Uint8Array(message);
					if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
					else ws.data.pending.push(data);
				},
				close(ws: ServerWebSocket<BridgeData>) {
					ws.data.upstream?.close();
				},
			},
		});
		proxy.cookieName = `gyre_preview_${proxy.server.port}`;
		return proxy;
	}
}
