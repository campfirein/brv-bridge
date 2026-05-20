// ---------------------------------------------------------------------------
// Logger — minimal interface, adapters provide their own implementation
// ---------------------------------------------------------------------------

export type BrvLogger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

export type BrvBridgeConfig = {
  /** Path to the brv binary. Defaults to "brv". */
  brvPath?: string;
  /** Working directory (must have .brv/ initialized). Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout for recall (query) calls in ms. Defaults to 10_000. */
  recallTimeoutMs?: number;
  /** Timeout for persist (curate) calls in ms. Defaults to 60_000. */
  persistTimeoutMs?: number;
  /** Timeout for search calls in ms. Defaults to 5_000. */
  searchTimeoutMs?: number;
  /** Logger instance. Falls back to silent no-op if not provided. */
  logger?: BrvLogger;
};

// ---------------------------------------------------------------------------
// Query / recall — canonical envelope shape from `brv query --format json`.
// Mirrors `QueryToolModeResult` in byterover-cli's i-query-executor.ts.
// Renaming any field on these types is a breaking change.
// ---------------------------------------------------------------------------

/**
 * One retrieved doc returned by ByteRover's query layer. `rendered_md` is
 * snake_case to match the JSON wire envelope.
 */
export type QueryToolModeMatchedDoc = {
  format: "html" | "markdown";
  path: string;
  /** Rendered markdown body. The bridge's `recall().content` concatenates these. */
  rendered_md: string;
  score: number;
  title: string;
};

/** Observability + cache signals carried alongside the matches. */
export type QueryToolModeMetadata = {
  /**
   * Which cache layer served the response. `null` when retrieval ran fresh
   * (no cache hit) or when the cache is disabled.
   */
  cacheHit?: "exact" | "fuzzy" | null;
  durationMs: number;
  /**
   * Number of BM25 matches dropped because they originated from a shared
   * source. v1 of tool mode is local-only.
   */
  skippedSharedCount: number;
  /** 0 = exact cache, 1 = fuzzy cache, 2 = direct search (no LLM). */
  tier: number;
  topScore: number;
  totalFound: number;
};

/**
 * Wire envelope returned by every tool-mode query call. One-shot.
 * - `status: 'ok'` — retrieval ran and produced one or more matches.
 * - `status: 'no-matches'` — retrieval ran cleanly but BM25 found nothing.
 */
export type QueryToolModeResult = {
  matchedDocs: QueryToolModeMatchedDoc[];
  metadata: QueryToolModeMetadata;
  status: "no-matches" | "ok";
};

// ---------------------------------------------------------------------------
// Recall result (public bridge surface)
// ---------------------------------------------------------------------------

export type RecallOptions = {
  /** AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal;
  /** Override the default cwd for this operation. */
  cwd?: string;
  /** Max matches to return. Defaults to 10. Bounded 1-50 by the CLI flag. */
  limit?: number;
};

/**
 * Resolution tier reported by the query layer.
 *  0: exact cache hit
 *  1: fuzzy cache match
 *  2: BM25 direct response (no LLM)
 */
export type RecallTier = 0 | 1 | 2;

/**
 * Single matched document — kept for back-compat with callers that read
 * `RecallResult.matchedDocs`. Mirrors `QueryToolModeMatchedDoc`.
 */
export type RecallMatchedDoc = QueryToolModeMatchedDoc;

export type RecallResult = {
  /**
   * Retrieved context. Concatenation of `matchedDocs[].rendered_md`
   * separated by `\n\n---\n\n`. Empty string when no matches.
   */
  content: string;
  /**
   * Documents matched by the query layer. Empty array on `no-matches` or
   * cache hits with stripped metadata. Undefined when the recall failed
   * before the daemon answered (network error, timeout, etc.).
   */
  matchedDocs?: RecallMatchedDoc[];
  /** Resolution tier (0-2). Undefined on failure. */
  tier?: RecallTier;
  /** Wall-clock execution time in milliseconds. Undefined on failure. */
  durationMs?: number;
  /** Top score across `matchedDocs`. Undefined when `matchedDocs` is empty. */
  topScore?: number;
};

// ---------------------------------------------------------------------------
// Query envelope (raw passthrough for callers that want the wire shape)
// ---------------------------------------------------------------------------

