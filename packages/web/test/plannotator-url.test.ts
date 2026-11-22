import { describe, expect, test } from "bun:test";
import { sameSiteReviewUrl } from "../src/lib/plannotatorUrl";

describe("sameSiteReviewUrl", () => {
	test("moves a localhost review onto the page's 127.x host", () => {
		expect(sameSiteReviewUrl("http://localhost:45076/", "127.0.0.1")).toBe("http://127.0.0.1:45076/");
		expect(sameSiteReviewUrl("http://localhost:45076", "127.0.0.2")).toBe("http://127.0.0.2:45076/");
		expect(sameSiteReviewUrl("http://localhost:43982/review?id=rv1#top", "127.0.0.1")).toBe("http://127.0.0.1:43982/review?id=rv1#top");
		expect(sameSiteReviewUrl("http://127.0.0.1:43982/", "localhost")).toBe("http://localhost:43982/");
	});

	test("leaves other cases unchanged", () => {
		expect(sameSiteReviewUrl("http://localhost:45076/", "localhost")).toBe("http://localhost:45076/");
		expect(sameSiteReviewUrl("http://localhost:45076/", "my-laptop.tailnet.ts.net")).toBe("http://localhost:45076/");
		expect(sameSiteReviewUrl("http://localhost:45076/", "[::1]")).toBe("http://localhost:45076/");
		expect(sameSiteReviewUrl("http://example.com:1/", "127.0.0.1")).toBe("http://example.com:1/");
		expect(sameSiteReviewUrl("not a url", "127.0.0.1")).toBe("not a url");
	});
});
