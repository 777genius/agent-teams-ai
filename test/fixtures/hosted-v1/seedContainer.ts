import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';

const TEAM_NAME = 'sandbox-hosted-team';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'c'.repeat(32)}`;
const ADOPTION_ID = `adoption_${'b'.repeat(32)}`;
const CREATED_AT = '2026-08-06T12:00:00.000Z';
const PUBLISHED_AT = '2026-08-06T12:00:10.000Z';
const COMMITTED_AT = '2026-08-06T12:00:20.000Z';
const DEPLOYMENT_ID = 'deployment_hosted-v1-e2e';
const CLAUDE_ROOT = process.env.E2E_SEED_CLAUDE_ROOT ?? '/data/.claude';
const APP_DATA_ROOT = process.env.E2E_SEED_APP_DATA_ROOT ?? '/data/.agent-teams';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('hosted_e2e_event_number_invalid');
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== 'object') throw new TypeError('hosted_e2e_event_json_invalid');
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort((left, right) => left.localeCompare(right))) {
      const child = (candidate as Record<string, unknown>)[key];
      if (child !== undefined) normalized[key] = normalize(child);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

async function seedSandbox(): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } =
    // @ts-expect-error The fixture seed executes source TypeScript through tsx.
    await import('../../../src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema.ts');
  const marker = JSON.parse(
    await readFile(process.env.E2E_SEED_MARKER_PATH ?? '/e2e-owner.json', 'utf8')
  ) as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.purpose !== 'hosted-v1-browser-e2e' ||
    typeof marker.marker !== 'string' ||
    !/^[0-9a-f]{48}$/.test(marker.marker)
  ) {
    throw new Error('hosted_e2e_seed_marker_invalid');
  }

  const teamDirectory = `${CLAUDE_ROOT}/teams/${TEAM_NAME}`;
  if ((await realpath(teamDirectory)) !== teamDirectory) {
    throw new Error('hosted_e2e_seed_team_root_invalid');
  }
  const teamStat = await lstat(teamDirectory, { bigint: true });
  if (!teamStat.isDirectory() || teamStat.isSymbolicLink()) {
    throw new Error('hosted_e2e_seed_team_root_invalid');
  }
  const identity = await readFile(`${teamDirectory}/team.identity.json`, 'utf8');
  const identityChecksum = sha256(identity);
  const directoryFingerprint = sha256(
    JSON.stringify({
      schemaVersion: 1,
      canonicalPath: `/data/.claude/teams/${TEAM_NAME}`,
      device: teamStat.dev.toString(),
      inode: teamStat.ino.toString(),
    })
  );
  const intentChecksum = sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentId: ADOPTION_ID,
      teamId: TEAM_ID,
      legacyKey: TEAM_NAME,
      directoryFingerprint,
      workspaceId: WORKSPACE_ID,
      workspaceBindingGeneration: 1,
      expectedIdentityChecksum: identityChecksum,
      preparedAt: CREATED_AT,
    })
  );

  await mkdir(`${APP_DATA_ROOT}/storage`, { recursive: true });
  const database = new Database(`${APP_DATA_ROOT}/storage/app.db`);
  try {
    database.pragma('journal_mode = DELETE');
    for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) database.exec(statement);
    database
      .prepare(
        `INSERT INTO team_identity_records (
          team_id, state, legacy_key, directory_fingerprint, workspace_id,
          workspace_binding_generation, adoption_intent_id, identity_checksum,
          created_at, activated_at, tombstoned_at
        ) VALUES (?, 'active', ?, ?, ?, 1, ?, ?, ?, ?, NULL)`
      )
      .run(
        TEAM_ID,
        TEAM_NAME,
        directoryFingerprint,
        WORKSPACE_ID,
        ADOPTION_ID,
        identityChecksum,
        CREATED_AT,
        COMMITTED_AT
      );
    database
      .prepare(
        `INSERT INTO legacy_team_key_reservations (
          legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
        ) VALUES (?, ?, 'active', ?, NULL, NULL)`
      )
      .run(TEAM_NAME, TEAM_ID, CREATED_AT);
    database
      .prepare(
        `INSERT INTO team_adoption_intents (
          intent_id, team_id, state, legacy_key, directory_fingerprint, workspace_id,
          workspace_binding_generation, expected_identity_checksum, intent_checksum,
          prepared_at, file_published_at, published_identity_checksum,
          committed_at, committed_identity_checksum
        ) VALUES (?, ?, 'committed', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ADOPTION_ID,
        TEAM_ID,
        TEAM_NAME,
        directoryFingerprint,
        WORKSPACE_ID,
        identityChecksum,
        intentChecksum,
        CREATED_AT,
        PUBLISHED_AT,
        identityChecksum,
        COMMITTED_AT,
        identityChecksum
      );
  } finally {
    database.close();
  }
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 16 * 1024) throw new Error('hosted_e2e_oidc_body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function serveSyntheticOidcProvider(): Promise<void> {
  const issuer = process.env.HOSTED_E2E_OIDC_ORIGIN;
  const hostedOrigin = process.env.HOSTED_E2E_ORIGIN;
  const clientId = process.env.OIDC_CLIENT_ID;
  const port = Number(process.env.PORT ?? 8080);
  const role = process.env.HOSTED_E2E_OIDC_ROLE ?? 'owner';
  if (
    !issuer ||
    !hostedOrigin ||
    !clientId ||
    new URL(issuer).protocol !== 'https:' ||
    new URL(hostedOrigin).protocol !== 'https:' ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65_535
  ) {
    throw new Error('hosted_e2e_oidc_configuration_invalid');
  }
  const redirectUri = `${hostedOrigin}/api/auth/oidc/callback`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    alg: 'RS256',
    kid: 'hosted-v1-e2e-key',
    use: 'sig',
  };
  const codes = new Map<string, { readonly challenge: string; readonly nonce: string }>();
  const signedIdToken = (nonce: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'hosted-v1-e2e-key', typ: 'JWT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: 'hosted-v1-e2e-owner',
        aud: clientId,
        exp: now + 300,
        iat: now,
        nonce,
        sid: 'hosted-v1-e2e-provider-session',
        name: 'Synthetic OIDC Owner',
        realm_access: { roles: [`agent-teams-${role}`] },
      })
    ).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
      'base64url'
    );
    return `${signingInput}.${signature}`;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', issuer);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        sendJson(response, { keys: [publicJwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const state = url.searchParams.get('state');
        const nonce = url.searchParams.get('nonce');
        const challenge = url.searchParams.get('code_challenge');
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('redirect_uri') !== redirectUri ||
          url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !url.searchParams.get('scope')?.split(' ').includes('openid') ||
          !state ||
          !nonce ||
          !challenge ||
          !/^[A-Za-z0-9_-]{32,}$/.test(state) ||
          !/^[A-Za-z0-9_-]{32,}$/.test(nonce) ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge)
        ) {
          sendJson(response, { error: 'invalid_request' }, 400);
          return;
        }
        if (codes.size >= 32) {
          sendJson(response, { error: 'temporarily_unavailable' }, 503);
          return;
        }
        const code = randomBytes(32).toString('base64url');
        codes.set(code, { challenge, nonce });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.writeHead(302, { 'cache-control': 'no-store', location: callback.toString() });
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await requestBody(request));
        const code = body.get('code');
        const verifier = body.get('code_verifier');
        const attempt = code ? codes.get(code) : undefined;
        if (
          body.get('grant_type') !== 'authorization_code' ||
          body.get('client_id') !== clientId ||
          body.get('redirect_uri') !== redirectUri ||
          !code ||
          !verifier ||
          !attempt ||
          createHash('sha256').update(verifier).digest('base64url') !== attempt.challenge
        ) {
          sendJson(response, { error: 'invalid_grant' }, 400);
          return;
        }
        codes.delete(code);
        sendJson(response, {
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signedIdToken(attempt.nonce),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/logout') {
        const destination = url.searchParams.get('post_logout_redirect_uri');
        const parsedDestination = destination ? new URL(destination) : null;
        if (
          !destination ||
          parsedDestination?.origin !== hostedOrigin ||
          parsedDestination?.pathname !== '/' ||
          parsedDestination?.search !== '' ||
          parsedDestination?.hash !== ''
        ) {
          sendJson(response, { error: 'invalid_request' }, 400);
          return;
        }
        response.writeHead(302, { 'cache-control': 'no-store', location: destination });
        response.end();
        return;
      }
      sendJson(response, { error: 'not_found' }, 404);
    } catch {
      sendJson(response, { error: 'provider_unavailable' }, 503);
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolveListen);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function writeLine(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

interface FakeRuntimeCommand {
  readonly action: string;
  readonly commandId: string;
  readonly runId: string;
  readonly teamId: string;
  readonly workspaceId: string;
}

interface FakeRuntimeState {
  readonly schemaVersion: 1;
  readonly activeRuns: readonly Readonly<{ teamId: string; runId: string }>[];
  readonly commands: readonly FakeRuntimeCommand[];
  readonly eventIds: readonly string[];
}

const runtimeStatePath = '/e2e-state/runtime-state.json';

async function readRuntimeState(): Promise<FakeRuntimeState> {
  try {
    return JSON.parse(await readFile(runtimeStatePath, 'utf8')) as FakeRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: 1, activeRuns: [], commands: [], eventIds: [] };
  }
}

