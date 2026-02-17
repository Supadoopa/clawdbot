import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";

export type ErrorFeedbackCommandAction = "start" | "stop" | "status" | "cleanup";

export async function errorFeedbackCommand(
  params: {
    action: ErrorFeedbackCommandAction;
    json?: boolean;
    pollIntervalMs?: number;
    maxAge?: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const { action } = params;

  switch (action) {
    case "start":
      return startDaemon(params, runtime);
    case "stop":
      return stopDaemon(runtime);
    case "status":
      return showStatus(params, runtime);
    case "cleanup":
      return cleanupBundles(params, runtime);
  }
}

async function startDaemon(
  params: { pollIntervalMs?: number },
  runtime: RuntimeEnv,
): Promise<void> {
  const {
    startErrorFeedbackDaemon,
    ensureErrorBundleDirs,
  } = await import("../daemon/error-feedback/lifecycle.js");

  await ensureErrorBundleDirs();

  const daemon = await startErrorFeedbackDaemon({
    pollIntervalMs: params.pollIntervalMs,
  });

  const state = daemon.getState();
  note(
    [
      `Status: ${state.status}`,
      `Started: ${state.startedAt ?? "unknown"}`,
      `PID: ${state.pid ?? process.pid}`,
    ].join("\n"),
    "Error Feedback Daemon",
  );

  runtime.log("Error feedback daemon started. Watching for error bundles...");
  runtime.log("Press Ctrl+C to stop.");

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      runtime.log("\nShutting down error feedback daemon...");
      const { stopErrorFeedbackDaemon } = await import(
        "../daemon/error-feedback/lifecycle.js"
      );
      await stopErrorFeedbackDaemon();
      resolve();
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}

async function stopDaemon(runtime: RuntimeEnv): Promise<void> {
  const { stopErrorFeedbackDaemon } = await import(
    "../daemon/error-feedback/lifecycle.js"
  );
  await stopErrorFeedbackDaemon();
  runtime.log("Error feedback daemon stopped.");
}

async function showStatus(
  params: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const { getErrorFeedbackDaemonStatus } = await import(
    "../daemon/error-feedback/lifecycle.js"
  );
  const { listPendingBundles } = await import(
    "../daemon/error-feedback/bundle-writer.js"
  );

  const state = await getErrorFeedbackDaemonStatus();
  const pendingFiles = await listPendingBundles();

  if (params.json) {
    runtime.log(JSON.stringify({ ...state, pendingCount: pendingFiles.length }, null, 2));
    return;
  }

  const lines = [
    `Status: ${state.status}`,
    `Started: ${state.startedAt ?? "n/a"}`,
    `Last poll: ${state.lastPollAt ?? "n/a"}`,
    `PID: ${state.pid ?? "n/a"}`,
    "",
    `Bundles processed: ${state.bundlesProcessed}`,
    `Bundles resolved: ${state.bundlesResolved}`,
    `Bundles failed: ${state.bundlesFailed}`,
    `Pending bundles: ${pendingFiles.length}`,
  ];

  note(lines.join("\n"), "Error Feedback Daemon");
}

async function cleanupBundles(
  params: { maxAge?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const { cleanupProcessedBundles } = await import(
    "../daemon/error-feedback/lifecycle.js"
  );

  // Parse max-age (e.g. "7d", "24h", "30m"). Default 7 days.
  let maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (params.maxAge) {
    const match = params.maxAge.match(/^(\d+)([dhm])$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === "d") maxAgeMs = value * 24 * 60 * 60 * 1000;
      else if (unit === "h") maxAgeMs = value * 60 * 60 * 1000;
      else if (unit === "m") maxAgeMs = value * 60 * 1000;
    }
  }

  const cleaned = await cleanupProcessedBundles(maxAgeMs);
  runtime.log(`Cleaned up ${cleaned} processed bundle(s).`);
}
