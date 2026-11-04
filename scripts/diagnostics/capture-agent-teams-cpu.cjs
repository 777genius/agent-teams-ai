#!/usr/bin/env node
/**
 * Read-only Agent Teams CPU/RSS capture for macOS and Linux.
 *
 * Usage:
 *   node scripts/diagnostics/capture-agent-teams-cpu.cjs --pid 12345 --duration 30 > cpu.json
 *
 * Select the application's main-process PID. Detached OpenCode/Bun hosts
 * outside this process tree are not included. The script never sends signals,
 * reads team files/arguments/environment variables, or contacts the network.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function parseRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([-\d.,]+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, rawCpu, rss, start, command] = match;
    const cpu = Number(rawCpu.replace(',', '.'));
    if (!Number.isFinite(cpu)) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpu,
      rssMiB: +(Number(rss) / 1024).toFixed(2),
      started: start.replace(/\s+/g, ' ').trim(),
      name: path.basename(command),
    });
  }
  return rows;
}

function descendants(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    const members = children.get(row.ppid) ?? [];
    members.push(row);
    children.set(row.ppid, members);
  }
  const known = new Map(rows.map((row) => [row.pid, row]));
  if (!known.has(rootPid)) return [];
  const result = [];
  const queue = [rootPid];
  const visited = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    if (known.has(pid)) result.push(known.get(pid));
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return result.sort((a, b) => a.pid - b.pid);
}

function parseOptions(argv) {
  const values = Object.create(null);
  if (argv.length % 2) {
    throw Error('Expected --pid PID [--duration SECONDS] [--interval-ms MS]');
  }
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--pid', '--duration', '--interval-ms'].includes(name) || name in values) {
      throw Error('Invalid or duplicate option: ' + name);
    }
    values[name] = argv[i + 1];
  }
  const pid = Number(values['--pid']);
  const duration = values['--duration'] === undefined ? 30 : Number(values['--duration']);
  const intervalMs = values['--interval-ms'] === undefined ? 1000 : Number(values['--interval-ms']);
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('--pid must be a positive integer');
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300) {
    throw Error('--duration must be 1..300 seconds');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 10_000) {
    throw Error('--interval-ms must be 250..10000');
  }
  return { pid, duration, intervalMs };
}

function readTable() {
  return parseRows(
    execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    })
  );
}

async function capture({ pid, duration, intervalMs }, tableReader = readTable) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw Error('Only macOS/Linux supported');
  }
  const startedAt = new Date().toISOString();
  const frames = [];
  const started = process.hrtime.bigint();
  const durationMs = duration * 1000;
  const sampleCount = Math.max(1, Math.ceil(durationMs / intervalMs));
  let rootIdentity = null;
  for (let i = 0; i <= sampleCount; i += 1) {
    const at = new Date().toISOString();
    const rows = tableReader();
    const root = rows.find((row) => row.pid === pid);
    // lstart is only second-precision; parent and executable name provide
    // independent evidence that a recycled PID no longer belongs to this app.
    if (
      rootIdentity &&
      (!root ||
        root.started !== rootIdentity.started ||
        root.ppid !== rootIdentity.ppid ||
        root.name !== rootIdentity.name)
    ) break;
    if (!rootIdentity && root) {
      rootIdentity = { started: root.started, ppid: root.ppid, name: root.name };
    }
    const processes = descendants(rows, pid);
    frames.push({
      at,
      processCount: processes.length,
      totalCpuPercent: +processes.reduce((sum, proc) => sum + proc.cpu, 0).toFixed(1),
      totalRssMiB: +processes.reduce((sum, proc) => sum + proc.rssMiB, 0).toFixed(1),
      processes,
    });
    if (!processes.length) break;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs >= durationMs) break;
    const delayMs = Math.min(intervalMs * (i + 1), durationMs) - elapsedMs;
    if (i < sampleCount && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return {
    title: 'Read-only Agent Teams AI process-tree capture',
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    startedAt,
    completedAt: new Date().toISOString(),
    pid,
    duration,
    intervalMs,
    caveats: [
      'ps CPU% may be smoothed; this is not a JavaScript CPU stack profile',
      'Detached OpenCode/Bun hosts outside the PID tree are excluded',
      'No command-line arguments, team files, or environment variables collected',
      'PID identity combines second-precision start time, parent PID and process name',
    ],
    frames,
  };
}

if (require.main === module) {
  try {
    capture(parseOptions(process.argv.slice(2)))
      .then((data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n'))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseRows, descendants, parseOptions, capture };