export type QueryEnvelopeOptions = {
  signal?: AbortSignal;
  cwd?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Curate / persist
// ---------------------------------------------------------------------------

/**
 * Operation metadata supplied by the calling agent's LLM. Drives the HITL
 * review pipeline. Mirrors byterover-cli's `CurateMeta`.
 */
export type CurateMeta = {
  /** `'ADD'` for net-new topic, `'UPDATE'` for replacing existing, `'MERGE'` after path-exists. */
  type?: "ADD" | "UPDATE" | "MERGE";
  /** `'high'` surfaces the operation in `brv review pending`. */
  impact?: "high" | "low";
  /** One-sentence rationale shown to human reviewers. */
  reason?: string;
  /** One-line semantic summary of the topic. */
  summary?: string;
  /** UPDATE/MERGE: one-line summary of what existed before. */
  previousSummary?: string;
  confidence?: "high" | "low";
};

export type PersistHtmlInput = {
  /** Full <bv-topic>...</bv-topic> document authored by the calling agent. */
  html: string;
  /** Optional operation metadata. Omitting `meta` means the curate succeeds without HITL surfacing. */
  meta?: CurateMeta;
  /** Pass through to the writer to allow overwriting an existing topic at the same path. */
  confirmOverwrite?: boolean;
};

export type PersistHtmlOptions = {
  /** AbortSignal for caller-controlled cancellation. Covers both kickoff and continuation subprocesses. */
  signal?: AbortSignal;
  /** Override the default cwd for this operation. */
  cwd?: string;
};

/** One per-error item returned by the daemon on validation failure. */
export type PersistHtmlError = {
  kind: string;
  message: string;
  field?: string;
  tag?: string;
};

export type PersistHtmlResult =
  | {
      status: "ok";
      /** Relative filesystem path of the written topic (e.g. "security/auth.html"). */
      filePath: string;
      /** Logical topic path (extensionless: "security/auth"). */
      topicPath: string;
      /**
       * `true` if a topic at this path existed before this call. Set to
       * `false` in v1 because the session-protocol response doesn't yet
       * surface it; promoted to the real value when byterover-cli's
       * continuation envelope gains the field.
       */
      overwrote: boolean;
    }
  | {
      status: "validation-failed";
      errors: PersistHtmlError[];
    };

// ---------------------------------------------------------------------------
// Legacy persist surface — kept for back-compat type imports only.
// `BrvBridge.persist()` throws a migration error in v2.0; the types stay
// exported with `@deprecated` so consumer builds that import the types
// (without invoking the method) continue to compile. Removed in v3.0.
// ---------------------------------------------------------------------------

/** @deprecated Removed in v3.0. Use `PersistHtmlOptions` with `BrvBridge.persistHtml()`. */
export type PersistOptions = {
  detach?: boolean;
  cwd?: string;
};

/** @deprecated Removed in v3.0. Use `PersistHtmlResult` with `BrvBridge.persistHtml()`. */
export type PersistResult = {
  status: "completed" | "queued" | "error";
  message?: string;
};

// ---------------------------------------------------------------------------
// Search (unchanged in v2.0 — `brv search` is unaffected by tool-mode)
// ---------------------------------------------------------------------------

export type SearchOptions = {
  /** Maximum number of results (1-50, default 10). */
  limit?: number;
  /** Path prefix to scope results (e.g. "auth"). No trailing slash. */
  scope?: string;
  /** Override the default cwd for this operation. */
  cwd?: string;
};

export type SearchResultItem = {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  symbolKind?: string;
  backlinkCount?: number;
  relatedPaths?: string[];
};

export type SearchResult = {
  results: SearchResultItem[];
  totalFound: number;
  message: string;
};

// ---------------------------------------------------------------------------
// brv CLI JSON output shapes (internal)
// ---------------------------------------------------------------------------

/** Wrapper envelope for all brv --format json responses. */
export type BrvJsonResponse<T = unknown> = {
  command: string;
  success: boolean;
  timestamp: string;
  data: T;
};

/**
 * Shape of `brv query --format json` data field. Mirrors `QueryToolModeResult`
 * with a small wrapper for the outer status field (error case).
 */
export type BrvQueryData = QueryToolModeResult;

export type BrvSearchData = {
  status: "completed" | "error";
  results?: SearchResultItem[];
  totalFound?: number;
  message?: string;
  error?: string;
};

/**
 * Shape of `brv curate "<intent>" --format json` (kickoff phase).
 * Returns a sessionId and the prompt the agent should follow.
 */
export type BrvCurateKickoffData = {
  status: "needs-llm-step";
  step: "generate-html";
  sessionId: string;
  prompt: string;
};

/**
 * Shape of `brv curate --session <id> --response '<...>' --format json` (continuation).
 * Either signals successful write or asks for correction.
 */
export type BrvCurateContinueData =
  | {
      ok: true;
      status: "done";
      filePath: string;
    }
  | {
      ok: false;
      status: "failed";
      sessionId?: string;
      step?: "correct-html";
      errors: PersistHtmlError[];
    };

/**
 * Legacy `brv curate "<text>" --detach` response. Kept so `process.ts`'s
 * deprecated `brvCurate()` helper still compiles. Not used by the v2 bridge
 * (`BrvBridge.persist()` throws), but exported for downstream callers that
 * may have typed imports.
 *
 * @deprecated Removed in v3.0 alongside the legacy `persist()` method.
 */
export type BrvCurateData = {
  status: "completed" | "queued" | "error";
  event?: string;
  message?: string;
  taskId?: string;
  logId?: string;
  changes?: { created?: string[]; updated?: string[] };
  error?: string;
};
