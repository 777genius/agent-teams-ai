import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertSafeRuntimeZip } from './runtime-archive-extraction.mts';

import { RUNTIME_ARCHIVE_SHA256_PATTERN } from './runtime-archive-checksum.mjs';

const receiptName = '.archive-payload.json';

// This is a copy-integrity receipt for an already checksum-verified archive,
// not a second implementation of the runtime's Cursor capability/manifest gate.
function inventory(root, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    if (!relative && name === receiptName) continue;
    const key = relative ? `${relative}/${name}` : name;
    const file = path.join(root, key);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      entries.push([key, 'directory']);
      entries.push(...inventory(root, key));
    } else if (stat.isFile()) {
      entries.push([key, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    } else {
      throw new Error(`Unsupported runtime archive entry: ${key}`);
    }
  }
  return entries;
}

export function findExtractedBinary(extractDir, binaryName) {
  for (const root of [path.join(extractDir, 'runtime'), extractDir]) {
    const candidate = path.join(root, binaryName);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Extracted runtime archive does not contain ${binaryName}`);
}

export function isRuntimePayloadCacheValid(payloadDir, archiveSha256, binaryName) {
  if (typeof archiveSha256 !== 'string' || !RUNTIME_ARCHIVE_SHA256_PATTERN.test(archiveSha256)) {
    return false;
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(payloadDir, receiptName), 'utf8'));
    return (
      receipt.version === 1 &&
      receipt.archiveSha256 === archiveSha256 &&
      receipt.binaryName === binaryName &&
      fs.lstatSync(path.join(payloadDir, binaryName)).isFile() &&
      JSON.stringify(receipt.entries) === JSON.stringify(inventory(payloadDir))
    );
  } catch {
    return false;
  }
}

// Caller holds the bootstrap lock and verifies archive checksum before entry.
// Publish the entire binary + companions with one directory rename. Retain the
// previous generation until publication succeeds; never expose a partial copy.
export function publishRuntimePayload(extractedBinaryPath, payloadDir, archiveSha256) {
  const binaryName = path.basename(extractedBinaryPath);
  const source = path.dirname(extractedBinaryPath);
  const expectedEntries = inventory(source);
  const stage = `${payloadDir}.stage-${randomUUID()}`;
  const previous = `${payloadDir}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
    if (JSON.stringify(inventory(stage)) !== JSON.stringify(expectedEntries)) {
      throw new Error('Runtime payload changed while copying');
    }
    if (process.platform !== 'win32') fs.chmodSync(path.join(stage, binaryName), 0o755);
    fs.writeFileSync(
      path.join(stage, receiptName),
      JSON.stringify({
        version: 1,
        archiveSha256,
        binaryName,
        entries: expectedEntries,
      })
    );
    if (!isRuntimePayloadCacheValid(stage, archiveSha256, binaryName)) {
      throw new Error('Incomplete staged runtime payload');
    }
    if (fs.existsSync(payloadDir)) {
      fs.renameSync(payloadDir, previous);
      movedPrevious = true;
    }
    try {
      fs.renameSync(stage, payloadDir);
    } catch (error) {
      if (movedPrevious) fs.renameSync(previous, payloadDir);
      throw error;
    }
    if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
    return path.join(payloadDir, binaryName);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function logRuntimePhase(message) {
  process.stderr.write(`[dev-runtime-bootstrap] ${message}\n`);
}

function assertRegularArchiveEntries(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) assertRegularArchiveEntries(file);
    else if (!entry.isFile()) throw new Error(`Unsupported runtime archive entry: ${file}`);
  }
}

export function extractArchive(archivePath, extractDir, archiveKind, runOrExit) {
  if (fs.existsSync(extractDir) && !fs.lstatSync(extractDir).isDirectory()) {
    throw new Error(`Unsupported runtime archive entry: ${extractDir}`);
  }
  fs.mkdirSync(extractDir, { recursive: true });

  if (archiveKind === 'tar.gz') {
    runOrExit('tar', ['-xzf', archivePath, '-C', extractDir]);
    return;
  }

  if (archiveKind === 'zip') {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot;
      if (typeof systemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(systemRoot)) {
        throw new Error('Windows runtime ZIP extraction requires an absolute SystemRoot');
      }
      assertSafeRuntimeZip(archivePath);
      assertRegularArchiveEntries(extractDir);
      const tarPath = path.win32.join(systemRoot, 'System32', 'tar.exe');
      // Windows bsdtar converts argv paths through the active ANSI code page.
      // Inherit the open archive file and let Node set the Unicode cwd instead.
      const archiveFd = fs.openSync(archivePath, 'r');
      try {
        runOrExit(tarPath, ['-xf', '-'], {
          shell: false,
          cwd: extractDir,
          stdio: [archiveFd, 'inherit', 'inherit'],
        });
      } finally {
        fs.closeSync(archiveFd);
      }
      assertRegularArchiveEntries(extractDir);
      return;
    }

    runOrExit('unzip', ['-oq', archivePath, '-d', extractDir]);
    return;
  }

  throw new Error(`Unsupported runtime archive kind: ${archiveKind}`);
}
