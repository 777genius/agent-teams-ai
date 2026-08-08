import { encodeIntent, fingerprintIntent, resolveClaim } from './model.mjs';

const FIXTURE_KEY_V1 = 'phase-0-w5-public-fixture-key-v1';
const FIXTURE_KEY_V2 = 'phase-0-w5-public-fixture-key-v2';

export function buildEventInventory() {
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.EVENT_CURSOR_INVENTORY',
    observedAtSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    surfaces: [
      {
        id: 'generic-http-sse',
        source: 'src/main/http/events.ts:13',
        producer: 'HttpServer.broadcast callers',
        consumer: 'HttpAPIClient EventSource',
        cursor: 'none',
        durability: 'module-global in-memory Set<FastifyReply>',
        replay: 'none',
        scope: 'all connected clients',
        finding:
          'No id/eventId/journal/Last-Event-ID handling; disconnect or commit-before-fanout loses the notification.',
      },
      {
        id: 'browser-eventsource',
        source: 'src/renderer/api/httpClient.ts:176',
        producer: '/api/events',
        consumer: 'renderer channel listeners',
        cursor: 'browser transport only; server emits no id',
        durability: 'none',
        replay: 'automatic reconnect cannot replay without server IDs/journal',
        scope: 'one global route',
        finding:
          'JSON callbacks have no event identity, resource revision, subscription locator, gap detection, or resync path.',
      },
      {
        id: 'team-file-watcher-ipc-and-sse',
        source: 'src/main/index.ts:1504',
        producer: 'FileWatcher/team reconciliation',
        consumer: 'Electron renderer and generic HTTP broadcast',
        cursor: 'none',
        durability: 'filesystem remains authority; watcher event is a hint',
        replay: 'periodic/focused refresh only',
        scope: 'teamName/type payload',
        finding:
          'Forwarding precedes no durable event row and carries no source generation/fileWriterEpoch.',
      },
      {
        id: 'renderer-team-reconciler',
        source: 'src/renderer/store/index.ts:1620',
        producer: 'onTeamChange and provisioning progress callbacks',
        consumer: 'Zustand team state',
        cursor: 'none',
        durability: 'memory cache',
        replay: 'throttled refresh and fallback polling',
        scope: 'teamName plus partial runId guards',
        finding:
          'Some stale-run guards exist, but no eventId dedupe, opaque epoch cursor, revision vector, or snapshot barrier.',
      },
      {
        id: 'opencode-runtime-delivery-journal',
        source: 'src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts:7',
        producer: 'runtime delivery service',
        consumer: 'delivery recovery/status',
        cursor: 'none',
        durability: 'versioned JSON store with lock',
        replay: 'resume pending by key/payload hash',
        scope: 'key/runId/teamName',
        finding:
          'Rejects payload conflict and records committed location, but uses unversioned stable hash and retries pending without an ADR-34 per-effect evidence class.',
      },
      {
        id: 'opencode-prompt-delivery-ledger',
        source: 'src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts:11',
        producer: 'OpenCode inbox delivery/watchdog',
        consumer: 'delivery status and repair',
        cursor: 'provider pre/post prompt cursors, not application event cursor',
        durability: 'versioned JSON store',
        replay: 'bounded retry/watchdog states',
        scope: 'team/member/lane/run/message',
        finding:
          'Rich acceptanceUnknown/evidence exists, but payloadHash is not a versioned normalized-intent HMAC and provider cursors cannot be used as the hosted event barrier.',
      },
      {
        id: 'opencode-bridge-command-ledger',
        source: 'src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore.ts:7',
        producer: 'state-changing bridge command service',
        consumer: 'bridge commandStatus recovery',
        cursor: 'none',
        durability: 'versioned JSON store',
        replay: 'completed duplicate resolves via status; unknown timeout blocks retry',
        scope: 'generated idempotency key',
        finding:
          'Correctly refuses blind retry after unknown timeout, but requestHash includes raw body and lacks descriptor/schema/fingerprint/key versions and stable actor scope.',
      },
      {
        id: 'runtime-control-event-sink',
        source: 'src/main/services/team/runtime-control/RuntimeControlService.ts:154',
        producer: 'provider ack',
        consumer: 'optional runtime event sink',
        cursor: 'provider/runtime event identity only',
        durability: 'sink-dependent and invoked after provider action',
        replay: 'provider-specific',
        scope: 'run/lane/idempotency key',
        finding:
          'Action completes before eventSink.record; crash between them demonstrates why hosted state/outbox must be durable before live fanout.',
      },
    ],
    requiredTargetContract: {
      cursor: 'opaque deploymentId/eventEpoch/eventSequence',
      snapshot: 'same-transaction cursor or retained lower C0 plus revision vector',
      delivery:
        'listener-before-query durable journal replay with heartbeat/high-watermark requery',
      reducer: 'eventId dedupe plus aggregate generation/revision fencing; gaps refetch',
      externalFiles:
        'watch-before-scan, source hash/generation, observation sequence, fileWriterEpoch',
    },
    conclusion:
      'Current generic HTTP/team-change flow is a lossy notification path and cannot satisfy ADR-33. Existing provider journals are useful salvage evidence, not a hosted event cursor.',
  };
}

