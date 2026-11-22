import { describe, expect, test } from "bun:test";
import { baseName, crumbs, parentDir } from "../src/lib/paths";

describe("folder browser breadcrumbs", () => {
	test("root and nested paths", () => {
		expect(crumbs("/")).toEqual([{ label: "/", path: "/" }]);
		expect(crumbs("/home/me/src")).toEqual([
			{ label: "/", path: "/" },
			{ label: "home", path: "/home" },
			{ label: "me", path: "/home/me" },
			{ label: "src", path: "/home/me/src" },
		]);
	});
	test("base name and parent", () => {
		expect(baseName("/home/me/src/")).toBe("src");
		expect(parentDir("/home/me/src")).toBe("/home/me");
		expect(parentDir("/src")).toBe("/");
	});
});
