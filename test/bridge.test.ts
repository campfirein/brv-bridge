import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrvBridge } from "../src/bridge.js";
import * as process from "../src/process.js";
import type { BrvJsonResponse, BrvQueryData, BrvCurateData } from "../src/types.js";

// Mock the process module so tests don't spawn real brv CLI
vi.mock("../src/process.js", async () => {
  const actual = await vi.importActual("../src/process.js");
  return {
    ...actual,
    brvQuery: vi.fn(),
    brvCurate: vi.fn(),
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
const mockBrvCurate = vi.mocked(process.brvCurate);
const mockExistsSync = vi.mocked(existsSync);

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
      mockExistsSync.mockImplementation((p) => false);
      expect(await bridge.ready()).toBe(false);
    });

    it("returns false when .brv directory is missing", async () => {
      mockExistsSync.mockImplementation((p) => {
        return !String(p).endsWith(".brv");
      });
      expect(await bridge.ready()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // recall()
  // -------------------------------------------------------------------------

  describe("recall", () => {
    it("returns content from brv query", async () => {
      mockBrvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: "t1",
        data: { status: "completed", result: "the answer" },
      } as BrvJsonResponse<BrvQueryData>);

      const result = await bridge.recall("what is the auth flow?");
      expect(result.content).toBe("the answer");
    });

    it("returns content from data.content field", async () => {
      mockBrvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: "t1",
        data: { status: "completed", content: "alt answer" },
      } as BrvJsonResponse<BrvQueryData>);

      const result = await bridge.recall("question");
      expect(result.content).toBe("alt answer");
    });

    it("returns empty content for empty query", async () => {
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
      mockBrvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: "t1",
        data: { status: "completed", result: "answer" },
      } as BrvJsonResponse<BrvQueryData>);

      await bridge.recall("query", { cwd: "/override/path" });
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override/path" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // persist()
  // -------------------------------------------------------------------------

  describe("persist", () => {
    it("curates context with detach by default", async () => {
      mockBrvCurate.mockResolvedValue({
        command: "curate",
        success: true,
        timestamp: "t1",
        data: { status: "queued", taskId: "abc" },
      } as BrvJsonResponse<BrvCurateData>);

      const result = await bridge.persist("user prefers dark mode");
      expect(result.status).toBe("queued");
      expect(mockBrvCurate).toHaveBeenCalledWith(
        expect.objectContaining({ detach: true }),
      );
    });

    it("supports non-detach mode", async () => {
      mockBrvCurate.mockResolvedValue({
        command: "curate",
        success: true,
        timestamp: "t1",
        data: { status: "completed" },
      } as BrvJsonResponse<BrvCurateData>);

      const result = await bridge.persist("some context", { detach: false });
      expect(result.status).toBe("completed");
      expect(mockBrvCurate).toHaveBeenCalledWith(
        expect.objectContaining({ detach: false }),
      );
    });

    it("skips empty context", async () => {
      const result = await bridge.persist("   ");
      expect(result.status).toBe("completed");
      expect(result.message).toBe("empty context, skipped");
      expect(mockBrvCurate).not.toHaveBeenCalled();
    });

    it("returns error status on failure", async () => {
      mockBrvCurate.mockRejectedValue(new Error("brv curate failed"));

      const result = await bridge.persist("some context");
      expect(result.status).toBe("error");
      expect(result.message).toContain("brv curate failed");
    });

    it("uses cwd override when provided", async () => {
      mockBrvCurate.mockResolvedValue({
        command: "curate",
        success: true,
        timestamp: "t1",
        data: { status: "queued" },
      } as BrvJsonResponse<BrvCurateData>);

      await bridge.persist("some context", { cwd: "/override/path" });
      expect(mockBrvCurate).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/override/path" }),
      );
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
      mockBrvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: "t1",
        data: { status: "completed", result: "answer" },
      } as BrvJsonResponse<BrvQueryData>);

      await defaultBridge.recall("test query");
      expect(mockBrvQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: globalThis.process.cwd() }),
      );
    });
  });
});
