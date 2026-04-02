# brv-bridge

Standard interface for connecting agent frameworks to [ByteRover](https://www.byterover.dev)'s Context Tree.

Any agent harness that implements the bridge gets context sharing for free - recall curated knowledge before a turn, persist new knowledge after a turn.

## Install

```bash
npm install @byterover/brv-bridge
```

**Prerequisites:** [ByteRover CLI](https://www.byterover.dev) installed and a space initialized.

## Usage

```typescript
import { BrvBridge } from "@byterover/brv-bridge";

const bridge = new BrvBridge({ cwd: "/path/to/project" });

// Check if brv is set up
if (await bridge.ready()) {
  // Retrieve relevant context
  const { content } = await bridge.recall("what did we decide about auth?");

  // Store knowledge
  await bridge.persist("User prefers JWT over session cookies");
}

// Clean up
await bridge.shutdown();
```

## API

### `new BrvBridge(config)`

| Option | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Working directory with `.brv/` initialized |
| `brvPath` | `string` | `"brv"` | Path to the brv binary |
| `recallTimeoutMs` | `number` | `10000` | Timeout for recall operations |
| `persistTimeoutMs` | `number` | `60000` | Timeout for persist operations |
| `logger` | `BrvLogger` | no-op | Logger instance |

### `bridge.ready(): Promise<boolean>`

Check if the bridge is configured — verifies `cwd` exists and has a `.brv` directory. Does not make network calls.

### `bridge.recall(query, options?): Promise<RecallResult>`

Retrieve relevant context from the Context Tree. Returns `{ content: "" }` on failure — never throws.

Options: `signal` (AbortSignal), `cwd` (override per-call).

### `bridge.persist(context, options?): Promise<PersistResult>`

Store context into the Context Tree. Defaults to detach mode (fire-and-forget). Returns `{ status, message? }`.

Options: `detach` (default `true`), `cwd` (override per-call).

### `bridge.shutdown(): Promise<void>`

Clean up resources. Adapters should call this for forward compatibility.

## For adapter authors

The bridge is designed to be wrapped by framework-specific adapters. Each adapter maps its framework's lifecycle hooks to `recall()` and `persist()`:

```typescript
// OpenClaw adapter example
class ByteRoverContextEngine {
  private bridge = new BrvBridge({ cwd, logger });

  async assemble(params) {
    const { content } = await this.bridge.recall(query);
    // inject content into system prompt
  }

  async afterTurn(params) {
    await this.bridge.persist(serializedConversation);
  }
}
```

## License

[Elastic License 2.0 (ELv2)](./LICENSE)
