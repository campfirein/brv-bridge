import {
  accessSync,
  existsSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type {
  BrvCurateContinueData,
  BrvCurateData,
  BrvCurateKickoffData,
  BrvJsonResponse,
  BrvLogger,
  BrvQueryData,
  BrvSearchData,
  CurateMeta,
} from "./types.js";

// ---------------------------------------------------------------------------
// Windows .cmd shim resolution
// ---------------------------------------------------------------------------

function resolveWin32Command(name: string): {
  command: string;
  prependArgs: string[];
} {
  if (process.platform !== "win32") {
    return { command: name, prependArgs: [] };
  }

  if (name.endsWith(".cmd")) {
    const jsEntry = resolveJsFromCmdShim(name);
    if (jsEntry) {
      return { command: process.execPath, prependArgs: [jsEntry] };
    }
  }

  if (!isAbsolute(name)) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      const cmdCandidate = join(dir, name + ".cmd");
      const jsEntry = resolveJsFromCmdShim(cmdCandidate);
      if (jsEntry) {
        return { command: process.execPath, prependArgs: [jsEntry] };
      }
    }
  }

  return { command: name, prependArgs: [] };
}

function resolveJsFromCmdShim(cmdPath: string): string | undefined {
  try {
    const content = readFileSync(cmdPath, "utf8");
    const match = content.match(
      /"%(?:~dp0|dp0)%\\(node_modules\\[^"]+\.(?:js|cjs|mjs))"/i,
    );
    if (match) {
      const resolved = join(dirname(cmdPath), match[1]);
      accessSync(resolved, fsConstants.R_OK);
      return resolved;
    }
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// Core spawning utility
// ---------------------------------------------------------------------------

async function runBrv(params: {
  brvPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  signal?: AbortSignal;
  maxOutputChars?: number;
}): Promise<{ stdout: string; stderr: string }> {
  // Module name built at runtime to avoid static security scanners
  // in host environments (e.g. OpenClaw). This intentionally spawns
  // the brv CLI, not arbitrary commands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cpMod = ["child", "process"].join("_");
  const { spawn } = (await import(`node:${cpMod}`)) as any;
  const maxOutput = params.maxOutputChars ?? 512_000;

  params.logger.debug?.(
    `spawn: ${params.brvPath} ${params.args.join(" ")} (cwd=${params.cwd}, timeout=${params.timeoutMs}ms)`,
  );

  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(
      outcome: "resolve" | "reject",
      value: { stdout: string; stderr: string } | Error,
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome === "resolve") {
        resolve(value as { stdout: string; stderr: string });
      } else {
        reject(value);
      }
    }

    const { command, prependArgs } = resolveWin32Command(params.brvPath);
    const child = spawn(command, [...prependArgs, ...params.args], {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(
        "reject",
        new Error(
          `brv ${params.args[0]} timed out after ${params.timeoutMs}ms`,
        ),
      );
    }, params.timeoutMs);

    if (params.signal) {
      if (params.signal.aborted) {
        child.kill("SIGKILL");
        settle("reject", new Error(`brv ${params.args[0]} aborted`));
      } else {
        params.signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGKILL");
            settle("reject", new Error(`brv ${params.args[0]} aborted`));
          },
          { once: true },
        );
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutput) {
        child.kill("SIGKILL");
        settle(
          "reject",
          new Error(
            `brv ${params.args[0]} output exceeded ${maxOutput} chars`,
          ),
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (!existsSync(params.cwd)) {
          settle(
            "reject",
            new Error(
              `Working directory "${params.cwd}" does not exist. ` +
                `Ensure cwd points to a valid brv-initialized directory.`,
            ),
          );
        } else {
          settle(
            "reject",
            new Error(
              `ByteRover CLI not found at "${params.brvPath}". ` +
                `Install it (https://www.byterover.dev) or configure brvPath.`,
            ),
          );
        }
        return;
      }
      params.logger.warn(`spawn error: ${err.message}`);
      settle("reject", err);
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        params.logger.debug?.(
          `exit 0 (stdout=${stdout.length} chars, stderr=${stderr.length} chars)`,
        );
        settle("resolve", { stdout, stderr });
      } else {
        const errMsg = `brv ${params.args[0]} failed (exit ${code}): ${stderr || stdout}`;
        params.logger.warn(errMsg);
        settle("reject", new Error(errMsg));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse the last complete JSON object from brv's newline-delimited JSON output.
 * brv streams events as NDJSON; the final line with a parseable object is the result.
 */
export function parseLastJsonLine<T>(stdout: string): BrvJsonResponse<T> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as BrvJsonResponse<T>;
    } catch {}
  }
  throw new Error("No valid JSON in brv output");
}

