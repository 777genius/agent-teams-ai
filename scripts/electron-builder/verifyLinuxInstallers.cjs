#!/usr/bin/env node
/* global Buffer, console, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function fail(message) {
  console.error(`[verifyLinuxInstallers] ${message}`);
  process.exit(1);
}

function run(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: input ? undefined : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr || '';
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '', 'utf8');
}

function readArMember(archivePath, memberName) {
  return execFileSync('ar', ['p', archivePath, memberName], {
    maxBuffer: 128 * 1024 * 1024,
  });
}

function getTarCompressionFlag(memberName) {
  if (memberName.endsWith('.tar.xz')) return 'J';
  if (memberName.endsWith('.tar.gz')) return 'z';
  if (memberName.endsWith('.tar.bz2')) return 'j';
  fail(`Unsupported deb tar member compression: ${memberName}`);
}

function getDebMember(archivePath, prefix) {
  const members = execFileSync('ar', ['t', archivePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const member = members.find((entry) => entry.startsWith(prefix));
  if (!member) {
    fail(`Missing ${prefix} member in ${archivePath}`);
  }
  return member;
}

function runDebTar(archivePath, memberName, tarMode, filePath) {
  const args = filePath
    ? [
        '-c',
        'set -euo pipefail; ar p "$1" "$2" | tar "$3" - "$4"',
        'bash',
        archivePath,
        memberName,
        tarMode,
        filePath,
      ]
    : [
        '-c',
        'set -euo pipefail; ar p "$1" "$2" | tar "$3" -',
        'bash',
        archivePath,
        memberName,
        tarMode,
      ];
  return execFileSync('bash', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function listDebTar(archivePath, memberName, verbose = false) {
  const flag = getTarCompressionFlag(memberName);
  const mode = verbose ? `-tv${flag}f` : `-t${flag}f`;
  return runDebTar(archivePath, memberName, mode);
}

function extractDebTarFile(archivePath, memberName, filePath) {
  const flag = getTarCompressionFlag(memberName);
  return runDebTar(archivePath, memberName, `-xO${flag}f`, filePath);
}

function listTar(tarBuffer, memberName, verbose = false) {
  const flag = getTarCompressionFlag(memberName);
  const mode = verbose ? `-tv${flag}f` : `-t${flag}f`;
  return run('tar', [mode, '-'], tarBuffer).toString('utf8');
}

function extractTarFile(tarBuffer, memberName, filePath) {
  const flag = getTarCompressionFlag(memberName);
  return run('tar', [`-xO${flag}f`, '-', filePath], tarBuffer).toString('utf8');
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`${label} does not contain ${needle}`);
  }
}

function verifyDeb(debPath) {
  const dataMember = getDebMember(debPath, 'data.tar.');
  const controlMember = getDebMember(debPath, 'control.tar.');
  const control = readArMember(debPath, controlMember);
  const dataList = listDebTar(debPath, dataMember);
  const dataVerboseList = listDebTar(debPath, dataMember, true);

  assertContains(dataList, './usr/bin/agent-teams-ai\n', path.basename(debPath));
  assertContains(dataList, './opt/Agent-Teams-AI/agent-teams-ai\n', path.basename(debPath));
  assertContains(dataList, './opt/Agent-Teams-AI/chrome-sandbox\n', path.basename(debPath));

  const launcherLine = dataVerboseList
    .split(/\r?\n/)
    .find((line) => line.endsWith('./usr/bin/agent-teams-ai'));
  if (!launcherLine || !launcherLine.startsWith('-rwx')) {
    fail(`/usr/bin/agent-teams-ai is not executable in ${debPath}`);
  }

  const launcher = extractDebTarFile(debPath, dataMember, './usr/bin/agent-teams-ai');
  assertContains(launcher, '/opt/Agent-Teams-AI/agent-teams-ai', 'CLI launcher');
  if (launcher.includes('--no-sandbox')) {
    fail('CLI launcher must not force --no-sandbox');
  }

  const postinst = extractTarFile(control, controlMember, './postinst');
  assertContains(postinst, 'SANDBOX_PATH="/opt/Agent-Teams-AI/chrome-sandbox"', 'deb postinst');
  assertContains(postinst, 'chmod 4755 "$SANDBOX_PATH"', 'deb postinst');
}

function main() {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  if (!fs.existsSync(releaseDir)) {
    fail(`Release directory does not exist: ${releaseDir}`);
  }

  const debs = fs
    .readdirSync(releaseDir)
    .filter((entry) => entry.endsWith('.deb'))
    .map((entry) => path.join(releaseDir, entry));
  if (debs.length === 0) {
    fail(`No .deb packages found in ${releaseDir}`);
  }

  for (const deb of debs) {
    verifyDeb(deb);
    console.log(`[verifyLinuxInstallers] OK ${path.basename(deb)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

module.exports = {
  _internal: {
    extractTarFile,
    getDebMember,
    listTar,
    verifyDeb,
  },
};