async function writeRuntimeState(state: FakeRuntimeState): Promise<void> {
  const temporaryPath = `${runtimeStatePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, runtimeStatePath);
}

async function appendLaunchProgressEvent(
  command: Record<string, unknown>,
  runId: string
): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync('/data/.agent-teams/storage/app.db');
  database.exec('PRAGMA busy_timeout = 5000');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const eventEpoch = `epoch-initial-v1-${sha256(DEPLOYMENT_ID).slice(0, 24)}`;
      database
        .prepare(
          `INSERT OR IGNORE INTO coordination_event_journal_metadata (
            deployment_id, event_epoch, retention_floor_sequence,
            high_watermark_sequence, created_at, updated_at
          ) VALUES (?, ?, 0, 0, ?, ?)`
        )
        .run(DEPLOYMENT_ID, eventEpoch, now, now);
      const metadata = database
        .prepare(
          `SELECT event_epoch, high_watermark_sequence
           FROM coordination_event_journal_metadata WHERE deployment_id = ?`
        )
        .get(DEPLOYMENT_ID) as { event_epoch: string; high_watermark_sequence: number } | undefined;
      if (!metadata) throw new Error('hosted_e2e_event_metadata_missing');
      if (metadata.event_epoch !== eventEpoch) throw new Error('hosted_e2e_event_epoch_mismatch');
      const sequence = metadata.high_watermark_sequence + 1;
      const eventId = `event_hosted-v1-e2e-launch-${sequence}`;
      const teamId = String(command.teamId);
      const workspaceId = String(command.workspaceId);
      const eventBody = canonicalJson({
        schemaVersion: 1,
        eventId,
        scope: { kind: 'team', scopeId: teamId },
        workspaceId,
        teamId,
        runId,
        actor: { kind: 'verified_runtime', actorRef: 'runtime_hosted-v1-e2e', runId },
        eventType: 'team-lifecycle.run-accepted',
        resourceRevision: { resourceKey: teamId, generation: 1, revision: sequence },
        emittedAt: now,
        payload: {
          fileWriterEpoch: 1,
          generation: 1,
          planHash: sha256(`${teamId}:${runId}`),
          runId,
          watcherWatermark: 0,
        },
      });
      database
        .prepare(
          `INSERT INTO coordination_event_journal (
            deployment_id, event_epoch, event_sequence, event_id, body_json,
            emitted_at, origin_command_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(DEPLOYMENT_ID, eventEpoch, sequence, eventId, eventBody, now, now);
      database
        .prepare(
          `UPDATE coordination_event_journal_metadata
           SET high_watermark_sequence = ?, updated_at = ?
           WHERE deployment_id = ? AND event_epoch = ?`
        )
        .run(sequence, now, DEPLOYMENT_ID, eventEpoch);
      database.exec('COMMIT');
      return eventId;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

async function recordRuntimeExecution(
  command: Record<string, unknown>,
  runId: string
): Promise<void> {
  const action = String(command.action);
  const teamId = String(command.teamId);
  const executed: FakeRuntimeCommand = {
    action,
    commandId: String(command.commandId),
    runId,
    teamId,
    workspaceId: String(command.workspaceId),
  };
  const previous = await readRuntimeState();
  const active = new Map(previous.activeRuns.map((run) => [run.teamId, run]));
  if (action === 'launch' || action === 'recover') active.set(teamId, { teamId, runId });
  if (action === 'stop' || action === 'cancel') active.delete(teamId);
  const eventIds = [...previous.eventIds];
  if (action === 'launch') eventIds.push(await appendLaunchProgressEvent(command, runId));
  await writeRuntimeState({
    schemaVersion: 1,
    activeRuns: [...active.values()],
    commands: [...previous.commands, executed],
    eventIds,
  });
}

async function serveFakeRuntime(): Promise<void> {
  const socketPath = '/run/agent-teams/orchestrator-lifecycle.sock';
  const bootId = process.env.E2E_BOOT_ID;
  if (!bootId) throw new Error('hosted_e2e_fake_runtime_boot_id_missing');
  await rm(socketPath, { force: true });
  await writeRuntimeState(await readRuntimeState());
  const server = createNetServer((socket) => {
    let body = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0 || handled) return;
      handled = true;
      try {
        const request = JSON.parse(body.slice(0, newline)) as {
          readonly operation?: string;
          readonly command?: Record<string, unknown>;
        };
        if (request.operation === 'readiness') {
          socket.write(
            `${JSON.stringify({ schemaVersion: 1, kind: 'ready', owner: 'external-orchestrator', capability: 'hosted-lifecycle-command' })}\n`
          );
          return;
        }
        const command = request.command;
        if (!command) throw new Error('fake_runtime_command_missing');
        const authorization = {
          grantId: `grant_hosted-v1-${String(command.teamId).slice(-16)}`,
          authorizationGeneration: 'authorization-generation_hosted-v1-e2e',
          bootId,
          resourceRevision: command.expectedRevision,
        };
        if (request.operation === 'authorize') {
          writeLine(socket, { schemaVersion: 1, kind: 'authorized', authorization });
          return;
        }
        if (request.operation === 'revalidate') {
          writeLine(socket, { schemaVersion: 1, kind: 'valid', authorization });
          return;
        }
        if (request.operation === 'execute') {
          const runId =
            typeof command.runId === 'string'
              ? command.runId
              : `run_hosted-v1-e2e-${sha256(String(command.teamId)).slice(0, 20)}`;
          await recordRuntimeExecution(command, runId);
          writeLine(socket, {
            schemaVersion: 1,
            kind: 'result',
            authorization,
            result: {
              schemaVersion: 1,
              kind: 'accepted',
              action: command.action,
              commandId: command.commandId,
              workspaceId: command.workspaceId,
              teamId: command.teamId,
              runId,
              resourceRevision: command.expectedRevision,
            },
          });
          return;
        }
        writeLine(socket, { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null });
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[2] === 'oidc-provider') await serveSyntheticOidcProvider();
else if (process.argv[2] === 'fake-runtime') await serveFakeRuntime();
else await seedSandbox();
