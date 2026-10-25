import { describe, expect, it } from "vitest";
import { findLocalPaths, isLocalPathCandidate } from "./local-path";

const paths = (text: string) => findLocalPaths(text).map((m) => m.path);

describe("findLocalPaths", () => {
	it("finds absolute and home paths in prose", () => {
		expect(paths("See /Users/me/proj/file.ts and ~/Downloads/a.png now")).toEqual(["/Users/me/proj/file.ts", "~/Downloads/a.png"]);
	});
	it("trims trailing punctuation and line suffixes", () => {
		expect(paths("Edit (/tmp/a/b.go:12:3), then /var/log/x.log.")).toEqual(["/tmp/a/b.go", "/var/log/x.log"]);
	});
	it("reports offsets", () => {
		const [match] = findLocalPaths("at /a/b.");
		expect(match).toEqual({ start: 3, end: 7, path: "/a/b" });
	});
	it("ignores URLs, ratios, dates and words", () => {
		expect(paths("https://example.com/a/b and http://x/y/z")).toEqual([]);
		expect(paths("and/or, 1/2, 3/4/5, w/o")).toEqual([]);
		expect(paths("on 2024/10/25 or /2024/10/25")).toEqual([]);
		expect(paths("//cdn.example.com/a/b file:///a/b ao://sessions/p/s")).toEqual([]);
		expect(paths("a/b/c src/main.ts ./x/y ../x/y")).toEqual([]);
		expect(paths("use /tmp alone or ~ alone or ~user/x/y")).toEqual([]);
	});
});

describe("isLocalPathCandidate", () => {
	it("accepts whole-string paths", () => {
		expect(isLocalPathCandidate("/Users/me/a b/c.txt")).toBe(true);
		expect(isLocalPathCandidate("~/x")).toBe(true);
	});
	it("rejects non-paths", () => {
		for (const v of ["", "~/", "/tmp", "//host/a/b", "file:///a/b", "C:/a/b", " /a/b", "/a/b\n", "src/a/b", "/1/2/3"]) {
			expect(isLocalPathCandidate(v), v).toBe(false);
		}
	});
});
