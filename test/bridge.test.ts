import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrvBridge } from "../src/bridge.js";
import * as process from "../src/process.js";
import type {
  BrvCurateContinueData,
  BrvCurateKickoffData,
  BrvJsonResponse,
  BrvQueryData,
  BrvSearchData,
} from "../src/types.js";

// Mock the process module so tests don't spawn real brv CLI
vi.mock("../src/process.js", async () => {
  const actual = await vi.importActual("../src/process.js");
  return {
    ...actual,
    brvQuery: vi.fn(),
    brvSearch: vi.fn(),
    brvCurateKickoff: vi.fn(),
    brvCurateContinue: vi.fn(),
  };
});

// Mock fs.existsSync for ready() checks
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import { existsSync } from "node:fs";

const mockBrvQuery = vi.mocked(process.brvQuery);
const mockBrvSearch = vi.mocked(process.brvSearch);
const mockBrvCurateKickoff = vi.mocked(process.brvCurateKickoff);
const mockBrvCurateContinue = vi.mocked(process.brvCurateContinue);
const mockExistsSync = vi.mocked(existsSync);

function kickoffEnvelope(overrides: Partial<BrvCurateKickoffData> = {}): BrvJsonResponse<BrvCurateKickoffData> {
  return {
    command: "curate",
    success: true,
    timestamp: "t1",
    data: {
      status: "needs-llm-step",
      step: "generate-html",
      sessionId: "sess-abc",
      prompt: "(discarded)",
      ...overrides,
    },
  };
}

function continueDoneEnvelope(filePath = "security/auth.html"): BrvJsonResponse<BrvCurateContinueData> {
  return {
    command: "curate",
    success: true,
    timestamp: "t2",
    data: { ok: true, status: "done", filePath },
  };
}

function continueFailedEnvelope(errors = [{ kind: "validation-failed", message: "bad html" }]): BrvJsonResponse<BrvCurateContinueData> {
  return {
    command: "curate",
    success: true,
    timestamp: "t2",
    data: {
      ok: false,
      status: "failed",
      sessionId: "sess-abc",
      step: "correct-html",
      errors,
    },
  };
}

// Helper — build a query envelope with sane metadata defaults
function queryEnvelope(overrides: Partial<BrvQueryData> = {}): BrvJsonResponse<BrvQueryData> {
  return {
    command: "query",
    success: true,
    timestamp: "t1",
    data: {
      status: "ok",
      matchedDocs: [],
      metadata: {
        durationMs: 0,
        skippedSharedCount: 0,
        tier: 2,
        topScore: 0,
        totalFound: 0,
      },
      ...overrides,
    },
  };
}

