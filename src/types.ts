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
// Operation options and results
// ---------------------------------------------------------------------------

export type RecallOptions = {
  /** AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal;
  /** Override the default cwd for this operation. */
  cwd?: string;
};

/** Single matched document returned by ByteRover's query layer. */
export type RecallMatchedDoc = {
  /** Relative path within the context tree (e.g. "auth/jwt-tokens.md"). */
  path: string;
  /** Compound score combining BM25 relevance, importance, recency, and maturity tier boost. */
  score: number;
  /** Title from the document's frontmatter (or first heading as fallback). */
  title: string;
};

/**
 * Resolution tier reported by the query layer.
 *  0: exact cache hit
 *  1: fuzzy cache match
 *  2: BM25 direct response (no LLM)
 *  3: LLM with prefetched context
 *  4: full agentic loop
 */
export type RecallTier = 0 | 1 | 2 | 3 | 4;

export type RecallResult = {
  /** The retrieved context string. Empty string if nothing relevant found. */
  content: string;
  /**
   * Documents matched by the query layer. Empty array on cache hits (the cached payload
   * does not preserve match metadata). Absent when the brv CLI does not surface this field —
   * callers must treat undefined as "metadata unavailable" and degrade gracefully.
   */
  matchedDocs?: RecallMatchedDoc[];
  /**
   * Resolution tier (0-4). Absent on older CLIs.
   * Plumbed through for future visibility surfaces (cache-hit badge, tier label).
   */
  tier?: RecallTier;
  /**
   * Wall-clock execution time in milliseconds. Absent on older CLIs.
   * Plumbed through for future visibility surfaces (latency annotation).
   */
  durationMs?: number;
  /**
   * Top compound score across `matchedDocs`. Absent on cache hits and on older CLIs.
   * Plumbed through for future visibility surfaces (relevance badge).
   */
  topScore?: number;
};

export type PersistOptions = {
  /** Fire-and-forget mode — CLI returns immediately, daemon processes async. Defaults to true. */
  detach?: boolean;
  /** Override the default cwd for this operation. */
  cwd?: string;
};

export type PersistResult = {
  status: "completed" | "queued" | "error";
  message?: string;
};

export type SearchOptions = {
  /** Maximum number of results (1-50, default 10). */
  limit?: number;
  /** Path prefix to scope results (e.g. "auth"). No trailing slash. */
  scope?: string;
  /** Override the default cwd for this operation. */
  cwd?: string;
};

export type SearchResultItem = {
  /** Relative path in the context tree (e.g. "auth/jwt-tokens.md"). */
  path: string;
  /** Topic title from frontmatter. */
  title: string;
  /** Content excerpt that matched the query. */
  excerpt: string;
  /** Normalized BM25 relevance score (0-1). */
  score: number;
  /** Symbol kind: "domain", "topic", "subtopic", "context", "archive_stub", "summary". */
  symbolKind?: string;
  /** Number of other context tree files that reference this one. */
  backlinkCount?: number;
  /** Top related file paths (max 3). */
  relatedPaths?: string[];
};

export type SearchResult = {
  /** Ranked search results. */
  results: SearchResultItem[];
  /** Total number of matches found (may exceed results.length when limited). */
  totalFound: number;
  /** Human-readable status message. */
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

export type BrvQueryData = {
  status: "completed" | "error";
  event?: string;
  taskId?: string;
  result?: string;
  content?: string;
  message?: string;
  error?: string;
  /** Structured recall payload surfaced by newer `brv query --format json` envelopes; absent on older CLIs. */
  matchedDocs?: RecallMatchedDoc[];
  tier?: RecallTier;
  durationMs?: number;
  topScore?: number;
};

export type BrvSearchData = {
  status: "completed" | "error";
  results?: SearchResultItem[];
  totalFound?: number;
  message?: string;
  error?: string;
};

export type BrvCurateData = {
  status: "completed" | "queued" | "error";
  event?: string;
  message?: string;
  taskId?: string;
  logId?: string;
  changes?: { created?: string[]; updated?: string[] };
  error?: string;
};
