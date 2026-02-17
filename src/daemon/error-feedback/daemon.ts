import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sleep } from "../../utils.js";
import { readErrorBundle, listPendingBundles } from "./bundle-writer.js";
import {
  resolvePendingBundlesDir,
  resolveProcessedBundlesDir,
  resolveDaemonStatePath,
  buildBundleFilename,
} from "./paths.js";
import type {
  ErrorBundle,
  ErrorBundleResolution,
  ErrorFeedbackDaemonState,
} from "./types.js";

const log = createSubsystemLogger("error-feedback/daemon");

/** Default polling interval when chokidar is not available or as fallback. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Debounce delay after a file event before processing. */
const DEBOUNCE_MS = 500;

/** Maximum bundles to process in a single batch. */
const MAX_BATCH_SIZE = 10;

/** Delay between processing individual bundles to avoid overwhelming the system. */
const INTER_BUNDLE_DELAY_MS = 1_000;

export type ErrorBundleProcessor = (bundle: ErrorBundle) => Promise<ErrorBundleResolution>;

export type ErrorFeedbackDaemonOptions = {
  /** Custom poll interval in ms (fallback when file watching is unavailable). */
  pollIntervalMs?: number;
  /** Custom processor for error bundles. */
  processor?: ErrorBundleProcessor;
  /** Handler called when the daemon processes a bundle (for external integration). */
  onBundleProcessed?: (bundle: ErrorBundle, resolution: ErrorBundleResolution) => void;
  /** Handler called when the daemon encounters an error processing a bundle. */
  onProcessError?: (bundle: ErrorBundle, error: unknown) => void;
};

/**
 * Default processor that formats the error bundle for relay to Claude Code.
 * In production, this is replaced by the actual Claude Code integration that
 * analyzes the errors and updates skill files.
 */
async function defaultProcessor(bundle: ErrorBundle): Promise<ErrorBundleResolution> {
  // Format the error bundle for console output so Claude Code can read it.
  const errorSummary = bundle.errors
    .map((e, i) => {
      let line = `  [${i + 1}] ${e.severity}: ${e.message}`;
      if (e.code) {
        line += ` (${e.code})`;
      }
      if (e.stack) {
        line += `\n      ${e.stack.split("\n").slice(1, 4).join("\n      ")}`;
      }
      return line;
    })
    .join("\n");

  const contextLines: string[] = [];
  if (bundle.source.skillName) {
    contextLines.push(`  skill: ${bundle.source.skillName}`);
  }
  if (bundle.source.agentId) {
    contextLines.push(`  agent: ${bundle.source.agentId}`);
  }
  if (bundle.context.workspaceDir) {
    contextLines.push(`  workspace: ${bundle.context.workspaceDir}`);
  }
  if (bundle.context.command) {
    contextLines.push(`  command: ${bundle.context.command}`);
  }
  if (bundle.context.relatedFiles?.length) {
    contextLines.push(`  files: ${bundle.context.relatedFiles.join(", ")}`);
  }

  const output = [
    `[error-feedback] Error bundle ${bundle.id} (attempt ${bundle.retryCount + 1}/${bundle.maxRetries})`,
    `  created: ${bundle.createdAt}`,
    ...contextLines,
    `  errors:`,
    errorSummary,
  ].join("\n");

  log.info(output);

  // Emit to stdout so Claude Code's session can pick it up.
  console.log(output);

  if (bundle.context.skillContent) {
    console.log(`\n[error-feedback] Skill content at time of error:\n${bundle.context.skillContent}`);
  }

  return {
    resolved: false,
    action: "relayed to Claude Code for analysis",
    retryTriggered: bundle.retryCount < bundle.maxRetries,
  };
}

/**
 * Move a processed bundle from pending to processed directory.
 */
async function moveBundleToProcessed(bundle: ErrorBundle): Promise<void> {
  const processedDir = resolveProcessedBundlesDir();
  await fs.mkdir(processedDir, { recursive: true });

  const srcPath = path.join(resolvePendingBundlesDir(), buildBundleFilename(bundle.id));
  const destPath = path.join(processedDir, buildBundleFilename(bundle.id));

  const updated: ErrorBundle = {
    ...bundle,
    processed: true,
    processedAt: new Date().toISOString(),
  };

  // Write updated bundle to processed dir, then remove from pending.
  await fs.writeFile(destPath, JSON.stringify(updated, null, 2), "utf8");
  await fs.unlink(srcPath).catch(() => {});
}

/**
 * The error feedback daemon.
 *
 * Watches the pending error bundles directory for new bundles,
 * processes them through the configured processor (default: relay to Claude Code),
 * and moves them to the processed directory.
 *
 * Uses chokidar for file watching with a polling fallback.
 */
export class ErrorFeedbackDaemon {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private state: ErrorFeedbackDaemonState;
  private processor: ErrorBundleProcessor;
  private options: ErrorFeedbackDaemonOptions;
  private stopped = false;

  constructor(options: ErrorFeedbackDaemonOptions = {}) {
    this.options = options;
    this.processor = options.processor ?? defaultProcessor;
    this.state = {
      status: "stopped",
      bundlesProcessed: 0,
      bundlesResolved: 0,
      bundlesFailed: 0,
    };
  }