export function buildFingerprintGoldens(oracle) {
  const materializeLaunchDefaults = (input) => ({
    teamId: input.teamId,
    providerPlanDigest: input.providerPlanDigest,
    effort: input.effort ?? 'medium',
    fast: input.fast ?? false,
  });
  const cases = [
    {
      id: 'send-v1-field-order-a',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_01',
        contentDigest: 'sha256:aaaa',
        attachmentDigests: [],
      },
    },
    {
      id: 'send-v1-field-order-b',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        attachmentDigests: [],
        contentDigest: 'sha256:aaaa',
        messageId: 'msg_01',
        teamId: 'team_01',
      },
    },
    {
      id: 'send-v1-changed-intent',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_01',
        contentDigest: 'sha256:bbbb',
        attachmentDigests: [],
      },
    },
    {
      id: 'send-v1-ordered-attachment-array',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_02',
        contentDigest: 'sha256:eeee',
        attachmentDigests: ['sha256:one', 'sha256:two'],
      },
    },
    {
      id: 'unicode-and-integer-bounds-v1',
      descriptorId: 'task.create',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_雪',
        taskId: 'task_é',
        expectedTeamRevision: 9007199254740991,
        taskIntentDigest: 'sha256:cccc',
      },
    },
    {
      id: 'launch-default-materialized-v1',
      descriptorId: 'team.launch',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      normalizationCase: 'explicit_defaults',
      intent: materializeLaunchDefaults({
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
      }),
    },
    {
      id: 'launch-default-omitted-v1',
      descriptorId: 'team.launch',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      normalizationCase: 'omitted_defaults_materialized_before_fingerprint',
      intent: materializeLaunchDefaults({ teamId: 'team_01', providerPlanDigest: 'sha256:dddd' }),
    },
    {
      id: 'launch-schema-v2-retained-key-v1',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
    {
      id: 'launch-key-rotation-v2',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v2',
      key: FIXTURE_KEY_V2,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
    {
      id: 'launch-fingerprint-version-v2-retained-key-v1',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v2',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
  ].map(({ key, ...entry }) => ({
    ...entry,
    digest: fingerprintIntent({ ...entry, key }),
  }));
  const oracleById = new Map(oracle.vectors.map((vector) => [vector.id, vector]));
  const oracleErrors = [];
  for (const entry of cases) {
    const vector = oracleById.get(entry.id);
    if (!vector) {
      oracleErrors.push(`missing immutable oracle vector ${entry.id}`);
      continue;
    }
    const encoded = encodeIntent({
      descriptorId: entry.descriptorId,
      schemaVersion: entry.schemaVersion,
      fingerprintVersion: entry.fingerprintVersion,
      intent: entry.intent,
    });
    if (encoded !== vector.expectedEncoding) {
      oracleErrors.push(`encoding mismatch against immutable oracle ${entry.id}`);
    }
    if (entry.digest !== vector.expectedDigest) {
      oracleErrors.push(`digest mismatch against immutable oracle ${entry.id}`);
    }
  }
  for (const vector of oracle.vectors) {
    if (!cases.some((entry) => entry.id === vector.id)) {
      oracleErrors.push(`stale immutable oracle vector ${vector.id}`);
    }
  }
  if (oracleErrors.length) {
    throw new Error(`Fingerprint oracle mismatch:\n${oracleErrors.join('\n')}`);
  }
  const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
  const original = byId['send-v1-field-order-a'];
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.FINGERPRINT_GOLDENS',
    encoder:
      'recursive UTF-8 byte-length-delimited typed encoding; object keys sorted; safe integers only',
    algorithm: 'HMAC-SHA-256',
    fixtureKeys:
      'public test-only keys are held by the generator and never represent production secrets',
    storedMaterial: 'descriptor/schema/fingerprint/key versions and digest only; no command body',
    immutableOracle:
      'test/architecture/hosted-web/phase-0/recovery-events/fixtures/fingerprint-oracle-vectors.json',
    immutableOracleVectorCount: oracle.vectors.length,
    cases,
    assertions: {
      fieldOrderEqual:
        byId['send-v1-field-order-a'].digest === byId['send-v1-field-order-b'].digest,
      changedIntentDiffers: original.digest !== byId['send-v1-changed-intent'].digest,
      omittedDefaultEqualsMaterialized:
        byId['launch-default-materialized-v1'].digest === byId['launch-default-omitted-v1'].digest,
      schemaVersionDiffers:
        byId['launch-default-materialized-v1'].digest !==
        byId['launch-schema-v2-retained-key-v1'].digest,
      keyVersionDiffers:
        byId['launch-schema-v2-retained-key-v1'].digest !== byId['launch-key-rotation-v2'].digest,
      fingerprintVersionDiffers:
        byId['launch-schema-v2-retained-key-v1'].digest !==
        byId['launch-fingerprint-version-v2-retained-key-v1'].digest,
      retainedFingerprintV1StillComputable:
        fingerprintIntent({ ...byId['launch-schema-v2-retained-key-v1'], key: FIXTURE_KEY_V1 }) ===
        byId['launch-schema-v2-retained-key-v1'].digest,
      retainedSameIntentOutcome: resolveClaim(original, { ...original }).outcome,
      changedIntentReuseOutcome: resolveClaim(original, byId['send-v1-changed-intent']).outcome,
      immutableOracleMatch: true,
    },
  };
}

