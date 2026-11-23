import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { gateway, token } from "./lib/gateway";
import { wireOmpStatus } from "./lib/ompStatus";
import { readTheme, useApp } from "./store/app";
import { chatLifecycle } from "./store/chat-lifecycle";
import { useChats, wireChatStore } from "./store/chats";
import "./styles.css";

// Report UI errors to the gateway log (desktop webviews have no devtools).
function report(level: string, message: string) {
	void fetch("/api/client-log", {
		method: "POST",
		headers: { "content-type": "application/json", "x-gyre-token": token },
		body: JSON.stringify({ level, message }),
	}).catch(() => undefined);
}
window.addEventListener("error", e => report("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => report("rejection", String((e.reason as Error)?.stack ?? e.reason)));

// Apply the saved theme before the first render so there is no flash of the default.
document.documentElement.dataset.theme = readTheme();
wireChatStore({ accepts: chatLifecycle.accepts });
wireOmpStatus();
// Store handles for tests and debugging from the devtools console.
(window as unknown as { __gyre: unknown }).__gyre = { useApp, useChats };
gateway.connect();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
