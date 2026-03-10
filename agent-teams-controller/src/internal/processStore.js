const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const runtimeHelpers = require('./runtimeHelpers.js');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function readProcesses(paths) {
  const rows = readJson(paths.processesPath, []);
  if (!Array.isArray(rows)) return [];
  return rows.filter((entry) => entry && typeof entry === 'object' && Number.isInteger(entry.pid));
}

function writeProcesses(paths, processes) {
  writeJson(paths.processesPath, processes);
}

function listProcesses(paths) {
  const existing = readProcesses(paths);
  const processes = existing.map((entry) => {
    const alive =
      !entry.stoppedAt &&
      Number.isFinite(Number(entry.pid)) &&
      runtimeHelpers.isProcessAlive(Number(entry.pid));

    if (!alive && !entry.stoppedAt) {
      return {
        ...entry,
        stoppedAt: nowIso(),
        alive: false,
      };
    }

    return {
      ...entry,
      alive,
    };
  });

  const changed = processes.some((entry, index) => entry.stoppedAt !== existing[index]?.stoppedAt);
  if (changed) {
    writeProcesses(
      paths,
      processes.map(({ alive, ...rest }) => rest)
    );
  }

  return processes;
}

function registerProcess(paths, flags) {
  const pid = Number(flags.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid pid');
  }

  const label = typeof flags.label === 'string' && flags.label.trim() ? flags.label.trim() : '';
  if (!label) {
    throw new Error('Missing label');
  }

  const list = readProcesses(paths);
  const existingActiveIndex = list.findIndex((entry) => entry.pid === pid && !entry.stoppedAt);
  const existingActive =
    existingActiveIndex >= 0
      ? {
          ...list[existingActiveIndex],
          ...(runtimeHelpers.isProcessAlive(pid) ? {} : { stoppedAt: nowIso() }),
        }
      : null;
  if (existingActiveIndex >= 0 && existingActive && existingActive.stoppedAt) {
    list[existingActiveIndex] = existingActive;
  }
  const now = nowIso();
  const entry = {
    id: existingActive && !existingActive.stoppedAt ? existingActive.id : crypto.randomUUID(),
    label,
    pid,
    ...(flags.port != null ? { port: Number(flags.port) } : {}),
    ...(typeof flags.url === 'string' && flags.url.trim() ? { url: flags.url.trim() } : {}),
    ...(typeof flags['claude-process-id'] === 'string' && flags['claude-process-id'].trim()
      ? { claudeProcessId: flags['claude-process-id'].trim() }
      : {}),
    ...(typeof flags.from === 'string' && flags.from.trim() ? { registeredBy: flags.from.trim() } : {}),
    ...(typeof flags.command === 'string' && flags.command.trim()
      ? { command: flags.command.trim() }
      : {}),
    registeredAt: existingActive && !existingActive.stoppedAt ? existingActive.registeredAt : now,
  };

  if (existingActiveIndex >= 0 && existingActive && !existingActive.stoppedAt) {
    list[existingActiveIndex] = entry;
  } else {
    list.push(entry);
  }

  writeProcesses(paths, list);
  return entry;
}

function stopProcess(paths, flags) {
  const pid = flags.pid != null ? Number(flags.pid) : null;
  const id =
    typeof flags.id === 'string' && flags.id.trim().length > 0 ? flags.id.trim() : null;
  if (!pid && !id) {
    throw new Error('Missing pid or id');
  }

  const list = readProcesses(paths);
  const index = list.findIndex((entry) => {
    if (pid) return entry.pid === pid && !entry.stoppedAt;
    return entry.id === id && !entry.stoppedAt;
  });
  if (index < 0) {
    throw new Error('Process not found');
  }

  list[index] = {
    ...list[index],
    stoppedAt: list[index].stoppedAt || nowIso(),
  };
  writeProcesses(paths, list);
  return list[index];
}

function unregisterProcess(paths, flags) {
  const pid = flags.pid != null ? Number(flags.pid) : null;
  const id =
    typeof flags.id === 'string' && flags.id.trim().length > 0 ? flags.id.trim() : null;
  if (!pid && !id) {
    throw new Error('Missing pid or id');
  }

  const list = readProcesses(paths);
  const next = list.filter((entry) => {
    if (pid) return entry.pid !== pid;
    return entry.id !== id;
  });
  writeProcesses(paths, next);
  return next;
}

module.exports = {
  listProcesses,
  readProcesses,
  registerProcess,
  stopProcess,
  unregisterProcess,
  writeProcesses,
};
