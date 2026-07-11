import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";

const execFileAsync = promisify(execFile);
const processCpuActiveThreshold = 0.1;

export type CodexGoalProcessSnapshotRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly stat?: string;
  readonly cpu: number;
  readonly command: string;
};

export type CodexGoalProcessSnapshot = {
  readonly alive?: boolean;
  readonly cpuActive?: boolean;
  readonly command?: string;
  readonly appServerAlive?: boolean;
  readonly appServerPid?: number;
};

export async function readCodexGoalProcessSnapshotRows(): Promise<
  readonly CodexGoalProcessSnapshotRow[]
> {
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,ppid=,stat=,%cpu=,command=",
  ], { timeout: 1_000 });
  return parseProcessSnapshotRows(stdout);
}

export function inspectCodexGoalProcessSnapshotRows(
  pid: number,
  rows: readonly CodexGoalProcessSnapshotRow[],
): CodexGoalProcessSnapshot {
  return redactProcessSnapshot(summarizeCodexGoalProcessTree(pid, rows));
}

export async function inspectCodexGoalProcessSnapshot(
  pid: number,
): Promise<CodexGoalProcessSnapshot> {
  try {
    const summary = inspectCodexGoalProcessSnapshotRows(
      pid,
      await readCodexGoalProcessSnapshotRows(),
    );
    if (
      summary.alive !== undefined ||
      summary.cpuActive !== undefined ||
      summary.command !== undefined ||
      summary.appServerAlive !== undefined ||
      summary.appServerPid !== undefined
    ) {
      return summary;
    }
  } catch {
    // Fall back to direct pid inspection below.
  }
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "stat=",
      "-o",
      "%cpu=",
      "-o",
      "command=",
    ], { timeout: 1_000 });
    const line = stdout.trim();
    if (!line) return {};
    const match = line.match(/^(\S+)\s+(\S+)\s+([\s\S]*)$/);
    const statText = match?.[1] ?? "";
    if (processStatIsZombie(statText)) {
      const command = match?.[3]?.trim();
      return {
        alive: false,
        cpuActive: false,
        ...(command ? { command: redactStatusText(command) } : {}),
      };
    }
    const cpu = match ? Number(match[2]) : Number.NaN;
    const command = match?.[3]?.trim();
    return {
      alive: true,
      ...(Number.isFinite(cpu) ? { cpuActive: cpu > 0.1 } : {}),
      ...(command ? { command: redactStatusText(command) } : {}),
    };
  } catch {
    return {};
  }
}

function redactProcessSnapshot(
  summary: CodexGoalProcessSnapshot,
): CodexGoalProcessSnapshot {
  return {
    ...(summary.alive === undefined ? {} : { alive: summary.alive }),
    ...(summary.cpuActive === undefined ? {} : { cpuActive: summary.cpuActive }),
    ...(summary.command === undefined
      ? {}
      : { command: redactStatusText(summary.command) }),
    ...(summary.appServerAlive === undefined
      ? {}
      : { appServerAlive: summary.appServerAlive }),
    ...(summary.appServerPid === undefined
      ? {}
      : { appServerPid: summary.appServerPid }),
  };
}

export function summarizeCodexGoalProcessTree(
  rootPid: number,
  rows: readonly CodexGoalProcessSnapshotRow[],
): CodexGoalProcessSnapshot {
  const rowsByParent = new Map<number, CodexGoalProcessSnapshotRow[]>();
  for (const row of rows.filter((item) => !processSnapshotRowIsZombie(item))) {
    const group = rowsByParent.get(row.ppid) ?? [];
    group.push(row);
    rowsByParent.set(row.ppid, group);
  }
  const treeRows: CodexGoalProcessSnapshotRow[] = [];
  const queue = rows.filter((row) => row.pid === rootPid && !processSnapshotRowIsZombie(row));
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    treeRows.push(row);
    queue.push(...(rowsByParent.get(row.pid) ?? []));
  }
  if (treeRows.length === 0) return {};
  const activeRows = treeRows.filter((row) => row.cpu > processCpuActiveThreshold);
  const totalCpu = treeRows.reduce((sum, row) => sum + row.cpu, 0);
  const commandRow = bestProcessCommandRow(activeRows.length > 0 ? activeRows : treeRows);
  const appServerRow = treeRows.find((row) => isCodexAppServerCommand(row.command));
  return {
    alive: true,
    cpuActive: activeRows.length > 0 || totalCpu > processCpuActiveThreshold,
    ...(commandRow?.command ? { command: commandRow.command } : {}),
    appServerAlive: appServerRow !== undefined,
    ...(appServerRow ? { appServerPid: appServerRow.pid } : {}),
  };
}

function isCodexAppServerCommand(command: string): boolean {
  return /\bcodex\b[\s\S]*\bapp-server\b[\s\S]*--listen[\s\S]*stdio:\/\//.test(
    command,
  );
}

function parseProcessSnapshotRows(
  stdout: string,
): readonly CodexGoalProcessSnapshotRow[] {
  return stdout
    .split(/\r?\n/)
    .map((line): CodexGoalProcessSnapshotRow | null => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([0-9.]+)\s*([\s\S]*)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const statText = match[3] ?? "";
      const cpu = Number(match[4]);
      if (
        !Number.isInteger(pid) ||
        !Number.isInteger(ppid) ||
        !Number.isFinite(cpu)
      ) {
        return null;
      }
      return {
        pid,
        ppid,
        stat: statText,
        cpu,
        command: match[5]?.trim() ?? "",
      };
    })
    .filter((row): row is CodexGoalProcessSnapshotRow => row !== null);
}

function processSnapshotRowIsZombie(
  row: CodexGoalProcessSnapshotRow,
): boolean {
  return processStatIsZombie(row.stat) || /\b<defunct>\b/i.test(row.command);
}

function processStatIsZombie(statText: string | undefined): boolean {
  return /\bZ/.test(statText ?? "");
}

function bestProcessCommandRow(
  rows: readonly CodexGoalProcessSnapshotRow[],
): CodexGoalProcessSnapshotRow | undefined {
  return rows.slice().sort((left, right) => {
    const buildScore = Number(isBuildLikeProcessCommand(right.command)) -
      Number(isBuildLikeProcessCommand(left.command));
    if (buildScore !== 0) return buildScore;
    return right.cpu - left.cpu;
  })[0];
}

function isBuildLikeProcessCommand(command: string | undefined): boolean {
  return command === undefined ||
    /\b(build|test|check|lint|tsc|vite|vitest|jest|pytest|cargo|gradle|mvn)\b/i
      .test(command);
}

function redactStatusText(value: string): string {
  return new DefaultRedactor().redact(value);
}
