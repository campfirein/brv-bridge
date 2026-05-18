import { existsSync } from "node:fs";
import {
  brvCurateContinue,
  brvCurateKickoff,
  brvQuery,
  brvSearch,
} from "./process.js";
import type {
  BrvBridgeConfig,
  BrvLogger,
  PersistHtmlInput,
  PersistHtmlOptions,
  PersistHtmlResult,
  PersistOptions,
  PersistResult,
  QueryEnvelopeOptions,
  QueryToolModeResult,
  RecallMatchedDoc,
  RecallOptions,
  RecallResult,
  RecallTier,
  SearchOptions,
  SearchResult,
} from "./types.js";

const noopLogger: BrvLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const RECALL_SEPARATOR = "\n\n---\n\n";

/**
 * Placeholder intent used in the curate kickoff phase. The agent already
 * authored its HTML before calling `persistHtml`, so the prompt returned
 * by kickoff is discarded — only the sessionId matters. The marker shape
 * keeps it distinguishable in session telemetry.
 */
const CURATE_KICKOFF_PLACEHOLDER = "_brv-bridge curate placeholder_";

/**
 * BrvBridge — standard interface for connecting agent frameworks
 * to ByteRover's Context Tree.
 *
 * Framework adapters create a BrvBridge instance and map their lifecycle
 * hooks to recall() / queryEnvelope() / persistHtml() calls.
 *
 * All read operations are best-effort: failures return empty results
 * rather than throwing, so the host agent is never blocked. Write
 * operations (`persistHtml`) surface validation errors structurally so
 * the agent can author corrected HTML on its next call.
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
   *
   * Returns `content` as a concatenation of `matchedDocs[].rendered_md`
   * separated by `\n\n---\n\n`. Empty string on no-matches, failure, or
   * empty query. Failures are logged at WARN level and swallowed so the
   * host agent is never blocked by a recall outage.
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
        limit: options?.limit,
        signal: options?.signal,
      });

      const matchedDocs = result.data?.matchedDocs ?? [];
      const metadata = result.data?.metadata;
      const content = matchedDocs
        .map((m) => m.rendered_md)
        .filter((s) => s !== undefined && s !== "")
        .join(RECALL_SEPARATOR)
        .trim();

      const recall: RecallResult = { content, matchedDocs };
      if (metadata?.tier !== undefined) {
        recall.tier = metadata.tier as RecallTier;
      }
      if (metadata?.durationMs !== undefined) {
        recall.durationMs = metadata.durationMs;
      }
      if (metadata?.topScore !== undefined && matchedDocs.length > 0) {
        recall.topScore = metadata.topScore;
      }
      return recall;
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
   * Return the raw `QueryToolModeResult` envelope for callers that need
   * structured matched-docs (e.g. an agent-facing `brv-query` tool handler
   * that returns the envelope verbatim to the LLM).
   *
   * Unlike `recall()`, this throws on failure rather than swallowing —
   * callers wrapping it in a tool handler are expected to surface the
   * error as a structured tool result.
   */
  async queryEnvelope(
    query: string,
    options?: QueryEnvelopeOptions,
  ): Promise<QueryToolModeResult> {
    const cwd = options?.cwd ?? this.cwd;
    const result = await brvQuery({
      brvPath: this.brvPath,
      cwd,
      timeoutMs: this.recallTimeoutMs,
      logger: this.logger,
      query,
      limit: options?.limit,
      signal: options?.signal,
    });
    return result.data;
  }

  /**
   * Persist a pre-authored `<bv-topic>` HTML document to the Context Tree.
   *
   * Drives the brv curate session protocol internally: one kickoff
   * subprocess to obtain a sessionId, then one continuation subprocess
   * carrying the `{html, meta?}` envelope as `--response`.
   *
   * `confirmOverwrite` rides on the continuation's `--overwrite` CLI flag,
   * not inside the JSON envelope, matching the daemon's protocol.
   *
   * On validation failure the daemon returns `step: 'correct-html'` and
   * structured errors; this method returns `{status: 'validation-failed'}`
   * so the calling agent can author corrected HTML on its next call. The
   * bridge does NOT loop internally — orchestrating retries is the
   * agent's responsibility.
   *
   * Transport errors (subprocess crash, timeout, etc.) propagate as
   * exceptions; the tool handler that wraps this should surface them as
   * a structured tool result rather than letting them escape.
   */
  async persistHtml(
    input: PersistHtmlInput,
    options?: PersistHtmlOptions,
  ): Promise<PersistHtmlResult> {
    const cwd = options?.cwd ?? this.cwd;

    const kickoff = await brvCurateKickoff({
      brvPath: this.brvPath,
      cwd,
      timeoutMs: this.persistTimeoutMs,
      logger: this.logger,
      intent: CURATE_KICKOFF_PLACEHOLDER,
      signal: options?.signal,
    });

    const sessionId = kickoff.data?.sessionId;
    if (!sessionId) {
      throw new Error(
        `brv curate kickoff did not return a sessionId (status=${String(
          kickoff.data?.status,
        )})`,
      );
    }

    const continuation = await brvCurateContinue({
      brvPath: this.brvPath,
      cwd,
      timeoutMs: this.persistTimeoutMs,
      logger: this.logger,
      sessionId,
      html: input.html,
      meta: input.meta,
      confirmOverwrite: input.confirmOverwrite,
      signal: options?.signal,
    });

    const data = continuation.data;
    if (data?.ok && data.status === "done") {
      const filePath = data.filePath;
      return {
        status: "ok",
        filePath,
        topicPath: filePath.replace(/\.html$/, ""),
        // v1: the continuation envelope doesn't surface `overwrote` yet.
        // Plumbed through as `false` and promoted when byterover-cli adds it.
        overwrote: false,
      };
    }

    if (data && !data.ok) {
      return {
        status: "validation-failed",
        errors: data.errors ?? [],
      };
    }

    throw new Error(
      `brv curate continuation returned an unrecognised envelope: ${JSON.stringify(
        data,
      )}`,
    );
  }

  /**
   * Persist context into the Context Tree.
   *
   * @deprecated Removed in v3.0. Tool-mode `brv` requires pre-authored
   * `<bv-topic>` HTML — the calling agent's LLM authors the document, the
   * bridge writes it. Migrate to `persistHtml({html, meta?, confirmOverwrite?})`.
   * This method now throws to surface the migration cleanly.
   */
  async persist(
    _context: string,
    _options?: PersistOptions,
  ): Promise<PersistResult> {
    throw new Error(
      "BrvBridge.persist() is removed in v2.0. " +
        "Tool-mode `brv` requires pre-authored <bv-topic> HTML. " +
        "Use BrvBridge.persistHtml({html, meta?, confirmOverwrite?}) instead. " +
        "See CHANGELOG.md for migration details.",
    );
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

// Re-export key types for back-compat with callers that imported from bridge.ts
export type { RecallMatchedDoc };
