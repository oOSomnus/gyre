import { describe, expect, test } from "bun:test";
import { roleSelector, selectorEffort, typedRoleSelector } from "../src/lib/role-selector";

describe("role selectors bind a model and an effort", () => {
	test("roleSelector formats like omp's TUI", () => {
		expect(roleSelector("p/m", "high")).toBe("p/m:high");
		expect(roleSelector("p/m", "off")).toBe("p/m:off");
		expect(roleSelector("p/m", "auto")).toBe("p/m:auto");
		expect(roleSelector("p/m", "inherit")).toBe("p/m");
		expect(roleSelector("p/m", undefined)).toBe("p/m");
		expect(roleSelector("p/m", "")).toBe("p/m");
	});
	test("selectorEffort reads a single selector's effort", () => {
		expect(selectorEffort("p/m:xhigh")).toBe("xhigh");
		expect(selectorEffort("p/m")).toBe("");
		expect(selectorEffort("p/m:inherit")).toBe("");
		expect(selectorEffort("a/b:low, c/d:high")).toBe("");
		expect(selectorEffort("ollama/llama3:8b")).toBe("");
		expect(selectorEffort(undefined)).toBe("");
		expect(selectorEffort("p/m:High")).toBe("high");
		expect(selectorEffort("p/m: high ")).toBe("high");
	});
	test("a typed selector keeps its own effort, inherit or fallback list; otherwise takes the chosen effort", () => {
		expect(typedRoleSelector("p/m", "high")).toBe("p/m:high");
		expect(typedRoleSelector("p/m", "")).toBe("p/m");
		expect(typedRoleSelector("p/m:low", "high")).toBe("p/m:low");
		expect(typedRoleSelector("p/m:High", "low")).toBe("p/m:High");
		expect(typedRoleSelector("p/m:inherit", "high")).toBe("p/m");
		expect(typedRoleSelector("p/m:Inherit", "high")).toBe("p/m");
		expect(typedRoleSelector("a/b:low, c/d", "high")).toBe("a/b:low, c/d");
		expect(typedRoleSelector("ollama/llama3:8b", "high")).toBe("ollama/llama3:8b:high");
	});
});
