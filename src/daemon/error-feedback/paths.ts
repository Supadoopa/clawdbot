import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

const ERROR_BUNDLES_DIRNAME = "error-bundles";
const DAEMON_STATE_FILENAME = "error-feedback-daemon.json";
const PENDING_DIRNAME = "pending";
const PROCESSED_DIRNAME = "processed";

/**
 * Root directory for error bundles.
 * Default: `~/.openclaw/error-bundles`
 */
export function resolveErrorBundlesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.OPENCLAW_ERROR_BUNDLES_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveStateDir(env), ERROR_BUNDLES_DIRNAME);
}

/**
 * Directory for pending (unprocessed) error bundles.
 * Default: `~/.openclaw/error-bundles/pending`
 */
export function resolvePendingBundlesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveErrorBundlesDir(env), PENDING_DIRNAME);
}

/**
 * Directory for processed (resolved or failed) error bundles.
 * Default: `~/.openclaw/error-bundles/processed`
 */
export function resolveProcessedBundlesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveErrorBundlesDir(env), PROCESSED_DIRNAME);
}

/**
 * Path to the error feedback daemon state file.
 * Default: `~/.openclaw/error-feedback-daemon.json`
 */
export function resolveDaemonStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), DAEMON_STATE_FILENAME);
}

/**
 * Build a filename for an error bundle.
 * Format: `error-<id>.json`
 */
export function buildBundleFilename(bundleId: string): string {
  return `error-${bundleId}.json`;
}

/**
 * Full path for a pending error bundle.
 */
export function resolvePendingBundlePath(
  bundleId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolvePendingBundlesDir(env), buildBundleFilename(bundleId));
}

/**
 * Full path for a processed error bundle.
 */
export function resolveProcessedBundlePath(
  bundleId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveProcessedBundlesDir(env), buildBundleFilename(bundleId));
}
