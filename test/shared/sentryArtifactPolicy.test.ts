import { parseSentryArtifactInventory } from '@shared/utils/sentryArtifactInventory';
import {
  createMainSentryArtifactPolicy,
  createSentryArtifactPolicy,
  guardSentryArtifactEvent,
} from '@shared/utils/sentryArtifactPolicy';
import { redactSentryEvent } from '@shared/utils/sentryConfig';
import { describe, expect, it } from 'vitest';

import raw from '../fixtures/sentry-sdk/renderer-renderer-beforeSend.json';
import early from '../fixtures/sentry-sdk/renderer-renderer-early.json';

const identity = {
  release: 'agent-teams-ai@inventory-sandbox',
  buildId: 'inventory-sandbox',
  gitSha: '1234567890abcdef1234567890abcdef12345678',
};
const root = '/srv/workers/tmp/sentry-sdk-real-envelope-20261006-r6/synthetic app';
const rows = [
  {
    target: 'renderer',
    relativeFile: 'out/renderer/assets/dynamic-DijexZqW.js',
    locator: 'app:///out/renderer/assets/dynamic-DijexZqW.js',
    debugId: '28400e46-bb24-4a22-b91b-c2266ec22b71',
  },
  {
    target: 'renderer',
    relativeFile: 'out/renderer/assets/index-CymqvycE.js',
    locator: 'app:///out/renderer/assets/index-CymqvycE.js',
    debugId: '47825fba-04de-4f60-8738-6ebdb88e86ac',
  },
] as const;
const inventoryJson = JSON.stringify({
  ...identity,
  schemaVersion: 1,
  coverage: { main: 'uncovered', renderer: 'covered', preload: 'uncovered' },
  artifacts: rows,
});
const inventory = parseSentryArtifactInventory(inventoryJson, identity)!;
const policy = createSentryArtifactPolicy([inventory], identity, {
  fileUrl: 'file:///srv/workers/tmp/sentry-sdk-real-envelope-20261006-r6/synthetic%20app/',
  nativePath: root,
  nativeSeparator: '/',
})!;
const result = (event: unknown) => redactSentryEvent(event, policy) as typeof raw;

