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

export type RecallResult = {
  /** The retrieved context string. Empty string if nothing relevant found. */
  content: string;
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
