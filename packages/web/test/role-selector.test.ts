import { describe, expect, test } from "bun:test";
import { roleSelector, selectorEffort } from "../src/lib/role-selector";

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
	});
});
