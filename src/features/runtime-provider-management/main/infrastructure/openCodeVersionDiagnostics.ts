import { randomUUID } from 'node:crypto';

import { execCli } from '@main/utils/childProcess';
import { APP_VERSION } from '@shared/utils/buildMetadata';
import { createLogger } from '@shared/utils/logger';

import {
  probeOpenCodeBinaryVersion as runOpenCodeBinaryVersionProbe,
  type OpenCodeBinaryVersionProbe,
} from '../application/openCodeVersionDiagnostics';

import type { OpenCodeVersionDiagnosticPorts } from '../application/OpenCodeVersionDiagnosticPorts';

const logger = createLogger('OpenCodeVersionDiagnostics');
const ports: OpenCodeVersionDiagnosticPorts = {
  execute: (binaryPath, args, options) => execCli(binaryPath, [...args], options),
  createReportId: () => `oc-${randomUUID().replaceAll('-', '')}`,
  monotonicNow: () => performance.now(),
  timestampNow: () => new Date().toISOString(),
  metadata: () => ({ appVersion: APP_VERSION, platform: process.platform, arch: process.arch }),
  warn: (message, diagnostics) => logger.warn(message, diagnostics),
};

export async function probeOpenCodeBinaryVersion(
  binaryPath: string
): Promise<OpenCodeBinaryVersionProbe> {
  return runOpenCodeBinaryVersionProbe(binaryPath, ports);
}
