export { BrvBridge } from "./bridge.js";
export type {
  // Config + logger
  BrvBridgeConfig,
  BrvLogger,

  // Recall (high-level)
  RecallResult,
  RecallOptions,
  RecallMatchedDoc,
  RecallTier,

  // Query envelope (raw passthrough)
  QueryEnvelopeOptions,
  QueryToolModeResult,
  QueryToolModeMatchedDoc,
  QueryToolModeMetadata,

  // Persist (v2 surface)
  PersistHtmlInput,
  PersistHtmlOptions,
  PersistHtmlResult,
  PersistHtmlError,
  CurateMeta,

  // Search (unchanged in v2)
  SearchResult,
  SearchResultItem,
  SearchOptions,

  // Legacy types — kept exported as @deprecated for back-compat type imports.
  // The `persist()` method throws in v2.0; the types disappear in v3.0.
  PersistResult,
  PersistOptions,
} from "./types.js";
