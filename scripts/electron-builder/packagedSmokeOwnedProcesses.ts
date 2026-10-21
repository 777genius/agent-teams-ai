import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';

const MARKER = 'AGENT_TEAMS_PACKAGED_SMOKE_RUN_ID';
const MAX_OWNED = 128;
const MAX_PS_BYTES = 16 * 1024 * 1024;
const MAX_PROC_ENV_BYTES = 1024 * 1024;
const MAX_BASELINE = 4_096;
const MAX_PROC_ENTRIES = 16_384;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
class CensusDeadlineError extends Error {}
class OwnershipDebtError extends Error {}

export interface SmokeProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  birth: string;
  state: string;
}

interface SignalReceipt {
  pid: number;
  birth: string;
  signal: 'SIGTERM' | 'SIGKILL';
  outcome: 'sent' | 'gone';
  at: string;
}

const gone = (error: unknown) =>
  ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
const live = (identity: SmokeProcessIdentity) => !/^[ZX]/.test(identity.state);

/** A per-launch capability, never a job-wide process name or tracking ID. */
export function createPackagedSmokeOwnership(
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}
) {
  const platform = options.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform) || !process.getuid)
    throw new Error('Packaged smoke ownership requires a native POSIX process inventory');
  const uid = process.getuid();
  const marker = randomBytes(24).toString('hex');
  const probeTimeout = options.timeoutMs ?? 2_000;
  if (!Number.isFinite(probeTimeout) || probeTimeout <= 0)
    throw new Error('Invalid packaged smoke ownership timeout');
  const observed = new Map<string, SmokeProcessIdentity>();
  const baseline = new Map<number, string>();
  const signals: SignalReceipt[] = [];
  let leaderPid: number | undefined;

  function budget(deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new CensusDeadlineError('Packaged smoke process census deadline expired');
    return remaining;
  }

  function ps(args: string[], deadline: number, absentAllowed = false): string | undefined {
    const timeout = budget(deadline);
    try {
      return execFileSync('/bin/ps', args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_PS_BYTES,
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // execFileSync errors contain stdout/stderr, including other processes'
      // environments. Never propagate those buffers or attach them as a cause.
      const failure = error as { status?: number; stdout?: string | Buffer; code?: string };
      if (failure.code === 'ETIMEDOUT')
        throw new CensusDeadlineError('Packaged smoke process census deadline expired');
      if (absentAllowed && failure.status === 1 && !String(failure.stdout ?? '').trim())
        return undefined;
      throw new Error('Unable to read bounded packaged smoke process inventory');
    }
  }

  function linuxIdentity(
    pid: number,
    deadline: number,
    requireUser = false
  ): SmokeProcessIdentity | undefined {
    budget(deadline);
    try {
      if (statSync(`/proc/${pid}`).uid !== uid) {
        if (requireUser) throw new Error('Owned process changed user');
        return undefined;
      }
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = raw.lastIndexOf(')');
      const fields = raw
        .slice(end + 2)
        .trim()
        .split(/\s+/);
      if (end < 0 || !/^\d+$/.test(fields[19] ?? ''))
        throw new Error('Malformed packaged smoke process identity');
      const parent = Number(fields[1]);
      const group = Number(fields[2]);
      if (!Number.isInteger(parent) || !Number.isInteger(group) || !fields[0])
        throw new Error('Malformed packaged smoke process metadata');
      return { pid, parent, group, birth: `proc:${fields[19]}`, state: fields[0] };
    } catch (error) {
      if (gone(error)) return undefined;
      throw new Error(`Unable to verify packaged smoke process identity: pid=${pid}`);
    }
  }

  function linuxMarked(
    pid: number,
    deadline: number,
    requireUser = false
  ): SmokeProcessIdentity | undefined {
    const before = linuxIdentity(pid, deadline, requireUser);
    if (!before || !live(before)) return undefined;
    let environment: Buffer;
    let descriptor: number | undefined;
    let stage: 'open' | 'read' | 'limit' = 'open';
    try {
      descriptor = openSync(`/proc/${pid}/environ`, 'r');
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        budget(deadline);
        const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_PROC_ENV_BYTES + 1 - total));
        stage = 'read';
        const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
        if (bytes === 0) break;
        total += bytes;
        if (total > MAX_PROC_ENV_BYTES) {
          stage = 'limit';
          throw new Error('Packaged smoke process environment exceeded its read bound');
        }
        chunks.push(chunk.subarray(0, bytes));
      }
      environment = Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof CensusDeadlineError) throw error;
      if (gone(error)) return undefined;
      throw environmentInspectionError(pid, stage, error);
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (error) {
          throw environmentInspectionError(pid, 'close', error);
        }
      }
    }
    const after = linuxIdentity(pid, deadline, requireUser);
    if (!after || !live(after)) return undefined;
    if (before.birth !== after.birth)
      throw new Error(`Packaged smoke process identity changed during census: pid=${pid}`);
    return environment.toString().split('\0').includes(`${MARKER}=${marker}`) ? after : undefined;
  }

  function environmentInspectionError(
    pid: number,
    stage: 'open' | 'read' | 'limit' | 'close',
    error: unknown
  ) {
    const code = (error as NodeJS.ErrnoException).code;
    const errno =
      typeof code === 'string' &&
      [
        'EACCES',
        'EPERM',
        'EIO',
        'EMFILE',
        'ENFILE',
        'ENOMEM',
        'EBADF',
        'EINVAL',
        'EAGAIN',
      ].includes(code)
        ? code
        : 'UNKNOWN';
    return new Error(
      `Unable to inspect packaged smoke ownership: pid=${pid} stage=${stage} errno=${errno}`
    );
  }

  function linuxProcessIds(deadline: number) {
    budget(deadline);
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      throw new Error('Unable to enumerate packaged smoke process inventory');
    }
    if (entries.length > MAX_PROC_ENTRIES)
      throw new Error('Packaged smoke process inventory exceeded its entry bound');
    return entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  }

  function isPreexisting(identity: SmokeProcessIdentity) {
    return (
      identity.pid !== leaderPid &&
      baseline.get(identity.pid) === identity.birth &&
      !observed.has(`${identity.pid}:${identity.birth}`)
    );
  }

  function parseDarwinMetadata(output: string): SmokeProcessIdentity[] {
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!match || !Number.isFinite(Date.parse(match[6])))
          throw new Error('Malformed packaged smoke Darwin process inventory');
        if (Number(match[2]) !== uid)
          throw new Error('Packaged smoke process inventory crossed its user boundary');
        return {
          pid: Number(match[1]),
          parent: Number(match[3]),
          group: Number(match[4]),
          state: match[5],
          birth: `ps:${match[6]}`,
        };
      });
  }

  const darwinFields = 'pid=,ruid=,ppid=,pgid=,stat=,lstart=';
  function darwinIdentity(pid: number, deadline: number) {
    const output = ps(['-p', String(pid), '-o', darwinFields], deadline, true);
    if (output === undefined) return undefined;
    const identities = parseDarwinMetadata(output);
    if (identities.length !== 1 || identities[0].pid !== pid)
      throw new Error(`Incomplete packaged smoke process identity: pid=${pid}`);
    return identities[0];
  }

  function environmentSuffix(plain: string, expanded: string, pid: number) {
    // Apple's ps appends the environment to argv. Compare the exact plain
    // prefix so an argv containing marker-looking text grants no authority.
    // KERN_PROCARGS2 lookup failures appear as (comm), not a failed ps exit.
    if (
      /^\(.*\)$/.test(plain) ||
      /^\(.*\)$/.test(expanded) ||
      !expanded.startsWith(plain) ||
      (expanded.length > plain.length &&
        !/\s/.test(plain.at(-1) ?? '') &&
        !/\s/.test(expanded[plain.length]))
    )
      throw new Error(`Unverifiable packaged smoke process environment: pid=${pid}`);
    return expanded.slice(plain.length);
  }

  function darwinMarked(pid: number, deadline: number): SmokeProcessIdentity | undefined {
    const before = darwinIdentity(pid, deadline);
    if (!before || !live(before)) return undefined;
    const plain = ps(['-ww', '-p', String(pid), '-o', 'command='], deadline, true);
    const expanded = ps(['-E', '-ww', '-p', String(pid), '-o', 'command='], deadline, true);
    const after = darwinIdentity(pid, deadline);
    if (!after || !live(after)) return undefined;
    if (before.birth !== after.birth)
      throw new Error(`Packaged smoke process identity changed during census: pid=${pid}`);
    if (plain === undefined || expanded === undefined)
      throw new Error(`Incomplete packaged smoke process environment: pid=${pid}`);
    const suffix = environmentSuffix(plain.replace(/\n$/, ''), expanded.replace(/\n$/, ''), pid);
    return suffix.split(/\s+/).includes(`${MARKER}=${marker}`) ? after : undefined;
  }

  function inventory(deadline: number): SmokeProcessIdentity[] {
    if (platform === 'linux') {
      const result: SmokeProcessIdentity[] = [];
      for (const pid of linuxProcessIds(deadline)) {
        if (pid === process.pid) continue;
        const metadata = linuxIdentity(pid, deadline);
        if (!metadata || !live(metadata) || isPreexisting(metadata)) continue;
        const identity = linuxMarked(pid, deadline);
        if (identity) result.push(identity);
      }
      return result;
    }
    // Restrict the environment dump to the real uid. -a/-x would broaden ps
    // selection; bare BSD e also has mode-dependent meaning on macOS.
    const rows = parseDarwinMetadata(ps(['-U', String(uid), '-o', darwinFields], deadline)!);
    const expanded = ps(['-E', '-ww', '-U', String(uid), '-o', 'pid=,command='], deadline)!;
    const commands = new Map<number, string>();
    // Apple's command formatter applies strvis(VIS_TAB | VIS_NL), so embedded
    // argv/environment tabs and newlines are escaped before ps prints rows.
    for (const line of expanded.split('\n').filter((value) => value.trim())) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) throw new Error('Malformed packaged smoke environment census');
      commands.set(Number(match[1]), match[2]);
    }
    const result: SmokeProcessIdentity[] = [];
    for (const identity of rows) {
      budget(deadline);
      if (identity.pid === process.pid || !live(identity)) continue;
      const command = commands.get(identity.pid);
      if (command === undefined || /^\(.*\)$/.test(command)) {
        const current = darwinIdentity(identity.pid, deadline);
        if (current && live(current))
          throw new Error(`Incomplete packaged smoke environment census: pid=${identity.pid}`);
        continue;
      }
      if (!command.split(/\s+/).includes(`${MARKER}=${marker}`)) continue;
      const current = darwinMarked(identity.pid, deadline);
      if (current) result.push(current);
    }
    return result;
  }

  function census(deadline: number) {
    const identities = inventory(deadline);
    if (identities.length > MAX_OWNED)
      throw new Error('Packaged smoke ownership exceeded its process bound');
    const currentKeys = new Set(identities.map((identity) => `${identity.pid}:${identity.birth}`));
    if (new Set([...observed.keys(), ...currentKeys]).size > MAX_OWNED)
      throw new Error('Packaged smoke ownership exceeded its observed process bound');
    // Retain every verified discovery even if reconciliation below finds debt
    // in another process. A wait retry must never forget a newly owned child.
    for (const identity of identities) observed.set(`${identity.pid}:${identity.birth}`, identity);
    for (const expected of observed.values()) {
      if (currentKeys.has(`${expected.pid}:${expected.birth}`)) continue;
      const current =
        platform === 'linux'
          ? linuxIdentity(expected.pid, deadline, true)
          : darwinIdentity(expected.pid, deadline);
      if (current && live(current) && current.birth === expected.birth)
        throw new OwnershipDebtError(
          `Owned packaged smoke process lost verifiable ownership: pid=${expected.pid}`
        );
    }
    budget(deadline);
    return identities;
  }

  const sample = (timeoutMs = probeTimeout) => census(Date.now() + timeoutMs);

  function emit(receipt: Record<string, unknown>) {
    console.log(
      '[packagedSmokeOwnership] ' + JSON.stringify({ ...receipt, at: new Date().toISOString() })
    );
  }

  // This synchronous metadata snapshot completes before the launch capability
  // is exposed. These exact identities cannot have inherited its new marker.
  // Never refresh the baseline after a caller can spawn a marked descendant.
  if (platform === 'linux') {
    const baselineDeadline = Date.now() + probeTimeout;
    const self = linuxIdentity(process.pid, baselineDeadline, true);
    if (!self || !live(self)) throw new Error('Unable to establish packaged smoke harness birth');
    const harnessBirth = BigInt(self.birth.slice('proc:'.length));
    for (const pid of linuxProcessIds(baselineDeadline)) {
      const identity = linuxIdentity(pid, baselineDeadline);
      // Linux birth ticks have finite resolution. A future marked descendant
      // cannot share a tick strictly older than this still-live harness.
      if (identity && BigInt(identity.birth.slice('proc:'.length)) < harnessBirth)
        baseline.set(identity.pid, identity.birth);
      if (baseline.size > MAX_BASELINE)
        throw new Error('Packaged smoke pre-launch baseline exceeded its process bound');
    }
    budget(baselineDeadline);
  }

  return {
    environment: { [MARKER]: marker },
    sample,
    begin(pid?: number) {
      leaderPid = pid;
      // A supplied live leader must still prove its marker, even if a caller
      // incorrectly created this scope after spawning that process.
      if (pid !== undefined) baseline.delete(pid);
      emit({ phase: 'begin', leaderPid });
      const current = sample();
      // An immediately exited/spawn-failed leader is fine; its marked orphans
      // are still discoverable without a first parent-tree snapshot.
      if (pid) {
        const deadline = Date.now() + probeTimeout;
        const identity =
          platform === 'linux' ? linuxIdentity(pid, deadline) : darwinIdentity(pid, deadline);
        if (
          identity &&
          live(identity) &&
          !current.some((entry) => entry.pid === pid && entry.birth === identity.birth)
        )
          throw new Error(`Live packaged smoke leader has no verifiable ownership: pid=${pid}`);
      }
      return current;
    },
    signal(signal: 'SIGTERM' | 'SIGKILL') {
      const deadline = Date.now() + probeTimeout;
      const current = census(deadline);
      if (signals.length + current.length > MAX_OWNED * 2)
        throw new Error('Packaged smoke ownership exceeded its signal receipt bound');
      for (const expected of current) {
        const identity =
          platform === 'linux'
            ? linuxMarked(expected.pid, deadline, true)
            : darwinMarked(expected.pid, deadline);
        if (identity && identity.birth !== expected.birth)
          throw new Error(`Packaged smoke PID changed before signal: pid=${expected.pid}`);
        if (!identity) {
          const stillPresent =
            platform === 'linux'
              ? linuxIdentity(expected.pid, deadline, true)
              : darwinIdentity(expected.pid, deadline);
          if (stillPresent && live(stillPresent))
            throw new Error(`Packaged smoke ownership changed before signal: pid=${expected.pid}`);
        }
        let outcome: SignalReceipt['outcome'] = identity ? 'sent' : 'gone';
        if (identity) {
          budget(deadline);
          try {
            process.kill(identity.pid, signal);
          } catch (error) {
            if (!gone(error))
              throw new Error(`Unable to signal owned packaged smoke process: pid=${identity.pid}`);
            outcome = 'gone';
          }
        }
        signals.push({
          pid: expected.pid,
          birth: expected.birth,
          signal,
          outcome,
          at: new Date().toISOString(),
        });
      }
    },
    async waitForExit(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (census(deadline).length === 0) return true;
        } catch (error) {
          // Reaching this wait's deadline is unsettled, never an empty census.
          // The TERM caller can escalate with a fresh verified inventory; after
          // KILL the same outcome fails cleanup and preserves the sandbox.
          if (error instanceof CensusDeadlineError) return false;
          // Linux can release a retiring process's environment before it is a
          // zombie. A freshly confirmed same-birth/live identity is unresolved
          // debt until a later complete census proves it gone or marked again.
          // Strict sample/signal/finish calls still reject this exact debt.
          if (!(error instanceof OwnershipDebtError)) throw error;
        }
        await pause(Math.min(25, Math.max(0, deadline - Date.now())));
      }
      return false;
    },
    finish() {
      const remaining = sample();
      if (remaining.length) throw new Error('Owned packaged smoke processes remain after cleanup');
      const receipt = {
        phase: 'final',
        leaderPid,
        owned: [...observed.values()],
        remaining,
        signals,
      };
      emit(receipt);
      return receipt;
    },
  };
}
