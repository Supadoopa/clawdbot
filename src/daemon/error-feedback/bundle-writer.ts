import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolvePendingBundlesDir, buildBundleFilename } from "./paths.js";
import type {
  ErrorBundle,
  ErrorBundleContext,
  ErrorBundleEntry,
  ErrorBundleSeverity,
  ErrorBundleSource,
} from "./types.js";

const log = createSubsystemLogger("error-feedback/writer");

const DEFAULT_MAX_RETRIES = 3;

export type WriteErrorBundleParams = {
  source: ErrorBundleSource;
  context?: Partial<ErrorBundleContext>;
  errors: Array<{
    error: unknown;
    severity?: ErrorBundleSeverity;
  }>;
  maxRetries?: number;
};

/**
 * Convert a raw error into a structured ErrorBundleEntry.
 */
function toErrorEntry(
  raw: { error: unknown; severity?: ErrorBundleSeverity },
): ErrorBundleEntry {
  const err = raw.error;
  const message = formatErrorMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const code = extractErrorCode(err);
  const severity = raw.severity ?? "error";

  return { message, stack, severity, code };
}

/**
 * Write an error bundle to the pending directory.
 *
 * This is the primary entry point for skills and agents to report errors
 * that should be picked up by the error feedback daemon.
 */
export async function writeErrorBundle(
  params: WriteErrorBundleParams,
): Promise<ErrorBundle> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const entries = params.errors.map(toErrorEntry);

  const bundle: ErrorBundle = {
    id,
    createdAt: now,
    version: 1,
    source: params.source,
    context: {
      command: params.context?.command,
      workspaceDir: params.context?.workspaceDir,
      environment: params.context?.environment,
      relatedFiles: params.context?.relatedFiles,
      skillContent: params.context?.skillContent,
    },
    errors: entries,
    retryCount: 0,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    processed: false,
  };

  const pendingDir = resolvePendingBundlesDir();
  await fs.mkdir(pendingDir, { recursive: true });

  const filePath = path.join(pendingDir, buildBundleFilename(id));

  // Atomic write: write to tmp then rename to avoid partial reads.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(bundle, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (writeErr) {
    // Clean up tmp file on failure.
    await fs.unlink(tmpPath).catch(() => {});
    throw writeErr;
  }

  log.info(`error bundle written: ${id} (${entries.length} error(s))`, {
    bundleId: id,
    skillName: params.source.skillName,
    agentId: params.source.agentId,
  });

  return bundle;
}

/**
 * Read an error bundle from a file path.
 */
export async function readErrorBundle(filePath: string): Promise<ErrorBundle | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ErrorBundle;
    if (!parsed.id || parsed.version !== 1) {
      log.warn(`invalid error bundle at ${filePath}: missing id or wrong version`);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`failed to read error bundle at ${filePath}: ${formatErrorMessage(err)}`);
    return null;
  }
}

/**
 * List all pending error bundle files.
 */
export async function listPendingBundles(): Promise<string[]> {
  const pendingDir = resolvePendingBundlesDir();
  try {
    const entries = await fs.readdir(pendingDir);
    return entries
      .filter((name) => name.startsWith("error-") && name.endsWith(".json"))
      .map((name) => path.join(pendingDir, name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
