import { describe, expect, test } from "bun:test";
import type { ModelPickerRow } from "../src/lib/omp";
import { selectorModel } from "../src/lib/role-selector";
import { filterRoleRows, parseModel, roleViewRows } from "../src/lib/role-view";
import type { RoleInfo } from "../src/lib/roles";

const role = (id: string, section: RoleInfo["section"] = "chat"): RoleInfo => ({ id, name: id.toUpperCase(), section, builtin: true });
const ROLES = [role("default"), role("slow"), role("plan"), role("commit"), role("image", "kind")];

describe("role view", () => {
	test("selectorModel strips the effort and refuses lists and role references", () => {
		expect(selectorModel("p/m:high")).toBe("p/m");
		expect(selectorModel("p/m:inherit")).toBe("p/m");
		expect(selectorModel("ollama/llama3:8b")).toBe("ollama/llama3:8b");
		expect(selectorModel("a/b, c/d")).toBe("");
		expect(selectorModel("@slow")).toBe("");
		expect(selectorModel(undefined)).toBe("");
	});
	test("parseModel keeps slashes in model ids", () => {
		expect(parseModel("openrouter/meta/llama")).toEqual({ provider: "openrouter", id: "meta/llama" });
		expect(parseModel("bare")).toBeUndefined();
	});
	test("each role shows the model omp resolves, its effort, and whether omp picked it", () => {
		const picker: ModelPickerRow[] = [
			{ provider: "a", id: "big", name: "Big", thinking: ["low", "high"], roles: [{ role: "default" }, { role: "plan", auto: true }] },
			{ provider: "b", id: "fast", name: "Fast", roles: [{ role: "slow" }] },
			// Quick-role rows (`@` search) are ignored.
			{ provider: "z", id: "zz", role: "commit" },
		];
		const rows = roleViewRows(ROLES, { default: "a/big:high", slow: "b/fast", commit: "c/x:low" }, picker, { provider: "a", id: "big" });
		const by = Object.fromEntries(rows.map(r => [r.role.id, r]));
		expect(by.default).toMatchObject({ model: { provider: "a", id: "big", name: "Big" }, effort: "high", auto: false, current: true, thinking: ["low", "high"] });
		expect(by.plan).toMatchObject({ model: { id: "big" }, auto: true, effort: "", current: true });
		expect(by.slow).toMatchObject({ model: { id: "fast" }, auto: false, current: false });
		// Not held by any listed model: the configured selector still names it.
		expect(by.commit).toMatchObject({ model: { provider: "c", id: "x" }, effort: "low", auto: false });
		expect(by.image).toMatchObject({ model: undefined, auto: true, effort: "" });
	});
	test("filtering matches roles and models", () => {
		const rows = roleViewRows(ROLES, { slow: "b/fast" }, []);
		expect(filterRoleRows(rows, "").map(r => r.role.id)).toHaveLength(5);
		expect(filterRoleRows(rows, "@sl").map(r => r.role.id)).toEqual(["slow"]);
		expect(filterRoleRows(rows, "fast").map(r => r.role.id)).toEqual(["slow"]);
		expect(filterRoleRows(rows, "image").map(r => r.role.id)).toEqual(["image"]);
	});
});
