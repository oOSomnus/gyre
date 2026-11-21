import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.GYRE_GATEWAY ?? "http://127.0.0.1:7341";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": gateway,
			"/ws": { target: gateway.replace(/^http/, "ws"), ws: true },
		},
	},
	build: { target: "es2022", chunkSizeWarningLimit: 4000 },
	worker: { format: "es" },
});
