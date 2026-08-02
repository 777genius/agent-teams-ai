import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION,
  COORDINATION_EVENT_SCHEMA_VERSION,
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  createCoordinationSnapshotMetadata,
  encodeReplayCursor,
  EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
  HOSTED_COORDINATION_EVENT_STREAM_ROUTE,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  REPLAY_CURSOR_SCHEMA_VERSION,
} from '@features/coordination-events';
import * as coordinationEventsMain from '@features/coordination-events/main';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PURE_COORDINATION_EVENT_PATHS = [
  'src/features/coordination-events/contracts/coordinationEventContracts.ts',
  'src/features/coordination-events/contracts/hostedEventStreamContracts.ts',
  'src/features/coordination-events/core/domain/replayCursor.ts',
  'src/features/coordination-events/core/domain/snapshotEventHandoff.ts',
  'src/features/coordination-events/core/application/ports.ts',
  'src/features/coordination-events/core/application/CoordinationEventHandoff.ts',
] as const;

const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'better-sqlite3',
  'node:',
  '@main/',
  '@renderer/',
  '@preload/',
  'internal-storage',
] as const;

describe('Phase 3 coordination event architecture boundary', () => {
  it('keeps contracts and core free of runtime, storage, transport, and filesystem imports', () => {
    for (const relativePath of PURE_COORDINATION_EVENT_PATHS) {
      // Paths come only from the frozen repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.some((specifier) => specifier === forbidden || specifier.startsWith(forbidden)),
          `${relativePath} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source).not.toMatch(
        /\b(readFile|writeFile|copyFile|rename|createHmac|Database|BrowserWindow|ipcMain)\b/
      );
    }
  });

  it('exposes versioned browser-safe contracts and pure cursor/snapshot behavior publicly', () => {
    expect(COORDINATION_EVENT_SCHEMA_VERSION).toBe(1);
    expect(COORDINATION_SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION).toBe(1);
    expect(REPLAY_CURSOR_SCHEMA_VERSION).toBe(1);
    expect(COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION).toBe(1);
    expect(HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION).toBe(1);
    expect(HOSTED_COORDINATION_EVENT_STREAM_ROUTE).toBe('/api/hosted/v1/events');
    expect(
      encodeReplayCursor({
        deploymentId: 'deployment-1',
        eventEpoch: 'epoch-1',
        eventSequence: 0,
      })
    ).toMatch(/^cev1\./);
    expect(
      createCoordinationSnapshotMetadata({
        watermark: {
          schemaVersion: 1,
          deploymentId: 'deployment-1',
          eventEpoch: 'epoch-1',
          retentionFloorSequence: 0,
          highWatermarkSequence: 0,
        },
        handoffMode: 'lower_barrier',
        revisionVector: [],
      })
    ).toMatchObject({ schemaVersion: 1, handoffMode: 'lower_barrier' });
  });

  it('defines only durable-journal and lossy wake-up ports for live coordination', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const portsSource = readFileSync(
      resolve(ROOT, 'src/features/coordination-events/core/application/ports.ts'),
      'utf8'
    );
    expect(portsSource).toContain('interface CoordinationEventJournal');
    expect(portsSource).toContain('interface CoordinationEventWakeup');
    expect(portsSource).not.toContain('SnapshotRetentionLease');
    expect(portsSource).not.toContain('RecoveryPointParticipant');
    expect(portsSource).not.toContain('class ');
    expect(portsSource).not.toContain('sqlite');
  });

  it('orders durable event append before the lossy live wake-up', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const applicationSource = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-events/core/application/CoordinationEventHandoff.ts'
      ),
      'utf8'
    );
    const appendIndex = applicationSource.indexOf('this.journal.appendCommittedEvent');
    const wakeupIndex = applicationSource.indexOf('this.wakeup.notifyCommittedEvent');
    expect(appendIndex).toBeGreaterThan(-1);
    expect(wakeupIndex).toBeGreaterThan(appendIndex);
    expect(applicationSource).not.toContain('Promise.all([');
  });

  it('keeps SQLite composition main-owned and exports only the narrow feature factory', () => {
    const mainPaths = [
      'src/features/coordination-events/main/adapters/output/SqliteCoordinationEventJournal.ts',
      'src/features/coordination-events/main/composition/createCoordinationEventsFeature.ts',
    ] as const;
    for (const relativePath of mainPaths) {
      // Paths come only from the fixed repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(true);
    }
    // This resolves one fixed repository-owned public entrypoint.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainEntrypoint = readFileSync(
      resolve(ROOT, 'src/features/coordination-events/main/index.ts'),
      'utf8'
    );
    expect(mainEntrypoint).toContain(
      "export * from './composition/createCoordinationEventsFeature'"
    );
    expect(mainEntrypoint).not.toMatch(
      /adapters|infrastructure|Fastify|HostedCoordinationEventStream|InProcessCoordinationEventWakeupHub|SqliteCoordinationEventJournal/
    );
    expect(Object.keys(coordinationEventsMain)).toEqual(['createCoordinationEventsFeature']);
    // This resolves one fixed repository-owned composition root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const composition = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-events/main/composition/createCoordinationEventsFeature.ts'
      ),
      'utf8'
    );
    expect(composition).not.toMatch(/return Object\.freeze\(\{\s*(?:journal|wakeup)/);
    expect(composition).not.toMatch(/retentionLeases|recoveryPointParticipant/);
  });

  it('keeps authenticated hosted SSE main-owned and listen-before-replay ordered', () => {
    const hostedPaths = [
      'src/features/coordination-events/main/adapters/input/http/HostedCoordinationEventStreamController.ts',
      'src/features/coordination-events/main/infrastructure/InProcessCoordinationEventWakeupHub.ts',
      'src/features/coordination-events/main/composition/createHostedCoordinationEventStream.ts',
    ] as const;
    for (const relativePath of hostedPaths) {
      // Paths come only from the fixed repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(true);
    }
    // This resolves one fixed repository-owned input adapter.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const controller = readFileSync(resolve(ROOT, hostedPaths[0]), 'utf8');
    const handle = controller.slice(controller.indexOf('private async handle'));
    const origin = handle.indexOf('request.headers.origin');
    const authorize = handle.indexOf('this.options.authorizer.authorize');
    const abortListener = handle.indexOf("request.raw.once('aborted'");
    const activeClose = handle.indexOf('this.activeStreams.add(closeStream)');
    const subscribe = handle.indexOf('this.options.wakeups.subscribe');
    const firstReplay = handle.indexOf('this.options.replay.replay');
    const publicHeaders = handle.indexOf('reply.raw.writeHead');
    expect(origin).toBeGreaterThan(-1);
    expect(abortListener).toBeGreaterThan(origin);
    expect(activeClose).toBeGreaterThan(abortListener);
    expect(authorize).toBeGreaterThan(activeClose);
    expect(subscribe).toBeGreaterThan(authorize);
    expect(firstReplay).toBeGreaterThan(subscribe);
    expect(publicHeaders).toBeGreaterThan(firstReplay);
    expect(controller).toContain('firstReplayWakeVersion = wakeSignal.version');
    expect(controller).toContain('invokeUnlessAborted');
    expect(controller).toContain('rawConnectionClosed');
    expect(controller).toContain('projection.publicPayload');
    expect(controller).not.toMatch(/localStorage|WebSocket|command replay/i);
  });

  it('keeps the entity-agnostic renderer reconciler transport and framework free', () => {
    const rendererPaths = [
      'src/features/team-console/renderer/ports/TeamTransportReconcilerPorts.ts',
      'src/features/team-console/renderer/reconciliation/TeamTransportReconciler.ts',
      'src/features/team-console/renderer/index.ts',
    ] as const;
    for (const relativePath of rendererPaths) {
      // Paths come only from the fixed repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).not.toMatch(
        /\b(?:localStorage|sessionStorage|EventSource|WebSocket|fetch|setTimeout|setInterval)\b/
      );
      expect(source).not.toMatch(
        /(?:from\s+['"](?:react|zustand|@renderer\/store)|commandReplay)/i
      );
    }
    // This resolves one fixed repository-owned reconciler implementation.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const reconciler = readFileSync(resolve(ROOT, rendererPaths[1]), 'utf8');
    expect(reconciler).toContain('MAX_REBOOTSTRAPS = 1');
    expect(reconciler).toContain('previousEventCursor !== this.eventCursor');
    expect(reconciler).toContain('processedEventIds');
    expect(reconciler).toContain('revisionVector');
    expect(reconciler).toContain('commitIfCurrent');
  });
});
