import { existsSync } from "node:fs";
import { brvQuery, brvCurate, brvSearch } from "./process.js";
import type {
  BrvBridgeConfig,
  BrvLogger,
  RecallResult,
  RecallOptions,
  PersistResult,
  PersistOptions,
  SearchResult,
  SearchOptions,
} from "./types.js";

const noopLogger: BrvLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * BrvBridge — standard interface for connecting agent frameworks
 * to ByteRover's Context Tree.
 *
 * Framework adapters create a BrvBridge instance and map their
 * lifecycle hooks to recall() and persist() calls.
 *
 * All operations are best-effort: failures return empty/error results
 * rather than throwing, so the host agent is never blocked.
 */
export class BrvBridge {
  private readonly brvPath: string;
  private readonly cwd: string;
  private readonly recallTimeoutMs: number;
  private readonly persistTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly logger: BrvLogger;

  constructor(config: BrvBridgeConfig) {
    this.brvPath = config.brvPath ?? "brv";
    this.cwd = config.cwd ?? process.cwd();
    this.recallTimeoutMs = config.recallTimeoutMs ?? 10_000;
    this.persistTimeoutMs = config.persistTimeoutMs ?? 60_000;
    this.searchTimeoutMs = config.searchTimeoutMs ?? 5_000;
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Check if the bridge is ready: cwd exists and has a .brv project.
   * Does not make network calls — just checks local filesystem state.
   */
  async ready(): Promise<boolean> {
    if (!existsSync(this.cwd)) {
      this.logger.warn(`cwd does not exist: ${this.cwd}`);
      return false;
    }
    if (!existsSync(`${this.cwd}/.brv`)) {
      this.logger.warn(
        `no .brv directory in ${this.cwd} — run "brv init" first`,
      );
      return false;
    }
    return true;
  }

  /**
   * Recall relevant context from the Context Tree for a given query.
   * Returns empty content on failure or when nothing relevant is found.
   */
  async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
    if (!query.trim()) {
      return { content: "" };
    }

    const cwd = options?.cwd ?? this.cwd;

    try {
      const result = await brvQuery({
        brvPath: this.brvPath,
        cwd,
        timeoutMs: this.recallTimeoutMs,
        logger: this.logger,
        query,
        signal: options?.signal,
      });

      const content = result.data?.result ?? result.data?.content ?? "";
      return { content: content.trim() };
    } catch (err) {
      const msg = String(err);
      if (msg.includes("aborted")) {
        this.logger.warn("recall aborted");
      } else {
        this.logger.warn(`recall failed: ${msg}`);
      }
      return { content: "" };
    }
  }

  /**
   * Persist context into the Context Tree for future recall.
   * Defaults to detach mode (fire-and-forget).
   */
  async persist(
    context: string,
    options?: PersistOptions,
  ): Promise<PersistResult> {
    if (!context.trim()) {
      return { status: "completed", message: "empty context, skipped" };
    }

    const detach = options?.detach ?? true;
    const cwd = options?.cwd ?? this.cwd;

    try {
      const result = await brvCurate({
        brvPath: this.brvPath,
        cwd,
        timeoutMs: this.persistTimeoutMs,
        logger: this.logger,
        context,
        detach,
      });

      return {
        status: result.data?.status ?? "completed",
        message: result.data?.message,
      };
    } catch (err) {
      this.logger.warn(`persist failed: ${String(err)}`);
      return { status: "error", message: String(err) };
    }
  }

  /**
   * Search the Context Tree for structured file results.
   * Returns ranked results with paths, scores, and excerpts.
   * Pure BM25 retrieval — no LLM, no token cost.
   *
   * Unlike recall() which returns a synthesized answer, search() returns
   * individual file-level results that can be navigated via readFile.
   */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const empty: SearchResult = { results: [], totalFound: 0, message: "" };

    if (!query.trim()) {
      return empty;
    }

    const cwd = options?.cwd ?? this.cwd;

    try {
      const result = await brvSearch({
        brvPath: this.brvPath,
        cwd,
        timeoutMs: this.searchTimeoutMs,
        logger: this.logger,
        query,
        limit: options?.limit,
        scope: options?.scope,
      });

      return {
        results: result.data?.results ?? [],
        totalFound: result.data?.totalFound ?? 0,
        message: result.data?.message ?? "",
      };
    } catch (err) {
      this.logger.warn(`search failed: ${String(err)}`);
      return empty;
    }
  }

  /**
   * Clean up resources. Currently a no-op since brv uses subprocess calls,
   * but adapters should call this for forward compatibility.
   */
  async shutdown(): Promise<void> {
    this.logger.debug?.("shutdown");
  }
}