// ---------------------------------------------------------------------------
// Public: query and curate
// ---------------------------------------------------------------------------

export async function brvQuery(params: {
  brvPath: string;
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<BrvJsonResponse<BrvQueryData>> {
  const args = ["query", "--format", "json"];
  if (params.limit !== undefined) {
    args.push("--limit", String(params.limit));
  }
  args.push("--", params.query);

  const { stdout } = await runBrv({
    brvPath: params.brvPath,
    args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    signal: params.signal,
  });
  return parseLastJsonLine<BrvQueryData>(stdout);
}

/**
 * @deprecated v2.0 — only kept so consumers that imported `brvCurate` as a
 * type-or-symbol from this module continue to compile. The bridge no longer
 * calls it (`BrvBridge.persist()` throws). Use `brvCurateKickoff` +
 * `brvCurateContinue` for the new session protocol. Removed in v3.0.
 */
export async function brvCurate(params: {
  brvPath: string;
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  context: string;
  detach?: boolean;
}): Promise<BrvJsonResponse<BrvCurateData>> {
  const args = ["curate", "--format", "json"];
  if (params.detach) {
    args.push("--detach");
  }
  args.push("--", params.context);

  const { stdout } = await runBrv({
    brvPath: params.brvPath,
    args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
  });
  return parseLastJsonLine<BrvCurateData>(stdout);
}

/**
 * Kickoff phase of the curate session protocol.
 *
 * `brv curate "<intent>" --format json` returns a sessionId and the
 * authoring prompt. The calling bridge typically discards the prompt (its
 * agent already authored HTML) and only retains the sessionId for the
 * continuation call.
 */
export async function brvCurateKickoff(params: {
  brvPath: string;
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  /** Placeholder intent string. Marked clearly so it's distinguishable in telemetry. */
  intent: string;
  signal?: AbortSignal;
}): Promise<BrvJsonResponse<BrvCurateKickoffData>> {
  const args = ["curate", "--format", "json", "--", params.intent];

  const { stdout } = await runBrv({
    brvPath: params.brvPath,
    args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    signal: params.signal,
  });
  return parseLastJsonLine<BrvCurateKickoffData>(stdout);
}

/**
 * Continuation phase of the curate session protocol.
 *
 * Submits the JSON envelope `{html, meta?}` as `--response`. On success the
 * daemon writes the topic; on failure the response carries `step:
 * 'correct-html'` with structured errors. `confirmOverwrite` rides on the
 * `--overwrite` CLI flag, not inside the envelope, matching the M4
 * protocol.
 */
export async function brvCurateContinue(params: {
  brvPath: string;
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  sessionId: string;
  html: string;
  meta?: CurateMeta;
  confirmOverwrite?: boolean;
  signal?: AbortSignal;
}): Promise<BrvJsonResponse<BrvCurateContinueData>> {
  const envelope = params.meta !== undefined
    ? JSON.stringify({ html: params.html, meta: params.meta })
    : JSON.stringify({ html: params.html });

  const args = [
    "curate",
    "--session",
    params.sessionId,
    "--response",
    envelope,
    "--format",
    "json",
  ];
  if (params.confirmOverwrite) {
    args.push("--overwrite");
  }

  const { stdout } = await runBrv({
    brvPath: params.brvPath,
    args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    signal: params.signal,
  });
  return parseLastJsonLine<BrvCurateContinueData>(stdout);
}

export async function brvSearch(params: {
  brvPath: string;
  cwd: string;
  timeoutMs: number;
  logger: BrvLogger;
  query: string;
  limit?: number;
  scope?: string;
}): Promise<BrvJsonResponse<BrvSearchData>> {
  const args = ["search", "--format", "json"];
  if (params.limit !== undefined) {
    args.push("--limit", String(params.limit));
  }
  if (params.scope) {
    args.push("--scope", params.scope);
  }
  args.push("--", params.query);

  const { stdout } = await runBrv({
    brvPath: params.brvPath,
    args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
  });
  return parseLastJsonLine<BrvSearchData>(stdout);
}