describe("BrvBridge", () => {
  let bridge: BrvBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    bridge = new BrvBridge({ cwd: "/test/project" });
  });

  // -------------------------------------------------------------------------
  // ready()
  // -------------------------------------------------------------------------

  describe("ready", () => {
    it("returns true when cwd and .brv exist", async () => {
      mockExistsSync.mockReturnValue(true);
      expect(await bridge.ready()).toBe(true);
    });

    it("returns false when cwd does not exist", async () => {
      mockExistsSync.mockImplementation(() => false);
      expect(await bridge.ready()).toBe(false);
    });

    it("returns false when .brv directory is missing", async () => {
      mockExistsSync.mockImplementation((p) => !String(p).endsWith(".brv"));
      expect(await bridge.ready()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // recall()
  // -------------------------------------------------------------------------

  describe("recall", () => {
    it("concatenates rendered_md from matchedDocs with the markdown separator", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope({
        status: "ok",
        matchedDocs: [
          { format: "html", path: "auth/jwt.md", rendered_md: "## JWT\nUse RS256.", score: 0.92, title: "JWT" },
          { format: "markdown", path: "billing/stripe.md", rendered_md: "## Stripe\nWebhook.", score: 0.78, title: "Stripe" },
        ],
        metadata: {
          durationMs: 184,
          skippedSharedCount: 0,
          tier: 2,
          topScore: 0.92,
          totalFound: 2,
        },
      }));

      const result = await bridge.recall("what is the auth flow?");
      expect(result.content).toBe(
        "## JWT\nUse RS256.\n\n---\n\n## Stripe\nWebhook.",
      );
      expect(result.matchedDocs).toHaveLength(2);
      expect(result.matchedDocs![0].path).toBe("auth/jwt.md");
      expect(result.tier).toBe(2);
      expect(result.durationMs).toBe(184);
      expect(result.topScore).toBe(0.92);
    });

    it("returns empty content (and empty matchedDocs) on status: no-matches", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope({
        status: "no-matches",
        matchedDocs: [],
        metadata: {
          durationMs: 5,
          skippedSharedCount: 0,
          tier: 2,
          topScore: 0,
          totalFound: 0,
        },
      }));

      const result = await bridge.recall("nothing matches this");
      expect(result.content).toBe("");
      expect(result.matchedDocs).toEqual([]);
      expect(result.tier).toBe(2);
      expect(result.durationMs).toBe(5);
      expect(result.topScore).toBeUndefined(); // no matches → no topScore surfacing
    });

    it("reads metadata fields from data.metadata.*, NOT data.* directly", async () => {
      // Drift guard: an envelope that leaves metadata fields at the top level
      // (the pre-v2 shape) must NOT surface them. The bridge looks at
      // data.metadata only.
      mockBrvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: "t1",
        data: {
          status: "ok",
          matchedDocs: [
            { format: "html", path: "x/y.md", rendered_md: "body", score: 0.5, title: "x/y" },
          ],
          // Intentionally MISSING metadata field — pretend the daemon emitted
          // the legacy flat shape. Surface nothing.
        } as unknown as BrvQueryData,
      });

      const result = await bridge.recall("test");
      expect(result.content).toBe("body");
      expect(result.tier).toBeUndefined();
      expect(result.durationMs).toBeUndefined();
      expect(result.topScore).toBeUndefined();
    });

    it("returns empty content for empty query (does not spawn brv)", async () => {
      const result = await bridge.recall("   ");
      expect(result.content).toBe("");
      expect(mockBrvQuery).not.toHaveBeenCalled();
    });

    it("returns empty content on query failure", async () => {
      mockBrvQuery.mockRejectedValue(new Error("brv query failed (exit 1): error"));

      const result = await bridge.recall("some query");
      expect(result.content).toBe("");
    });

    it("returns empty content on abort", async () => {
      mockBrvQuery.mockRejectedValue(new Error("brv query aborted"));

      const result = await bridge.recall("some query");
      expect(result.content).toBe("");
    });

    it("uses cwd override when provided", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope());

      await bridge.recall("query", { cwd: "/override/path" });
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override/path" }),
      );
    });

    it("passes limit through to brvQuery", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope());

      await bridge.recall("query", { limit: 5 });
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 }),
      );
    });

    it("filters out empty rendered_md entries before joining", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope({
        matchedDocs: [
          { format: "html", path: "a.md", rendered_md: "alpha", score: 0.9, title: "a" },
          { format: "html", path: "b.md", rendered_md: "", score: 0.8, title: "b" },
          { format: "html", path: "c.md", rendered_md: "gamma", score: 0.7, title: "c" },
        ],
      }));

      const result = await bridge.recall("test");
      // Empty middle entry should not produce a "---\n\n\n\n---" gap
      expect(result.content).toBe("alpha\n\n---\n\ngamma");
    });
  });

  // -------------------------------------------------------------------------
  // queryEnvelope()
  // -------------------------------------------------------------------------

  describe("queryEnvelope", () => {
    it("returns the raw QueryToolModeResult envelope shape verbatim", async () => {
      const env = queryEnvelope({
        status: "ok",
        matchedDocs: [
          { format: "html", path: "a.md", rendered_md: "alpha", score: 0.9, title: "a" },
        ],
        metadata: {
          cacheHit: "fuzzy",
          durationMs: 50,
          skippedSharedCount: 2,
          tier: 1,
          topScore: 0.9,
          totalFound: 1,
        },
      });
      mockBrvQuery.mockResolvedValue(env);

      const result = await bridge.queryEnvelope("question");
      // No field renaming, no derivation — the bridge just hands back data.
      expect(result).toEqual(env.data);
    });

    it("passes limit through as --limit", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope());
      await bridge.queryEnvelope("query", { limit: 3 });
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
    });

    it("uses cwd override when provided", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope());
      await bridge.queryEnvelope("query", { cwd: "/override" });
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override" }),
      );
    });

    it("throws on subprocess failure (unlike recall, which swallows)", async () => {
      mockBrvQuery.mockRejectedValue(new Error("brv query failed"));
      await expect(bridge.queryEnvelope("query")).rejects.toThrow(/brv query failed/);
    });

    it("returns no-matches envelope without throwing", async () => {
      mockBrvQuery.mockResolvedValue(queryEnvelope({
        status: "no-matches",
        matchedDocs: [],
        metadata: {
          durationMs: 5,
          skippedSharedCount: 0,
          tier: 2,
          topScore: 0,
          totalFound: 0,
        },
      }));

      const result = await bridge.queryEnvelope("nothing");
      expect(result.status).toBe("no-matches");
      expect(result.matchedDocs).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // persistHtml()
  // -------------------------------------------------------------------------

  describe("persistHtml", () => {
    const VALID_HTML = '<bv-topic path="security/auth" title="Auth"></bv-topic>';

    it("happy path: runs kickoff + continuation, returns ok envelope", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope("security/auth.html"));

      const result = await bridge.persistHtml({ html: VALID_HTML });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.filePath).toBe("security/auth.html");
        expect(result.topicPath).toBe("security/auth"); // .html stripped
        expect(result.overwrote).toBe(false); // v1: not surfaced yet
      }
    });

    it("plumbs sessionId from kickoff into continuation", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope({ sessionId: "sess-xyz" }));
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());

      await bridge.persistHtml({ html: VALID_HTML });

      expect(mockBrvCurateContinue).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-xyz" }),
      );
    });

    it("threads html + meta into the continuation envelope", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());

      const meta = {
        type: "ADD" as const,
        impact: "high" as const,
        reason: "load-bearing decision",
        summary: "RS256 chosen",
      };
      await bridge.persistHtml({ html: VALID_HTML, meta });

      expect(mockBrvCurateContinue).toHaveBeenCalledWith(
        expect.objectContaining({ html: VALID_HTML, meta }),
      );
    });

    it("passes confirmOverwrite through to the continuation helper", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());

      await bridge.persistHtml({ html: VALID_HTML, confirmOverwrite: true });

      expect(mockBrvCurateContinue).toHaveBeenCalledWith(
        expect.objectContaining({ confirmOverwrite: true }),
      );
    });

    it("returns validation-failed with errors when continuation reports failure", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueFailedEnvelope([
        { kind: "missing-bv-topic", message: "no <bv-topic> root" },
      ]));

      const result = await bridge.persistHtml({ html: "<div>not a topic</div>" });

      expect(result.status).toBe("validation-failed");
      if (result.status === "validation-failed") {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].kind).toBe("missing-bv-topic");
      }
    });

    it("propagates kickoff subprocess failures (does NOT swallow)", async () => {
      mockBrvCurateKickoff.mockRejectedValue(new Error("brv curate timed out after 60000ms"));

      await expect(bridge.persistHtml({ html: VALID_HTML })).rejects.toThrow(/timed out/);
      expect(mockBrvCurateContinue).not.toHaveBeenCalled();
    });

    it("propagates continuation subprocess failures", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockRejectedValue(new Error("brv curate aborted"));

      await expect(bridge.persistHtml({ html: VALID_HTML })).rejects.toThrow(/aborted/);
    });

    it("throws if kickoff omits sessionId (defensive)", async () => {
      mockBrvCurateKickoff.mockResolvedValue({
        command: "curate",
        success: true,
        timestamp: "t1",
        data: { status: "needs-llm-step", step: "generate-html", prompt: "p" } as unknown as BrvCurateKickoffData,
      });

      await expect(bridge.persistHtml({ html: VALID_HTML })).rejects.toThrow(/sessionId/);
    });

    it("uses cwd override on both subprocess calls", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());

      await bridge.persistHtml({ html: VALID_HTML }, { cwd: "/override" });

      expect(mockBrvCurateKickoff).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override" }),
      );
      expect(mockBrvCurateContinue).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override" }),
      );
    });

    it("forwards signal to both subprocess calls for cancellation", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());
      const signal = new AbortController().signal;

      await bridge.persistHtml({ html: VALID_HTML }, { signal });

      expect(mockBrvCurateKickoff).toHaveBeenCalledWith(
        expect.objectContaining({ signal }),
      );
      expect(mockBrvCurateContinue).toHaveBeenCalledWith(
        expect.objectContaining({ signal }),
      );
    });

    it("uses kickoff placeholder marker as intent (distinguishable in telemetry)", async () => {
      mockBrvCurateKickoff.mockResolvedValue(kickoffEnvelope());
      mockBrvCurateContinue.mockResolvedValue(continueDoneEnvelope());

      await bridge.persistHtml({ html: VALID_HTML });

      // The intent string is what shows up in the daemon's curate-log
      // 'input.context' field. Use a marker that's clearly bridge-originated.
      expect(mockBrvCurateKickoff).toHaveBeenCalledWith(
        expect.objectContaining({ intent: expect.stringContaining("brv-bridge") }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // persist() — throws migration error in v2.0
  // -------------------------------------------------------------------------

  describe("persist (deprecated)", () => {
    it("throws a clear migration error pointing at persistHtml", async () => {
      await expect(bridge.persist("some context")).rejects.toThrow(
        /persistHtml/,
      );
    });

    it("throws regardless of whether context is empty or non-empty", async () => {
      await expect(bridge.persist("")).rejects.toThrow();
      await expect(bridge.persist("non-empty")).rejects.toThrow();
    });

    it("error message references v2.0 and the new API", async () => {
      try {
        await bridge.persist("anything");
        expect.fail("persist() should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("v2.0");
        expect(msg).toContain("persistHtml");
        expect(msg).toMatch(/<bv-topic>/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------

  describe("shutdown", () => {
    it("resolves without error", async () => {
      await expect(bridge.shutdown()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // constructor defaults
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("defaults cwd to process.cwd()", async () => {
      const defaultBridge = new BrvBridge({});
      mockBrvQuery.mockResolvedValue(queryEnvelope());

      await defaultBridge.recall("test query");
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: globalThis.process.cwd() }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe("search", () => {
    it("returns structured results from brv search", async () => {
      mockBrvSearch.mockResolvedValue({
        command: "search",
        success: true,
        timestamp: "t1",
        data: {
          status: "completed",
          results: [
            { path: "auth/jwt.md", title: "JWT", excerpt: "JWT tokens", score: 0.91 },
            { path: "auth/oauth.md", title: "OAuth", excerpt: "OAuth flow", score: 0.85 },
          ],
          totalFound: 2,
          message: "Found 2 results",
        },
      } as BrvJsonResponse<BrvSearchData>);

      const result = await bridge.search("authentication");
      expect(result.results).toHaveLength(2);
      expect(result.results[0].path).toBe("auth/jwt.md");
      expect(result.results[0].score).toBe(0.91);
      expect(result.totalFound).toBe(2);
    });

    it("returns empty results for empty query", async () => {
      const result = await bridge.search("   ");
      expect(result.results).toHaveLength(0);
      expect(result.totalFound).toBe(0);
      expect(mockBrvSearch).not.toHaveBeenCalled();
    });

    it("returns empty results on search failure", async () => {
      mockBrvSearch.mockRejectedValue(new Error("daemon not running"));

      const result = await bridge.search("test query");
      expect(result.results).toHaveLength(0);
      expect(result.totalFound).toBe(0);
    });

    it("passes limit and scope to brvSearch", async () => {
      mockBrvSearch.mockResolvedValue({
        command: "search",
        success: true,
        timestamp: "t1",
        data: { status: "completed", results: [], totalFound: 0, message: "" },
      } as BrvJsonResponse<BrvSearchData>);

      await bridge.search("test", { limit: 5, scope: "auth" });
      expect(mockBrvSearch).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, scope: "auth" }),
      );
    });

    it("uses cwd override when provided", async () => {
      mockBrvSearch.mockResolvedValue({
        command: "search",
        success: true,
        timestamp: "t1",
        data: { status: "completed", results: [], totalFound: 0, message: "" },
      } as BrvJsonResponse<BrvSearchData>);

      await bridge.search("test", { cwd: "/override/path" });
      expect(mockBrvSearch).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override/path" }),
      );
    });

    it("returns empty results when data has no results field", async () => {
      mockBrvSearch.mockResolvedValue({
        command: "search",
        success: true,
        timestamp: "t1",
        data: { status: "completed" },
      } as BrvJsonResponse<BrvSearchData>);

      const result = await bridge.search("test");
      expect(result.results).toHaveLength(0);
      expect(result.totalFound).toBe(0);
    });
  });
});
