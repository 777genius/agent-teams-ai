'use strict';
/**
 * The one command the denying fixture runtime of the desktop E2Es answers.
 *
 * On Windows the app runs an OpenCode startup cleanup through the runtime bridge
 * (`runtime opencode-command --json --input <file> [--output <file>]`, command
 * `opencode.cleanupStartupHosts`). Until it reports "drained", the launch gate refuses every
 * launch (OpenCodeStartupSweepGate: on Windows a launch cannot wait, so it is refused). A
 * runtime that denies everything therefore blocks every launch of the session. The honest
 * answer for a sandbox with no OpenCode hosts is "nothing to clean, drained, complete".
 *
 * Everything else, on every platform, stays denied by the fixture. Linux and macOS never get
 * this answer: their start-up path does not depend on it.
 */
const fs = require('node:fs');

/** The success result the bridge client validates (schemaVersion, request and command echo). */
function buildStartupCleanupReply(envelope, now = new Date()) {
  return {
    ok: true,
    schemaVersion: envelope.schemaVersion,
    requestId: envelope.requestId,
    command: envelope.command,
    completedAt: now.toISOString(),
    durationMs: 1,
    runtime: {
      providerId: 'opencode',
      binaryPath: null,
      binaryFingerprint: null,
      version: null,
      capabilitySnapshotId: null,
    },
    diagnostics: [],
    data: {
      cleaned: 0,
      remaining: 0,
      hosts: [],
      diagnostics: [],
      startupCleanup: { completion: 'drained', coverage: 'complete', survivingPids: [] },
    },
  };
}

/**
 * The reply for a runtime invocation, or null when the invocation is not the startup cleanup
 * (or the platform is not Windows). `outputPath` is where the client also looks for the result.
 */
function answerStartupCleanup(args, platform = process.platform) {
  if (platform !== 'win32') return null;
  if (args[0] !== 'runtime' || args[1] !== 'opencode-command') return null;
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const inputPath = flag('--input');
  if (!inputPath) return null;
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch {
    return null;
  }
  if (!envelope || envelope.command !== 'opencode.cleanupStartupHosts') return null;
  return {
    line: JSON.stringify(buildStartupCleanupReply(envelope)),
    outputPath: flag('--output'),
  };
}

module.exports = { answerStartupCleanup, buildStartupCleanupReply };
