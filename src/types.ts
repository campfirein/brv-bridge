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

export type BrvCurateData = {
  status: "completed" | "queued" | "error";
  event?: string;
  message?: string;
  taskId?: string;
  logId?: string;
  changes?: { created?: string[]; updated?: string[] };
  error?: string;
};
