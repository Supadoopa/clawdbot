import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { writeErrorBundle } from "./bundle-writer.js";
import type { ErrorBundleSeverity, ErrorBundleSource, ErrorBundleContext } from "./types.js";

const log = createSubsystemLogger("error-feedback/emit");

/**
 * Emit an error bundle for a failed skill or agent execution.
 *
 * This is a best-effort operation: if bundle writing fails, the error is
 * logged but does not propagate. This ensures error bundle emission never
 * interferes with the primary error flow.
 */
export async function emitErrorBundle(params: {
  source: ErrorBundleSource;
  context?: Partial<ErrorBundleContext>;
  error: unknown;
  severity?: ErrorBundleSeverity;
}): Promise<void> {
  try {
    await writeErrorBundle({
      source: params.source,
      context: params.context,
      errors: [
        {
          error: params.error,
          severity: params.severity ?? "error",
        },
      ],
    });
  } catch (err) {
    log.warn(`failed to emit error bundle: ${formatErrorMessage(err)}`);
  }
}

/**
 * Emit an error bundle for a cron job failure.
 *
 * Extracts source and context information from the cron job parameters.
 */
export async function emitCronJobErrorBundle(params: {
  jobId: string;
  jobName: string;
  agentId?: string;
  sessionKey?: string;
  message?: string;
  workspaceDir?: string;
  error: string;
}): Promise<void> {
  await emitErrorBundle({
    source: {
      skillName: params.jobName,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      cronJobId: params.jobId,
    },
    context: {
      command: params.message,
      workspaceDir: params.workspaceDir,
    },
    error: new Error(params.error),
  });
}

/**
 * Emit an error bundle for a skill execution failure.
 */
export async function emitSkillErrorBundle(params: {
  skillName: string;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  command?: string;
  skillContent?: string;
  relatedFiles?: string[];
  error: unknown;
  severity?: ErrorBundleSeverity;
}): Promise<void> {
  await emitErrorBundle({
    source: {
      skillName: params.skillName,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    },
    context: {
      command: params.command,
      workspaceDir: params.workspaceDir,
      skillContent: params.skillContent,
      relatedFiles: params.relatedFiles,
    },
    error: params.error,
    severity: params.severity,
  });
}
