import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiClient,
	apiErrorDetails,
	apiErrorMessage,
	getApiBaseUrl,
	hasTrustedApiBaseUrl,
	normalizeApiOperation,
	setApiDaemonStatus,
	setApiBaseUrl,
	subscribeApiBaseUrl,
} from "./api-client";

describe("apiClient runtime base URL", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setApiBaseUrl("http://127.0.0.1:3001");
		setApiDaemonStatus({ state: "stopped" });
	});

	it("rewrites requests to the current runtime daemon port", async () => {
		const seenUrls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seenUrls.push(input instanceof Request ? input.url : input.toString());
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("http://127.0.0.1:3037/");

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(getApiBaseUrl()).toBe("http://127.0.0.1:3037");
		expect(seenUrls).toEqual(["http://127.0.0.1:3037/api/v1/projects"]);
	});

	it("rebases POSTs without Request-as-init, preserving method, body, and headers", async () => {
		// Regression: `new Request(target, input)` needs the source request's
		// `duplex` getter, which Electron's Chromium lacks — every request with a
		// body threw. The rewrite must copy fields explicitly instead.
		const seen: { url: string; method?: string; body?: string; contentType?: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: input instanceof Request ? input.url : input.toString(),
				method: init?.method,
				body: init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : undefined,
				contentType: headers.get("content-type"),
			});
			return new Response(JSON.stringify({ session: { id: "s1" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("http://127.0.0.1:3037");

		// A request built against an older address (the daemon moved while it was
		// being built) still takes the rebase path.
		const { error } = await apiClient.POST("/api/v1/sessions", {
			baseUrl: "http://127.0.0.1:3001",
			body: { projectId: "p1", prompt: "hello" },
		});

		expect(error).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe("http://127.0.0.1:3037/api/v1/sessions");
		expect(seen[0].method).toBe("POST");
		expect(seen[0].contentType).toBe("application/json");
		expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ projectId: "p1", prompt: "hello" });
	});

	// Rebasing buffers the body asynchronously; building against the current
	// address sends the request in the same task that issued it.
	it("builds requests against the runtime daemon address and passes them straight to fetch", async () => {
		const seen: Request[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seen.push(input as Request);
			return new Response(JSON.stringify({ session: { id: "s1" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		});
		setApiBaseUrl("http://127.0.0.1:3037");

		const pending = apiClient.POST("/api/v1/sessions", { body: { projectId: "p1", prompt: "hello" } });
		expect(seen).toHaveLength(1);
		const { error } = await pending;

		expect(error).toBeUndefined();
		expect(seen[0]).toBeInstanceOf(Request);
		expect(seen[0].url).toBe("http://127.0.0.1:3037/api/v1/sessions");
		expect(seen[0].method).toBe("POST");
		expect(await seen[0].json()).toEqual({ projectId: "p1", prompt: "hello" });

		const viaRequest = apiClient.request("post", "/api/v1/sessions", { body: { projectId: "p1", prompt: "again" } });
		expect(seen).toHaveLength(2);
		await viaRequest;
		expect(seen[1].url).toBe("http://127.0.0.1:3037/api/v1/sessions");
	});

	it("skips the rebase when the request already targets the runtime base URL", async () => {
		const seen: (RequestInfo | URL)[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seen.push(input);
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		// Match the base openapi-fetch built the request against (the dev origin
		// in jsdom), so the rewrite has nothing to do.
		setApiBaseUrl(window.location.origin);
		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(seen).toHaveLength(1);
		// Untouched pass-through: fetch receives the original Request object.
		expect(seen[0]).toBeInstanceOf(Request);
	});

	it("passes the request through untouched when the base URL is empty", async () => {
		const seen: Request[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seen.push(input as Request);
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("");

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(getApiBaseUrl()).toBe("");
		// Empty base → no rewrite; openapi-fetch's own request reaches fetch as-is.
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toContain("/api/v1/projects");
	});

	it("returns unavailable without fetching when the daemon base URL is untrusted", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		setApiBaseUrl(null);

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({ message: "AO daemon is not ready." });
		expect(getApiBaseUrl()).toBe("");
		expect(hasTrustedApiBaseUrl()).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the current daemon startup failure when the base URL is untrusted", async () => {
		setApiBaseUrl(null);
		setApiDaemonStatus({
			state: "error",
			code: "exited",
			message: "AO daemon exited with code 1",
		});

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({ code: "exited", message: "AO daemon exited with code 1" });
	});
});

describe("subscribeApiBaseUrl", () => {
	afterEach(() => {
		setApiBaseUrl("http://127.0.0.1:3001");
	});

	it("notifies subscribers when the base URL actually changes", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeApiBaseUrl(listener);
		try {
			setApiBaseUrl("http://127.0.0.1:4555");
			expect(listener).toHaveBeenCalledTimes(1);
			expect(getApiBaseUrl()).toBe("http://127.0.0.1:4555");
		} finally {
			unsubscribe();
		}
	});

	it("does not notify for a no-op set (same URL, trailing slash included)", () => {
		setApiBaseUrl("http://127.0.0.1:4555");
		const listener = vi.fn();
		const unsubscribe = subscribeApiBaseUrl(listener);
		try {
			setApiBaseUrl("http://127.0.0.1:4555");
			setApiBaseUrl("http://127.0.0.1:4555/");
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		subscribeApiBaseUrl(listener)();

		setApiBaseUrl("http://127.0.0.1:4555");

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("normalizeApiOperation", () => {
    it("normalizes Stay Awake source identifiers", () => {
        expect(normalizeApiOperation("POST", "/api/v1/awake/sessions/private-source/end")).toBe("POST /api/v1/awake/sessions/:id/end");
        expect(normalizeApiOperation("GET", "/api/v1/awake")).toBe("GET /api/v1/awake");
    });
	it("replaces identifier segments after resource collections", () => {
		expect(normalizeApiOperation("get", "/api/v1/projects/my project id")).toBe("GET /api/v1/projects/:id");
		expect(normalizeApiOperation("POST", "/api/v1/sessions/ao-42/kill")).toBe("POST /api/v1/sessions/:id/kill");
		expect(normalizeApiOperation("PUT", "/api/v1/projects/p1/config")).toBe("PUT /api/v1/projects/:id/config");
		expect(normalizeApiOperation("GET", "/api/v1/agents/claude-code/models")).toBe(
			"GET /api/v1/agents/:id/models",
		);
		expect(normalizeApiOperation("POST", "/api/v1/agents/codex/models/refresh")).toBe(
			"POST /api/v1/agents/:id/models/refresh",
		);
		expect(normalizeApiOperation("POST", "/api/v1/agents/codex/accounts/login-operations/72d4db6e-da2c-414c-a6a9-fdbd09a006b6/verify")).toBe(
			"POST /api/v1/agents/codex/accounts/login-operations/:id/verify",
		);
	});

	it("leaves collection and non-resource paths untouched", () => {
		expect(normalizeApiOperation("GET", "/api/v1/projects")).toBe("GET /api/v1/projects");
		expect(normalizeApiOperation("POST", "/api/v1/orchestrators")).toBe("POST /api/v1/orchestrators");
	});

	it("keeps static child routes instead of treating them as ids", () => {
		// These match an exact OpenAPI template, so the trailing segment must not
		// be collapsed to :id (which would break aggregation and hide the route).
		expect(normalizeApiOperation("GET", "/api/v1/agents/readiness")).toBe("GET /api/v1/agents/readiness");
		expect(normalizeApiOperation("POST", "/api/v1/agents/readiness/ensure")).toBe(
			"POST /api/v1/agents/readiness/ensure",
		);
		expect(normalizeApiOperation("POST", "/api/v1/notifications/read-all")).toBe("POST /api/v1/notifications/read-all");
		expect(normalizeApiOperation("POST", "/api/v1/projects/clone")).toBe("POST /api/v1/projects/clone");
		expect(normalizeApiOperation("POST", "/api/v1/projects/initialize")).toBe("POST /api/v1/projects/initialize");
		expect(normalizeApiOperation("POST", "/api/v1/sessions/cleanup")).toBe("POST /api/v1/sessions/cleanup");
		expect(normalizeApiOperation("GET", "/api/v1/agents/auth-plans")).toBe("GET /api/v1/agents/auth-plans");
	});

	it("normalizes agent ids in authentication routes", () => {
		expect(normalizeApiOperation("POST", "/api/v1/agents/claude-code/auth")).toBe(
			"POST /api/v1/agents/:id/auth",
		);
	});

	it("keeps workspace file routes aligned with the generated API schema", () => {
		expect(normalizeApiOperation("GET", "/api/v1/sessions/ao-42/workspace/files")).toBe(
			"GET /api/v1/sessions/:id/workspace/files",
		);
		expect(normalizeApiOperation("GET", "/api/v1/sessions/ao-42/workspace/file")).toBe(
			"GET /api/v1/sessions/:id/workspace/file",
		);
		expect(normalizeApiOperation("POST", "/api/v1/sessions/ao-42/preview/server")).toBe(
			"POST /api/v1/sessions/:id/preview/server",
		);
	});

	it("normalizes ids for resources a collection heuristic would miss", () => {
		expect(normalizeApiOperation("GET", "/api/v1/orchestrators/orch-abc")).toBe("GET /api/v1/orchestrators/:id");
		expect(normalizeApiOperation("POST", "/api/v1/prs/pr-1/merge")).toBe("POST /api/v1/prs/:id/merge");
		expect(normalizeApiOperation("POST", "/api/v1/sessions/ao-42/renders/r-1/artifact")).toBe("POST /api/v1/sessions/:id/renders/:id/artifact");
		expect(normalizeApiOperation("POST", "/api/v1/agents/codex/accounts/ensure")).toBe("POST /api/v1/agents/codex/accounts/ensure");
		expect(normalizeApiOperation("DELETE", "/api/v1/agents/codex/accounts/private-account-id")).toBe("DELETE /api/v1/agents/codex/accounts/:id");
	});
});

describe("apiErrorMessage", () => {
	it("shows the human daemon message without technical error codes", () => {
		expect(apiErrorMessage({ code: "AGENT_BINARY_NOT_FOUND", message: "agent binary not found on PATH" })).toBe(
			"agent binary not found on PATH",
		);
	});

	it("preserves the message when it contains parenthetical detail", () => {
		expect(
			apiErrorMessage({
				code: "RUNTIME_PREREQUISITE_MISSING",
				message: "tmux required (RUNTIME_PREREQUISITE_MISSING)",
			}),
		).toBe("tmux required (RUNTIME_PREREQUISITE_MISSING)");
	});

	it("reads the nested daemon error envelope", () => {
		expect(
			apiErrorMessage({
				error: { code: "REVIEWER_NOT_FOUND", message: "reviewer has not reviewed this PR" },
			}),
		).toBe("reviewer has not reviewed this PR");
	});
});


describe("apiErrorDetails", () => {
	it("preserves structured daemon recovery metadata", () => {
		const details = { existingProjectId: "registered-project", suggestedProjectId: "another-project" };
		expect(apiErrorDetails({ code: "PATH_ALREADY_REGISTERED", details })).toEqual(details);
	});

	it.each([undefined, null, "error", {}, { details: null }, { details: "project" }, { details: ["project"] }])(
		"ignores malformed metadata: %j", (error) => {
			expect(apiErrorDetails(error)).toBeUndefined();
		},
	);
});