  /** Start the daemon. */
  async start(): Promise<void> {
    if (this.state.status === "running") {
      log.warn("error feedback daemon is already running");
      return;
    }

    this.stopped = false;
    const pendingDir = resolvePendingBundlesDir();
    await fs.mkdir(pendingDir, { recursive: true });

    this.state = {
      status: "running",
      startedAt: new Date().toISOString(),
      bundlesProcessed: 0,
      bundlesResolved: 0,
      bundlesFailed: 0,
      pid: process.pid,
    };

    await this.persistState();

    log.info(`error feedback daemon started, watching: ${pendingDir}`);

    // Set up chokidar watcher for the pending directory.
    try {
      this.watcher = chokidar.watch(pendingDir, {
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: DEBOUNCE_MS,
          pollInterval: 100,
        },
        ignored: [
          /(^|[\\/])\./, // Dotfiles
          /\.tmp$/,      // Temp files from atomic writes
        ],
      });

      this.watcher.on("add", (filePath) => {
        if (!filePath.endsWith(".json")) return;
        this.scheduleBatch();
      });

      this.watcher.on("change", (filePath) => {
        if (!filePath.endsWith(".json")) return;
        this.scheduleBatch();
      });

      this.watcher.on("error", (err) => {
        log.warn(`watcher error: ${formatErrorMessage(err)}`);
      });
    } catch (err) {
      log.warn(`failed to start file watcher, falling back to polling: ${formatErrorMessage(err)}`);
    }

    // Always set up a polling fallback in case file events are missed.
    const pollInterval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => {
      this.scheduleBatch();
    }, pollInterval);

    // Process any already-existing bundles.
    this.scheduleBatch();
  }

  /** Stop the daemon. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.state.status = "stopped";
    await this.persistState();

    log.info("error feedback daemon stopped");
  }

  /** Get the current daemon state. */
  getState(): ErrorFeedbackDaemonState {
    return { ...this.state };
  }

  /** Schedule a batch processing run with debouncing. */
  private scheduleBatch(): void {
    if (this.stopped) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.processBatch();
    }, DEBOUNCE_MS);
  }

  /** Process a batch of pending error bundles. */
  private async processBatch(): Promise<void> {
    if (this.processing || this.stopped) return;

    this.processing = true;
    this.state.lastPollAt = new Date().toISOString();

    try {
      const pendingFiles = await listPendingBundles();
      if (pendingFiles.length === 0) {
        return;
      }

      log.info(`found ${pendingFiles.length} pending error bundle(s)`);

      const batch = pendingFiles.slice(0, MAX_BATCH_SIZE);
      for (const filePath of batch) {
        if (this.stopped) break;

        const bundle = await readErrorBundle(filePath);
        if (!bundle) {
          // Invalid bundle - move the file out of the way.
          const badDir = path.join(resolveProcessedBundlesDir(), "invalid");
          await fs.mkdir(badDir, { recursive: true });
          await fs.rename(filePath, path.join(badDir, path.basename(filePath))).catch(() => {});
          continue;
        }

        if (bundle.processed) {
          // Already processed, move it.
          await moveBundleToProcessed(bundle);
          continue;
        }

        await this.processBundle(bundle);

        // Small delay between bundles.
        if (batch.indexOf(filePath) < batch.length - 1) {
          await sleep(INTER_BUNDLE_DELAY_MS);
        }
      }
    } catch (err) {
      log.error(`batch processing error: ${formatErrorMessage(err)}`);
      this.state.status = "error";
    } finally {
      this.processing = false;
      await this.persistState();
    }
  }

  /** Process a single error bundle. */
  private async processBundle(bundle: ErrorBundle): Promise<void> {
    log.info(`processing error bundle: ${bundle.id}`);

    try {
      const resolution = await this.processor(bundle);

      bundle.resolution = resolution;
      this.state.bundlesProcessed += 1;

      if (resolution.resolved) {
        this.state.bundlesResolved += 1;
        log.info(`bundle ${bundle.id} resolved: ${resolution.action}`);
      } else if (resolution.retryTriggered && bundle.retryCount < bundle.maxRetries) {
        // Increment retry count and leave in pending for the skill to be re-run.
        bundle.retryCount += 1;
        log.info(
          `bundle ${bundle.id} retry triggered (${bundle.retryCount}/${bundle.maxRetries}): ${resolution.action}`,
        );
        // Write updated bundle back to pending directory.
        const pendingPath = path.join(
          resolvePendingBundlesDir(),
          buildBundleFilename(bundle.id),
        );
        await fs.writeFile(pendingPath, JSON.stringify(bundle, null, 2), "utf8");
        return; // Don't move to processed yet.
      } else {
        this.state.bundlesFailed += 1;
        log.warn(`bundle ${bundle.id} not resolved: ${resolution.action}`);
      }

      await moveBundleToProcessed(bundle);
      this.options.onBundleProcessed?.(bundle, resolution);
    } catch (err) {
      this.state.bundlesFailed += 1;
      log.error(`failed to process bundle ${bundle.id}: ${formatErrorMessage(err)}`);
      this.options.onProcessError?.(bundle, err);

      // Move to processed with error resolution.
      bundle.resolution = {
        resolved: false,
        action: `processing failed: ${formatErrorMessage(err)}`,
        retryTriggered: false,
      };
      await moveBundleToProcessed(bundle).catch(() => {});
    }
  }

  /** Persist daemon state to disk. */
  private async persistState(): Promise<void> {
    const statePath = resolveDaemonStatePath();
    try {
      await fs.writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      log.warn(`failed to persist daemon state: ${formatErrorMessage(err)}`);
    }
  }
}

/**
 * Read the daemon state from disk.
 */
export async function readDaemonState(): Promise<ErrorFeedbackDaemonState | null> {
  const statePath = resolveDaemonStatePath();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw) as ErrorFeedbackDaemonState;
  } catch {
    return null;
  }
}
