/**
 * Error bundle types for the error feedback daemon.
 *
 * Error bundles are structured error reports created by Openclaw when a skill
 * or agent execution fails. The error feedback daemon watches for these bundles
 * and relays them to Claude Code for analysis and remediation.
 */

export type ErrorBundleSeverity = "error" | "warning" | "fatal";

export type ErrorBundleSource = {
  /** The skill name that produced the error. */
  skillName?: string;
  /** The agent ID that was running when the error occurred. */
  agentId?: string;
  /** The session key associated with the error. */
  sessionKey?: string;
  /** The cron job ID if this was a scheduled execution. */
  cronJobId?: string;
  /** The channel that initiated the request, if applicable. */
  channel?: string;
};

export type ErrorBundleContext = {
  /** The command or prompt that was being executed. */
  command?: string;
  /** The workspace directory where execution occurred. */
  workspaceDir?: string;
  /** Environment variables relevant to the error (secrets redacted). */
  environment?: Record<string, string>;
  /** File paths involved in the error. */
  relatedFiles?: string[];
  /** The skill file (SKILL.md) content at time of error, if applicable. */
  skillContent?: string;
};

export type ErrorBundleEntry = {
  /** Error message text. */
  message: string;
  /** Stack trace, if available. */
  stack?: string;
  /** Severity of this particular error. */
  severity: ErrorBundleSeverity;
  /** Error code (e.g. ENOENT, ETIMEOUT, etc.). */
  code?: string;
};

export type ErrorBundle = {
  /** Unique identifier for this error bundle. */
  id: string;
  /** ISO-8601 timestamp when the bundle was created. */
  createdAt: string;
  /** The version of the error bundle schema. */
  version: 1;
  /** Source information about what produced the error. */
  source: ErrorBundleSource;
  /** Context surrounding the error. */
  context: ErrorBundleContext;
  /** One or more errors in this bundle. */
  errors: ErrorBundleEntry[];
  /** Number of retry attempts already made for this error. */
  retryCount: number;
  /** Maximum number of retries before giving up. */
  maxRetries: number;
  /** Whether this bundle has been processed by the daemon. */
  processed: boolean;
  /** ISO-8601 timestamp when the bundle was last processed, if applicable. */
  processedAt?: string;
  /** Result of processing, if applicable. */
  resolution?: ErrorBundleResolution;
};

export type ErrorBundleResolution = {
  /** Whether the error was resolved. */
  resolved: boolean;
  /** Description of what was done to resolve (or attempt to resolve) the error. */
  action: string;
  /** Files that were modified as part of the resolution. */
  modifiedFiles?: string[];
  /** Whether a retry was triggered. */
  retryTriggered: boolean;
};

export type ErrorBundleStoreFile = {
  version: 1;
  bundles: ErrorBundle[];
};

/** Status of the error feedback daemon. */
export type ErrorFeedbackDaemonStatus = "running" | "stopped" | "error";

export type ErrorFeedbackDaemonState = {
  status: ErrorFeedbackDaemonStatus;
  startedAt?: string;
  lastPollAt?: string;
  bundlesProcessed: number;
  bundlesResolved: number;
  bundlesFailed: number;
  /** PID of the daemon process, if running as a separate process. */
  pid?: number;
};
