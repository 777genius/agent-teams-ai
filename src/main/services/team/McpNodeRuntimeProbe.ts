import { execCli } from '@main/utils/childProcess';

const ELECTRON_NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
// The packaged Electron runtime can lag the source toolchain patch version,
// so MCP launch validation pins the Node 24 runtime line, not .node-version.
const MIN_MCP_NODE_MAJOR_VERSION = 24;
const MAX_MCP_NODE_MAJOR_VERSION = 25;

export const NODE_RUNTIME_PROBE_SCRIPT =
  'process.stdout.write(JSON.stringify({execPath:process.execPath,version:process.versions.node}))';

interface NodeRuntimeProbeMetadata {
  path: string;
  version: string;
}

type PackagedElectronNodeRuntimeProbeResult = { ok: true } | { ok: false; error: unknown };

export interface McpNodeRuntimeProbeOptions {
  onProgress?: (progress: { phase: string; message: string }) => void;
}

let packagedElectronNodeRuntimeProbe: { ok: true } | undefined;
let packagedElectronNodeRuntimeProbeInFlight:
  | Promise<PackagedElectronNodeRuntimeProbeResult>
  | undefined;

export function getPackagedElectronNodeEnv(): Record<string, string> {
  return { [ELECTRON_RUN_AS_NODE_ENV]: '1' };
}

export function parseNodeRuntimeProbeMetadata(
  stdout: string,
  command: string
): NodeRuntimeProbeMetadata {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${command} did not report Node.js runtime metadata`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${command} reported invalid Node.js runtime metadata`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${command} reported invalid Node.js runtime metadata`);
  }

  const metadata = parsed as { execPath?: unknown; version?: unknown };
  const resolvedPath = typeof metadata.execPath === 'string' ? metadata.execPath.trim() : '';
  if (!resolvedPath) {
    throw new Error(`${command} did not report process.execPath`);
  }

  const version = typeof metadata.version === 'string' ? metadata.version.trim() : '';
  if (!version) {
    throw new Error(`${command} did not report process.versions.node`);
  }

  return { path: resolvedPath, version };
}

export function assertSupportedMcpNodeRuntime(
  command: string,
  metadata: NodeRuntimeProbeMetadata
): void {
  const match = /^v?(\d+)(?:\.|$)/.exec(metadata.version.trim());
  const major = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN;
  if (
    !Number.isFinite(major) ||
    major < MIN_MCP_NODE_MAJOR_VERSION ||
    major >= MAX_MCP_NODE_MAJOR_VERSION
  ) {
    throw new Error(
      `${command} resolved ${metadata.path} with Node.js ${metadata.version}; Agent Teams MCP requires Node.js 24.x`
    );
  }
}

export function clearPackagedElectronNodeRuntimeProbe(): void {
  packagedElectronNodeRuntimeProbe = undefined;
  packagedElectronNodeRuntimeProbeInFlight = undefined;
}

function shouldRetryPackagedElectronNodeRuntimeProbe(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    killed?: unknown;
    code?: unknown;
    processOutcomeUnknown?: unknown;
  };
  return (
    candidate.name !== 'AbortError' &&
    candidate.processOutcomeUnknown !== true &&
    (candidate.killed === true || candidate.code === 'EBUSY' || candidate.code === 'ETIMEDOUT')
  );
}

async function runPackagedElectronNodeRuntimeProbe(
  options?: McpNodeRuntimeProbeOptions
): Promise<PackagedElectronNodeRuntimeProbeResult> {
  options?.onProgress?.({
    phase: 'electron-node-runtime',
    message: 'Checking bundled Electron Node runtime...',
  });
  const command = process.execPath.trim();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { stdout } = await execCli(command, ['-e', NODE_RUNTIME_PROBE_SCRIPT], {
        encoding: 'utf-8',
        timeout: ELECTRON_NODE_RUNTIME_PROBE_TIMEOUT_MS,
        env: { ...process.env, ...getPackagedElectronNodeEnv() },
      });
      assertSupportedMcpNodeRuntime(command, parseNodeRuntimeProbeMetadata(stdout, command));
      return { ok: true };
    } catch (error) {
      if (attempt < 2 && shouldRetryPackagedElectronNodeRuntimeProbe(error)) {
        options?.onProgress?.({
          phase: 'electron-node-runtime-retry',
          message: 'Bundled Electron Node runtime check was interrupted; retrying...',
        });
        continue;
      }
      return { ok: false, error };
    }
  }
  return { ok: false, error: new Error('Packaged Electron Node runtime probe did not run') };
}

export async function probePackagedElectronNodeRuntime(
  options?: McpNodeRuntimeProbeOptions
): Promise<PackagedElectronNodeRuntimeProbeResult> {
  if (packagedElectronNodeRuntimeProbe) return packagedElectronNodeRuntimeProbe;
  if (packagedElectronNodeRuntimeProbeInFlight) {
    options?.onProgress?.({
      phase: 'electron-node-runtime-wait',
      message: 'Waiting for bundled Electron Node runtime check...',
    });
    return packagedElectronNodeRuntimeProbeInFlight;
  }

  const probe = runPackagedElectronNodeRuntimeProbe(options);
  packagedElectronNodeRuntimeProbeInFlight = probe;
  try {
    const result = await probe;
    if (result.ok) packagedElectronNodeRuntimeProbe = result;
    return result;
  } finally {
    if (packagedElectronNodeRuntimeProbeInFlight === probe) {
      packagedElectronNodeRuntimeProbeInFlight = undefined;
    }
  }
}