// FAIL condition: a real SDK pair is lost, or a neighbouring private UUID/path receives its exception.
describe('inventory-bound Sentry metadata', () => {
  it('shows real r6 UUID loss without policy and preserves both genuine pairs with policy', () => {
    expect(
      (redactSentryEvent(raw) as typeof raw).debug_meta.images.map((image) => image.debug_id)
    ).toEqual(['[redacted]', '[redacted]']);
    const output = result(raw);
    expect(output.debug_meta.images).toEqual(
      [rows[1], rows[0]].map((row) => ({
        type: 'sourcemap',
        code_file: row.locator,
        debug_id: row.debugId,
      }))
    );
    expect(output.exception.values[0]!.stacktrace.frames.map((frame) => frame.filename)).toEqual([
      rows[1].locator,
      rows[0].locator,
    ]);
    expect(raw.debug_meta.images[0]!.code_file).toContain('synthetic%20app');
    expect(result(output)).toEqual(output);
  });
  it('maps actual raw transient frames before normalization without inventing IDs', () => {
    const output = guardSentryArtifactEvent(early, policy);
    expect(
      output.exception.values[0]!.stacktrace.frames.map((frame) => [frame.filename, frame.debug_id])
    ).toEqual([
      [rows[1].locator, rows[1].debugId],
      [rows[0].locator, rows[0].debugId],
    ]);
    expect(early.exception.values[0]!.stacktrace.frames[0]!.filename).toContain('file:///');
    const missing = structuredClone(early);
    delete (missing.exception.values[0]!.stacktrace.frames[0] as { debug_id?: string }).debug_id;
    expect(
      guardSentryArtifactEvent(missing, policy).exception.values[0]!.stacktrace.frames[0]
    ).not.toHaveProperty('debug_id');
  });
  // FAIL condition: normal builtin frames vanish, or a builtin lookalike gains artifact/PII trust.
  it.each(['exception', 'threads'] as const)(
    'keeps exact runtime filenames in %s with ordinary redaction, even without inventory',
    (section) => {
      for (const admittedPolicy of [policy, null]) {
        const frame = {
          filename: 'node:internal/process/task_queues',
          abs_path: 'node:internal/process/task_queues',
          debug_id: rows[0].debugId,
          function: 'resume /Users/sdk-sandbox/private.log',
          lineno: 105,
        };
        const input = { [section]: { values: [{ stacktrace: { frames: [frame] } }] } };
        const guarded = guardSentryArtifactEvent(input, admittedPolicy);
        const output = redactSentryEvent(guarded, admittedPolicy) as typeof input;
        expect(output[section].values[0].stacktrace.frames[0]).toEqual({
          filename: 'node:internal/process/task_queues',
          function: 'resume /Users/[redacted]/[redacted-path]',
          lineno: 105,
        });
        expect(policy.artifact(frame.filename)).toBeNull();
        expect(input[section].values[0].stacktrace.frames[0]).toEqual(frame);
        expect(redactSentryEvent(output, admittedPolicy)).toEqual(output);
      }
    }
  );
  it.each([
    'node:internal/process/task_queues?token=private',
    'node:internal/process/task_queues#private',
    'node:internal/process/task_queues/private',
    'node:internal/process/task_queues\n/Users/sdk-sandbox/private',
    'node:internal/process/task_queues%00',
    'node:internal/process/../task_queues',
    'node:internal/process/private_session',
    'node:/Users/sdk-sandbox/private',
    'node:events/secret',
  ])('removes runtime impostor %s and its debug ID', (filename) => {
    const event = {
      exception: {
        values: [{ stacktrace: { frames: [{ filename, debug_id: rows[0].debugId }] } }],
      },
    };
    const output = guardSentryArtifactEvent(event, policy);
    expect(output.exception.values[0].stacktrace.frames[0]).toEqual({});
  });
  it('rejects builtin filenames with conflicting locators and never grants debug image trust', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'node:events', abs_path: rows[0].locator, debug_id: rows[0].debugId },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [{ type: 'sourcemap', code_file: 'node:events', debug_id: rows[0].debugId }],
      },
    };
    const output = guardSentryArtifactEvent(event, policy);
    expect(output.exception.values[0].stacktrace.frames[0]).toEqual({});
    expect(output.debug_meta.images).toEqual([]);
  });
  it.each([
    '../assets/',
    '%2e%2e/assets/',
    '%252e%252e/assets/',
    '%2fassets/',
    '%252fassets/',
    'assets\\',
    'assets/unknown.js?known=',
  ])('removes unconfirmed raw spelling %s before it can normalize', (part) => {
    const event = structuredClone(early);
    const frame = event.exception.values[0]!.stacktrace.frames[0]!;
    frame.filename = 'file://' + root + '/out/renderer/' + part + 'index-CymqvycE.js';
    const guarded = guardSentryArtifactEvent(event, policy).exception.values[0]!.stacktrace
      .frames[0];
    expect(guarded).not.toHaveProperty('filename');
    expect(guarded).not.toHaveProperty('debug_id');
  });
  it.each(['?token=private', '#secret', '/extra', '%00', '%2f', '%252f'])(
    'rejects suffix %s and prefix/userinfo impostors by exact lookup',
    (suffix) => {
      expect(policy.artifact(rows[0].locator + suffix)).toBeNull();
      expect(policy.artifact('app:///prefix/' + rows[0].relativeFile)).toBeNull();
      expect(policy.artifact('file://user@' + root + '/' + rows[0].relativeFile)).toBeNull();
    }
  );
  it('drops invalid/missing/nonstring/mismatched sourcemap pairs but generically redacts other images', () => {
    const event = {
      ...raw,
      debug_meta: {
        images: [
          null,
          { code_file: rows[0].locator, debug_id: rows[0].debugId },
          { type: 'sourcemap', code_file: rows[0].locator, debug_id: rows[1].debugId },
          { type: 'sourcemap', code_file: rows[0].locator },
          { type: 'sourcemap', code_file: 42, debug_id: rows[0].debugId },
          { type: 'native', debug_id: rows[0].debugId, code_file: '/Users/test/private' },
        ],
      },
    };
    expect(result(event).debug_meta.images).toEqual([
      { type: 'native', debug_id: '[redacted]', code_file: '/Users/[redacted]/[redacted-path]' },
    ]);
  });
  it('denies conflicting filename/abs_path and preserves a known frame without an image', () => {
    const event = structuredClone(early);
    Object.assign(event.exception.values[0]!.stacktrace.frames[0]!, { abs_path: rows[0].locator });
    const guarded = guardSentryArtifactEvent(event, policy).exception.values[0]!.stacktrace
      .frames[0];
    expect(guarded).not.toHaveProperty('filename');
    expect(guarded).not.toHaveProperty('abs_path');
    expect(guarded).not.toHaveProperty('debug_id');
    expect(
      result({ exception: raw.exception }).exception.values[0]!.stacktrace.frames[0]!.filename
    ).toBe(rows[1].locator);
  });
  it('keeps metadata exceptions out of extras, breadcrumbs, image siblings and transient final IDs', () => {
    const event = {
      ...raw,
      extra: {
        uuid: rows[0].debugId,
        stacktrace: { frames: [{ abs_path: rows[0].locator, debug_id: rows[0].debugId }] },
      },
      breadcrumbs: [
        {
          debug_meta: {
            images: [
              { type: 'sourcemap', code_file: '/Users/test/private', debug_id: rows[0].debugId },
            ],
          },
        },
      ],
      threads: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: rows[0].locator, abs_path: rows[0].locator, debug_id: rows[0].debugId },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: raw.debug_meta.images.map((image) => ({
          ...image,
          extra_id: rows[0].debugId,
          private_path: '/home/test/secret',
        })),
      },
    };
    const output = redactSentryEvent(event, policy) as typeof event;
    expect(output.extra.uuid).toBe('[redacted]');
    expect(output.extra.stacktrace.frames[0]!.abs_path).toBe('[redacted]');
    expect(JSON.stringify(output.breadcrumbs)).not.toContain(rows[0].debugId);
    expect(output.debug_meta.images[0]!.extra_id).toBe('[redacted]');
    expect(output.debug_meta.images[0]!.private_path).toBe('[redacted]');
    expect(output.threads.values[0]!.stacktrace.frames[0]).toEqual({
      filename: rows[0].locator,
      abs_path: rows[0].locator,
      debug_id: '[redacted]',
    });
    expect(redactSentryEvent(output, policy)).toEqual(output);
  });
  it('fails closed for mismatched build identity/uncovered target and retains generic cycle/depth guards', () => {
    expect(
      createSentryArtifactPolicy(
        [inventory],
        { ...identity, buildId: 'other' },
        { fileUrl: 'file:///test/' }
      )
    ).toBeNull();
    expect(parseSentryArtifactInventory(inventoryJson, { ...identity, gitSha: '' })).toBeNull();
    expect(
      parseSentryArtifactInventory(inventoryJson.replace('"covered"', '"uncovered"'), identity)
    ).toBeNull();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(redactSentryEvent({ extra: cycle }, policy)).toEqual({ extra: { self: '[redacted]' } });
    expect(
      guardSentryArtifactEvent(early, null).exception.values[0]!.stacktrace.frames.every(
        (frame) => !Object.hasOwn(frame, 'filename') && !Object.hasOwn(frame, 'debug_id')
      )
    ).toBe(true);
  });
  it('requires real array containers before granting any frame/image exception', () => {
    const image = raw.debug_meta.images[0]!;
    const malformed = {
      debug_meta: { images: { '0': image } },
      exception: {
        values: {
          '0': {
            stacktrace: {
              frames: {
                '0': {
                  filename: image.code_file,
                  abs_path: rows[1].locator,
                  debug_id: image.debug_id,
                },
              },
            },
          },
        },
      },
      threads: {
        values: [
          {
            stacktrace: {
              frames: { '0': { abs_path: rows[1].locator, debug_id: image.debug_id } },
            },
          },
        ],
      },
    };
    const final = redactSentryEvent(malformed, policy) as typeof malformed;
    expect(final.debug_meta.images['0'].debug_id).toBe('[redacted]');
    expect(final.debug_meta.images['0'].code_file).toBe(image.code_file);
    expect(final.exception.values['0'].stacktrace.frames['0'].abs_path).toBe('[redacted]');
    expect(final.exception.values['0'].stacktrace.frames['0'].filename).toBe(image.code_file);
    expect(final.threads.values[0]!.stacktrace.frames['0'].abs_path).toBe('[redacted]');
    const fakeValues = {
      exception: { values: { '0': { stacktrace: { frames: [{ abs_path: rows[1].locator }] } } } },
    };
    expect(
      (redactSentryEvent(fakeValues, policy) as typeof fakeValues).exception.values['0'].stacktrace
        .frames[0]!.abs_path
    ).toBe('[redacted]');
    const guarded = guardSentryArtifactEvent(malformed, policy);
    expect(guarded.debug_meta).not.toHaveProperty('images');
    expect(guarded.exception).not.toHaveProperty('values');
    expect(guarded.threads.values[0]!.stacktrace).not.toHaveProperty('frames');
    expect(redactSentryEvent(final, policy)).toEqual(final);
  });
  it('closes all main admission on either missing/mismatched/wrong-owner sidecar, while explicit uncovered grants nothing', () => {
    const main = parseSentryArtifactInventory(
      JSON.stringify({
        ...identity,
        schemaVersion: 1,
        coverage: { main: 'covered', renderer: 'uncovered', preload: 'uncovered' },
        artifacts: [
          {
            target: 'main',
            relativeFile: 'dist-electron/main/main.cjs',
            locator: 'app:///dist-electron/main/main.cjs',
            debugId: 'f9ade985-88de-43f0-905a-4de989b52f57',
          },
        ],
      }),
      identity
    )!;
    const roots = {
      fileUrl: 'file:///srv/workers/tmp/sentry-sdk-real-envelope-20261006-r6/synthetic%20app/',
      nativePath: root,
      nativeSeparator: '/' as const,
    };
    expect(createMainSentryArtifactPolicy(null, inventory, identity, roots)).toBeNull();
    expect(createMainSentryArtifactPolicy(main, null, identity, roots)).toBeNull();
    expect(
      createMainSentryArtifactPolicy(main, inventory, { ...identity, buildId: 'different' }, roots)
    ).toBeNull();
    expect(createMainSentryArtifactPolicy(inventory, main, identity, roots)).toBeNull();
    const admitted = createMainSentryArtifactPolicy(main, inventory, identity, roots)!;
    expect(admitted.artifact(root + '/dist-electron/main/main.cjs')?.debugId).toBe(
      'f9ade985-88de-43f0-905a-4de989b52f57'
    );
    expect(admitted.artifact(root + '/' + rows[0].relativeFile)).toBeNull();
    expect(admitted.artifact(roots.fileUrl + rows[0].relativeFile)).toBeNull();
    expect(admitted.artifact(rows[0].locator)?.debugId).toBe(rows[0].debugId);
    const noCoverage = parseSentryArtifactInventory(
      JSON.stringify({
        ...identity,
        schemaVersion: 1,
        coverage: { main: 'uncovered', renderer: 'uncovered', preload: 'uncovered' },
        artifacts: [],
      }),
      identity
    )!;
    const onlyMain = createMainSentryArtifactPolicy(main, noCoverage, identity, roots)!;
    expect(onlyMain.artifact(rows[0].locator)).toBeNull();
    expect(onlyMain.artifact('app:///dist-electron/main/main.cjs')).not.toBeNull();
    expect(createMainSentryArtifactPolicy(noCoverage, noCoverage, identity, roots)).toBeNull();
  });
  it('admits only explicitly supplied Windows/asar spellings; platform runtime proof remains separate', () => {
    const windows = createSentryArtifactPolicy([inventory], identity, {
      fileUrl: 'file:///C:/Program%20Files/Agent/resources/app.asar/',
      nativePath: 'C:\\Program Files\\Agent\\resources\\app.asar',
      nativeSeparator: '\\',
    })!;
    expect(
      windows.artifact(
        'C:\\Program Files\\Agent\\resources\\app.asar\\out\\renderer\\assets\\dynamic-DijexZqW.js'
      )?.debugId
    ).toBe(rows[0].debugId);
    expect(
      windows.artifact(
        'C:\\Program Files\\Agent\\resources\\app.asar\\out\\renderer\\assets\\..\\assets\\dynamic-DijexZqW.js'
      )
    ).toBeNull();
    expect(
      windows.artifact(
        'file:///C:/Program%20Files/Agent/resources/app.asar/' + rows[0].relativeFile
      )?.locator
    ).toBe(rows[0].locator);
  });
});
