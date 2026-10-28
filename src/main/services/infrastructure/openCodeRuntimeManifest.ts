import { promises as fsp, readFileSync } from 'node:fs';

export const CURRENT_MANIFEST_SCHEMA_VERSION = 1;

export interface OpenCodeRuntimeManifest {
  schemaVersion: 1;
  version: string;
  platformPackage: string;
  binaryPath: string;
  integrity: string;
  installedAt: string;
}

export function parseManifest(value: unknown): OpenCodeRuntimeManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const manifest = value as Partial<OpenCodeRuntimeManifest>;
  if (
    manifest.schemaVersion !== CURRENT_MANIFEST_SCHEMA_VERSION ||
    typeof manifest.version !== 'string' ||
    typeof manifest.platformPackage !== 'string' ||
    typeof manifest.binaryPath !== 'string' ||
    typeof manifest.integrity !== 'string' ||
    typeof manifest.installedAt !== 'string'
  ) {
    return null;
  }
  return manifest as OpenCodeRuntimeManifest;
}

export function readRuntimeManifestSync(file: string): OpenCodeRuntimeManifest | null {
  try {
    const raw = readFileSync(file, 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readRuntimeManifest(file: string): Promise<OpenCodeRuntimeManifest | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}
