# Changelog

## 2.0.0

**Tool-mode adaptation (ENG-2852).** Adapts the bridge to byterover-cli's tool-mode `brv` — no daemon-side LLM required. Downstream consumers (`@byterover/brv-openclaw-plugin` v2 and any future host plugin) get a clean API for agent-driven curate + query.

### Breaking

- **`BrvBridge.persist(text)` is removed at runtime.** The method signature stays on the class so consumers' typed-imports continue to compile, but calling it throws an error pointing at `persistHtml`. The legacy "byterover authors HTML from raw text" flow required an LLM the daemon no longer has; the calling agent must author `<bv-topic>` HTML before invoking the bridge. Migrate to `persistHtml({html, meta?, confirmOverwrite?})`.

- **Query envelope reshape.** `RecallResult.content` is now the concatenation of `matchedDocs[].rendered_md` separated by `\n\n---\n\n`. The legacy `data.result` / `data.content` top-level fields are gone — `recall()` previously fell back to those and silently returned empty under the new CLI envelope. `tier`, `durationMs`, `topScore` are now read from `data.metadata.*`, not `data.*`.

- **`BrvQueryData` type shape** mirrors `QueryToolModeResult` exactly: `{status, matchedDocs[], metadata}`. Callers that imported this type and unpacked top-level metadata fields must move to `data.metadata.*`.

- **`RecallMatchedDoc`** now includes the canonical `format: 'html' | 'markdown'` and `rendered_md: string` fields. Older imports that destructured only `{path, score, title}` continue to compile.

### Added

- **`BrvBridge.persistHtml({html, meta?, confirmOverwrite?}, {cwd?, signal?})`** — drives the curate session protocol internally (one kickoff subprocess + one continuation subprocess). Returns `{status: 'ok', filePath, topicPath, overwrote}` on success or `{status: 'validation-failed', errors}` when the daemon reports validation failure. The bridge does NOT loop internally on validation failure — the calling agent owns retries.

- **`BrvBridge.queryEnvelope(query, {cwd?, signal?, limit?})`** — returns the raw `QueryToolModeResult` envelope for callers that want structured matched-docs (e.g. an agent-facing `brv-query` tool handler returning the envelope verbatim to the LLM). Unlike `recall()`, this throws on subprocess failure rather than swallowing.

- **`RecallOptions.limit`** — passed through as `--limit <n>` to `brv query`.

- **`CurateMeta`** type — operation metadata supplied by the calling agent's LLM (`type`, `impact`, `reason`, `summary`, `previousSummary`, `confidence`). Drives the HITL review pipeline. Mirrors byterover-cli's curate-metadata schema.

- **`PersistHtmlInput` / `PersistHtmlOptions` / `PersistHtmlResult` / `PersistHtmlError`** types — public surface for the new persist API.

- **`QueryToolModeResult` / `QueryToolModeMatchedDoc` / `QueryToolModeMetadata`** types — re-exported so consumers can type their tool handlers without re-declaring the wire shape.

- **`brvCurateKickoff` / `brvCurateContinue`** subprocess helpers in `process.ts` — wraps the 2-call session protocol with the same `runBrv` discipline (timeout, abort signal, stdout cap, NDJSON parsing) as the existing helpers.

### Changed

- **`recall().content`** is the concatenation of `rendered_md` bodies separated by `\n\n---\n\n`. Empty rendered_md entries are filtered out before joining so empty matches don't produce spurious separator lines.

- **`recall()` reads metadata from `data.metadata.*`** — `tier`, `durationMs`, `topScore`. The legacy flat shape (top-level on `data`) is no longer surfaced.

- **`topScore` is only surfaced when `matchedDocs.length > 0`.** Cache hits with stripped metadata report `topScore: 0` from the daemon; the bridge suppresses this to avoid misleading "0 best match" UI annotations.

### Deprecated

- **`PersistOptions` / `PersistResult`** types — kept exported as `@deprecated` for typed-imports without breakage. Disappear in v3.0.

- **`brvCurate` subprocess helper** in `process.ts` — kept for back-compat with any external import; not called by the bridge in v2. Disappears in v3.0 alongside `persist()`.

### Migration

Replace any call to `bridge.persist(text, options)` with:

```ts
// 1. Have the calling agent's LLM author the <bv-topic> HTML first
//    (using whichever tool surface the host exposes — MCP brv-curate,
//    OpenClaw brv-curate, or hand-rolled prompt).
const html = '<bv-topic path="security/auth" title="JWT auth">...</bv-topic>';

// 2. Optionally include operation metadata for HITL surfacing
const meta = {
  type: 'ADD',
  impact: 'high',
  reason: 'Locks JWT signing algorithm; downstream depends on this.',
  summary: 'JWT signing algorithm decision: RS256 over HS256.',
} as const;

// 3. Persist
const result = await bridge.persistHtml({ html, meta }, { cwd });
if (result.status === 'validation-failed') {
  // Agent authors corrected HTML and retries
  for (const error of result.errors) console.error(error.kind, error.message);
}
```

### Compatibility

- **Minimum byterover-cli**: TBD pending M4 (curate-metadata) ship. The bridge plumbs `meta` through to the continuation envelope; an older CLI silently ignores the `meta` field (no review surfacing) but the curate still succeeds.

- **OpenClaw plugin**: requires `@byterover/brv-openclaw-plugin >= 2.0.0` (ENG-2853) for the agent-tool registration path. v1 plugins relying on `bridge.persist()` will fail at runtime; users must update both packages together.
