import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { ChildProcess } from 'node:child_process';
import type { PendingOwnedProcess } from '../../src/main/utils/ownedProcess/contract';

type GateScenario =
  | 'bootstrap'
  | 'sentinel'
  | 'pre-resume-cancel'
  | 'tree'
  | 'root-first'
  | 'flood'
  | 'breakaway'
  | 'birth-failure'
  | 'accounting-failure'
  | 'release'
  | 'release-delay'
  | 'terminal-race'
  | 'owner-eof'
  | 'broker-crash'
  | 'wrong-generation'
  | 'lost-prepared'
  | 'malformed'
  | 'truncated'
  | 'write-pending-complete'
  | 'write-pending-deadline'
  | 'cleanup';
export type GatePhase =
  | 'start'
  | 'complete'
  | 'sentinel-ready'
  | 'prepare'
  | 'capture-root'
  | 'resume'
  | 'child-lines'
  | 'capture-descendants'
  | 'root-exit'
  | 'nonce-progress'
  | 'stop'
  | 'reconcile'
  | 'witness-exits'
  | 'target-drain'
  | 'release-ack'
  | 'broker-exit'
  | 'loss-dispatch'
  | 'abandon-control'
  | 'helper-exits';
export type HelperRole = 'sentinel' | 'witness' | 'raw-broker' | 'write-fixture';
type CleanupObservation = 'before-private-abandon' | 'after-helper-wait';
interface HelperFacts {
  slot: number;
  role: HelperRole;
  scenario: GateScenario;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  errorObserved: boolean;
  closed: boolean;
  cleanupRequested: boolean;
}
interface NativeGateDiagnostics {
  readonly phase: (phase: GatePhase) => void;
  readonly selectScenario: (scenario: GateScenario) => void;
  readonly runScenario: (scenario: GateScenario, work: () => Promise<void>) => Promise<void>;
  readonly track: (child: ChildProcess, role?: HelperRole) => void;
  readonly retain: (pending: PendingOwnedProcess) => void;
  readonly beginCleanup: () => void;
  readonly observeHelperCleanup: (wait: () => Promise<unknown>) => Promise<void>;
  readonly cleanupRequested: (child: ChildProcess) => void;
  readonly failure: () => void;
}

// Fixture registration and passive observations only; signals and cleanup authority stay in the gate.
export function createNativeGateDiagnostics(
  testChildren: Set<ChildProcess>,
  helperExits: Map<ChildProcess, Promise<void>>,
  pendingCapabilities: Set<PendingOwnedProcess>
): NativeGateDiagnostics {
  const helperFacts = new Map<ChildProcess, HelperFacts>();
  const gateStarted = performance.now();
  let scenario: GateScenario = 'bootstrap';
  let currentPhase: GatePhase = 'start';
  const phase = (next: GatePhase): void => {
    currentPhase = next;
    console.log(
      JSON.stringify({
        nativePhase: {
          scenario,
          phase: next,
          elapsedMs: Math.round(performance.now() - gateStarted),
        },
      })
    );
  };
  const snapshots = (): object => ({
    helperCount: helperExits.size,
    retainedCount: pendingCapabilities.size,
    helpers: Array.from(helperFacts, ([child, facts]) => ({
      ...facts,
      stdoutEnded: child.stdout?.readableEnded,
      stderrEnded: child.stderr?.readableEnded,
      stdoutBuffered: child.stdout?.readableLength,
      stderrBuffered: child.stderr?.readableLength,
    })),
    retainedCapabilities: Array.from(pendingCapabilities, (pending, slot) => ({
      slot,
      diagnostics: pending.diagnostics(),
    })),
  });
  const observeHelper = (child: ChildProcess, role: HelperRole): void => {
    assert.ok(helperFacts.size < 64, 'Bounded fixture helper inventory');
    const facts: HelperFacts = {
      slot: helperFacts.size,
      role,
      scenario,
      errorObserved: false,
      closed: false,
      cleanupRequested: false,
    };
    helperFacts.set(child, facts);
    const observed = (event: 'exit' | 'helper-error' | 'close'): void => {
      console.log(
        JSON.stringify({
          nativeHelper: { ...facts, event, duringScenario: scenario, phase: currentPhase },
        })
      );
    };
    child.once('exit', (code, signal) => {
      facts.exit = { code, signal };
      observed('exit');
    });
    child.once('error', () => {
      facts.errorObserved = true;
      observed('helper-error');
    });
    child.once('close', () => {
      facts.closed = true;
      observed('close');
    });
  };
  const cleanupObservation = (stage: CleanupObservation): void => {
    console.log(JSON.stringify({ cleanupObservation: stage, ...snapshots() }));
  };
  return {
    phase,
    selectScenario: (next) => {
      scenario = next;
    },
    runScenario: async (name, work) => {
      scenario = name;
      phase('start');
      await work();
      phase('complete');
    },
    track: (child, role = 'witness') => {
      if (helperExits.has(child)) return;
      testChildren.add(child);
      helperExits.set(
        child,
        new Promise<void>((done) => {
          child.once('close', () => done());
          child.once('error', () => done());
        })
      );
      observeHelper(child, role);
    },
    retain: (pending) => {
      assert.ok(pendingCapabilities.size < 64, 'Bounded retained fixture capabilities');
      pendingCapabilities.add(pending);
    },
    beginCleanup: () => {
      scenario = 'cleanup';
      phase('abandon-control');
      cleanupObservation('before-private-abandon');
    },
    observeHelperCleanup: async (wait) => {
      phase('helper-exits');
      try {
        await wait();
      } finally {
        cleanupObservation('after-helper-wait');
      }
    },
    cleanupRequested: (child) => {
      const facts = helperFacts.get(child);
      if (facts) facts.cleanupRequested = true;
    },
    failure: () => {
      console.error(
        JSON.stringify({ gateFailure: { scenario, phase: currentPhase, ...snapshots() } })
      );
    },
  };
}
