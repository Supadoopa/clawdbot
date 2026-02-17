import fs from "node:fs/promises";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorFeedbackDaemon, readDaemonState } from "./daemon.js";
import { resolveDaemonStatePath, resolvePendingBundlesDir, resolveProcessedBundlesDir } from "./paths.js";
import type { ErrorBundleProcessor, ErrorFeedbackDaemonOptions } from "./daemon.js";
import type { ErrorFeedbackDaemonState } from "./types.js";

const log = createSubsystemLogger("error-feedback/lifecycle");

let activeDaemon: ErrorFeedbackDaemon | null = null;

/**
 * Start the error feedback daemon as an in-process service.
 *
 * Only one instance can be active at a time. If the daemon is already running,
 * this is a no-op and returns the existing instance.
 */
export async function startErrorFeedbackDaemon(
  options?: ErrorFeedbackDaemonOptions,
): Promise<ErrorFeedbackDaemon> {
  if (activeDaemon) {
    const state = activeDaemon.getState();
    if (state.status === "running") {
      log.info("error feedback daemon is already running");
      return activeDaemon;
    }
  }

  const daemon = new ErrorFeedbackDaemon(options);
  await daemon.start();
  activeDaemon = daemon;
  return daemon;
}

/**
 * Stop the currently running error feedback daemon.
 */
export async function stopErrorFeedbackDaemon(): Promise<void> {
  if (!activeDaemon) {
    log.info("no active error feedback daemon to stop");
    return;
  }

  await activeDaemon.stop();
  activeDaemon = null;
}

/**
 * Get the status of the error feedback daemon.
 * Checks both in-process state and the persisted state file.
 */
export async function getErrorFeedbackDaemonStatus(): Promise<ErrorFeedbackDaemonState> {
  // Check in-process daemon first.
  if (activeDaemon) {
    return activeDaemon.getState();
  }

  // Fall back to persisted state.
  const persisted = await readDaemonState();
  if (persisted) {
    // If the persisted state says "running" but we don't have a live daemon,
    // the daemon likely crashed. Check if the PID is still alive.
    if (persisted.status === "running" && persisted.pid) {
      try {
        // Signal 0 checks process existence without sending a signal.
        process.kill(persisted.pid, 0);
        return persisted;
      } catch {
        // PID doesn't exist; the daemon crashed.
        return {
          ...persisted,
          status: "stopped",
        };
      }
    }
    return persisted;
  }

  return {
    status: "stopped",
    bundlesProcessed: 0,
    bundlesResolved: 0,
    bundlesFailed: 0,
  };
}

/**
 * Ensure the error bundles directory structure exists.
 */
export async function ensureErrorBundleDirs(): Promise<void> {
  await fs.mkdir(resolvePendingBundlesDir(), { recursive: true });
  await fs.mkdir(resolveProcessedBundlesDir(), { recursive: true });
}

/**
 * Clean up processed bundles older than the given age.
 * @param maxAgeMs Maximum age of processed bundles to keep (default: 7 days).
 */
export async function cleanupProcessedBundles(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const processedDir = resolveProcessedBundlesDir();
  let cleaned = 0;

  try {
    const entries = await fs.readdir(processedDir);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = `${processedDir}/${entry}`;
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath);
          cleaned += 1;
        }
      } catch {
        // Ignore stat/unlink errors for individual files.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`cleanup failed: ${formatErrorMessage(err)}`);
    }
  }

  if (cleaned > 0) {
    log.info(`cleaned up ${cleaned} processed bundle(s)`);
  }

  return cleaned;
}

/**
 * Get the active daemon instance (if any). Primarily for testing.
 */
export function getActiveDaemon(): ErrorFeedbackDaemon | null {
  return activeDaemon;
}