export function buildEstimate() {
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.ESTIMATE',
    bucketId: 'EST-RECOVERY-STATE',
    packages: [
      'shared command descriptors/fingerprints',
      'internal-storage command/effect registry',
      'event journal/SSE handoff',
      'renderer reconciliation',
      'provider effect adapters',
    ],
    productionLines: { low: 2700, high: 4400 },
    testLines: { low: 1800, high: 3100 },
    deletedLines: { low: 200, high: 500 },
    excludedGeneratedVendorLines: true,
    overlap: [
      'W3 owns SQLite coordination, external writer classification, backup, and schema mechanics; do not sum its shared transaction/storage fixtures twice.',
    ],
    confidence: 'medium-low',
    assumptions: [
      'One hosted journal writer and one internal SQLite substrate are accepted.',
      'Current OpenCode delivery evidence is adapted rather than rewritten wholesale.',
      'Terminal recovery remains excluded from v1.',
      'Workspace/provider ambiguous effects remain operator_required unless later probes prove unique evidence.',
    ],
    evidenceRefs: [
      'P0.W5.EVENT_CURSOR_INVENTORY',
      'P0.W5.SNAPSHOT_HANDOFF_SCHEDULER',
      'P0.W5.COMMAND_CATALOG',
      'P0.W5.EFFECT_RECOVERY_MATRIX',
      'P0.W5.FINGERPRINT_GOLDENS',
    ],
    totalChangedLines: { low: 4500, high: 7500 },
    reestimateTriggers: [
      'W3 rejects a single SQLite writer/transaction seam',
      'provider launch/delivery cannot expose operation-bound evidence',
      'command catalog expands beyond hosted v1 capability matrix',
      'retention/keyring requires a separate service or migration',
    ],
  };
}

export function exactEffectScheduleMatches(schedule) {
  const compensation = schedule.crashPause.includes('compensation');
  const ambiguous =
    schedule.recoveryClass === 'non_reconcilable' &&
    ['before_external_call', 'after_external_call', 'before_evidence_query'].includes(
      schedule.crashPause
    );
  const outcome = compensation ? 'compensated' : ambiguous ? 'operator_required' : 'committed';
  const externalEffects = ambiguous && schedule.crashPause === 'before_external_call' ? 0 : 1;
  const externalCallAttempts =
    schedule.recoveryClass === 'transactional_local' || externalEffects === 0 ? 0 : 1;
  const evidenceDisposition = ambiguous
    ? 'unproved'
    : schedule.recoveryClass === 'transactional_local'
      ? 'same_transaction'
      : schedule.recoveryClass === 'idempotent_by_operation_id'
        ? 'durable_operation_lookup'
        : schedule.recoveryClass === 'non_reconcilable'
          ? 'explicit_in_call_ack'
          : 'operation_bound_unique_evidence';
  return (
    schedule.outcome === outcome &&
    schedule.durableAfterRecovery.state ===
      (compensation ? 'compensated' : ambiguous ? 'ambiguous' : 'observed_succeeded') &&
    schedule.durableAfterRecovery.commandOutcome === outcome &&
    schedule.durableAfterRecovery.journalCommitted === !ambiguous &&
    schedule.durableAfterRecovery.evidenceDisposition === evidenceDisposition &&
    schedule.externalCallAttempts === externalCallAttempts &&
    schedule.externalEffects === externalEffects &&
    schedule.compensationAttempts === (compensation ? 1 : 0) &&
    schedule.compensationEffects === (compensation ? 1 : 0) &&
    schedule.publicationAttempts ===
      (ambiguous ? 0 : schedule.crashPause === 'after_event_publication' ? 2 : 1)
  );
}

