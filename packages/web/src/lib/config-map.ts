import { createConfigMap } from "./config-map-store";
import { api } from "./gateway";

export const configMap = (key: string) =>
	createConfigMap({
		async read() {
			const { value } = await api<{ value: Record<string, string> | null }>(`/api/omp/config?key=${key}`);
			return value ?? {};
		},
		async assign(name, value) {
			const result = await api<{ value: Record<string, string> }>("/api/omp/config", { method: "PATCH", body: JSON.stringify({ key, name, value }) });
			return result.value;
		},
		async write(value) {
			await api("/api/omp/config", { method: "PUT", body: JSON.stringify({ key, value }) });
		},
	});
export const useRoutingStore = configMap("task.agentModelOverrides");