export function buildReport({ catalog, scheduler, effectMatrix, goldens }) {
  const ambiguous = effectMatrix.effects.filter(
    (effect) => effect.recoveryClass === 'non_reconcilable'
  );
  return (
    `# Phase 0 W5 recovery and event evidence\n\n` +
    `Pinned phase start: \`a32f509e6d9bd31ba2135940e336729bf90c3d93\`. Packet: \`phase-00-r2\`. This is Phase 0 evidence and executable modeling only; it does not implement the Phase 1 hosted journal, command registry, or renderer.\n\n` +
    `## Findings\n\n` +
    `- The current generic HTTP SSE route and renderer EventSource have no durable cursor, event ID, replay, scope, or gap detection. File-watcher team changes are lossy hints.\n` +
    `- Existing OpenCode delivery/bridge journals provide valuable conflict and ambiguity evidence. They are JSON-store/provider-specific, hash raw or partially normalized payloads without retained ADR-34 descriptor/key versions, and cannot serve as the hosted event journal.\n` +
    `- The deterministic snapshot scheduler explored ${scheduler.exploredScheduleCount} mutation schedules, including actual before/after commit transitions. All converged; lower-C0 schedules deliberately admitted duplicates. Both negative controls reproduced a lost committed event.\n` +
    `- The independent pinned-source census classifies ${catalog.coverage.observedSurfaceCount} extracted interface members and maps ${catalog.coverage.observedMethodCount} required mutations exactly once to ${catalog.commands.length} normalized command kinds and ${effectMatrix.effects.length} owned effects. Bidirectional missing/extra and omitted-descriptor fixtures fail closed.\n` +
    `- The external ownership gate compares ${catalog.coverage.crossLaneOwnership.comparedRequiredW1W5Members} required W1/W5 API members against the W1 API parity ledger and fails generation on a missing row or primary command-owner drift. Coordinator effects remain owned by the primary command feature; published secondary effects retain their distinct effect owner.\n` +
    `- The recovery scheduler executed ${effectMatrix.faultScheduler.exploredScheduleCount} real two-process crash/restart schedules. Every attempt exited at its scheduled boundary, a different PID reloaded only durable command/provider files, and exact post-restart state/effect/compensation/publication counts passed. Stale, coincidentally equal, mismatched-operation and lost-response negative controls all fail closed.\n` +
    `- Current task/inbox/provider lookup and active-writer coordination remain unproved by W3, so those external effects are \`non_reconcilable\`/\`operator_required\`; a future operation-ID class remains only a candidate until independently exercised. Same-key changed intent resolves to \`${goldens.assertions.changedIntentReuseOutcome}\`.\n\n` +
    `## Accepted handoff contract\n\n` +
    `SQLite-only snapshots read the projection, revision vector, and cursor from one transaction. Any external-file projection captures and pins retained C0 before its stable scan and returns C0. SSE registers its wake listener before its first durable query and repeatedly queries the high watermark; wake-ups never carry authority. Reducers deduplicate eventId and fence aggregate generation/revision.\n\n` +
    `This is at-least-once convergence, not event sourcing or exactly-once delivery. The durable journal row is an after-commit projection/outbox record; feature repositories remain state authority.\n\n` +
    `## Ambiguous effects\n\n` +
    ambiguous
      .map(
        (effect) =>
          `- \`${effect.commandKind}/${effect.effectId}\`: ${effect.proofRequired} -> \`operator_required\`.`
      )
      .join('\n') +
    `\n\n## Uncertainty and cross-lane dependency\n\n` +
    `W3 proves that task/config/native-inbox active writers are uncoordinated or quiescent-only today and that selected OpenCode evidence remains partial. This W5 remediation therefore admits no automatic row whose durable lookup/transaction/exclusivity proof is missing. W3 must still confirm the future single-writer SQLite transaction, retention/backup/keyring preservation, and every effect-specific external-writer seam. The 4.5k-7.5k estimate shares storage fixtures with W3 and must be deduplicated by the controller.\n\n` +
    `## Evidence index\n\n` +
    `- \`P0.W5.EVENT_CURSOR_INVENTORY\`: \`event-cursor-inventory.json\`\n` +
    `- \`P0.W5.SNAPSHOT_HANDOFF_SCHEDULER\`: \`snapshot-handoff-scheduler.json\`\n` +
    `- \`P0.W5.COMMAND_CATALOG\`: \`command-catalog.json\`\n` +
    `- \`P0.W5.EFFECT_RECOVERY_MATRIX\`: \`effect-recovery-matrix.json\`\n` +
    `- \`P0.W5.FINGERPRINT_GOLDENS\`: \`fingerprint-goldens.json\`\n` +
    `- \`P0.W5.ESTIMATE\`: \`estimate-input.json\`\n`
  );
}
