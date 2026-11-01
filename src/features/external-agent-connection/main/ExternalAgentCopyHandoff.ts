import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { API_AUTH_REFERENCE_ENV } from '@features/local-http-auth/contracts';
import {
  applyApiAuthReference,
  privateDirectory,
  replacePrivateJson,
  validatePrivatePath,
} from '@features/local-http-auth/main';

import type {
  AppConnectionContext,
  ConnectionInfoV1,
  ExternalAgentCopyHandoff,
  ExternalAgentCopyRequest,
} from '../contracts';

interface Dependencies {
  userDataPath: string;
  getRoot(): string;
  getControlUrl(): string | null;
  getConnectionInfo(): Promise<ConnectionInfoV1>;
  withExpectedContext<T>(context: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  resolveLaunch(): Promise<{ command: string; args: string[]; env?: Record<string, string> }>;
}

/** Owns reference-only copy configs, never client registrations or shared API authority. */
export class ExternalAgentCopyHandoffService {
  private current: { identity: string; file: string; dev: number; ino: number } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: Dependencies) {}

  prepare(input: ExternalAgentCopyRequest): Promise<ExternalAgentCopyHandoff> {
    const operation = this.tail.then(() => this.prepareCurrent(input));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  /** Called under the app context fence. Only this service's exact file may be removed. */
  retire(): Promise<void> {
    const operation = this.tail.then(() => this.retireCurrent());
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async retireCurrent(): Promise<void> {
    const owned = this.current;
    if (!owned) return;
    try {
      const stat = await lstat(owned.file);
      if (stat.dev !== owned.dev || stat.ino !== owned.ino)
        throw new Error('Copy connection config changed; cannot remove it safely');
      await validatePrivatePath(owned.file);
      await unlink(owned.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.current = null;
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.retire();
  }

  private async prepareCurrent(input: ExternalAgentCopyRequest): Promise<ExternalAgentCopyHandoff> {
    if (
      this.closed ||
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'expectedContext,expectedProfileFingerprint' ||
      typeof input.expectedProfileFingerprint !== 'string' ||
      input.expectedProfileFingerprint.length > 128
    )
      throw new Error('Copy connection request is unavailable');
    const expected = input.expectedContext;
    if (
      !expected ||
      typeof expected !== 'object' ||
      Array.isArray(expected) ||
      Object.keys(expected).sort().join(',') !==
        'appInstanceId,connectionGeneration,dataRootFingerprint' ||
      typeof expected.appInstanceId !== 'string' ||
      !expected.appInstanceId.trim() ||
      expected.appInstanceId.length > 128 ||
      typeof expected.dataRootFingerprint !== 'string' ||
      expected.dataRootFingerprint.length > 128 ||
      !Number.isSafeInteger(expected.connectionGeneration) ||
      expected.connectionGeneration < 1
    )
      throw new Error('Copy connection request is unavailable');
    return this.deps.withExpectedContext(expected, async () => {
      const connection = await this.deps.getConnectionInfo();
      const check = (live: ConnectionInfoV1) => {
        if (
          this.closed ||
          live.profileFingerprint !== input.expectedProfileFingerprint ||
          live.context.appInstanceId !== input.expectedContext.appInstanceId ||
          live.context.dataRootFingerprint !== input.expectedContext.dataRootFingerprint ||
          live.context.connectionGeneration !== input.expectedContext.connectionGeneration ||
          live.mcp.status !== 'ready' ||
          live.control.status !== 'ready' ||
          !live.capabilities.draftCreation ||
          !live.mcp.url
        )
          throw new Error('App connection changed. Refresh the prompt before copying.');
      };
      check(connection);
      const root = this.deps.getRoot();
      const controlUrl = this.deps.getControlUrl();
      if (!controlUrl) throw new Error('Copy connection authentication is unavailable');
      const url = new URL(controlUrl);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.origin !== controlUrl ||
        !url.port
      )
        throw new Error('Copy connection endpoint is invalid');
      const env: Record<string, string | undefined> = {};
      applyApiAuthReference(env, root, controlUrl);
      const reference = env[API_AUTH_REFERENCE_ENV];
      if (!reference)
        throw new Error('Copy connection authentication is unavailable. Retry the app connection.');
      await validatePrivatePath(reference);
      const launch = await this.deps.resolveLaunch();
      if (
        !path.isAbsolute(launch.command) ||
        launch.args.length !== 1 ||
        !path.isAbsolute(launch.args[0]) ||
        path.basename(launch.args[0]) !== 'index.js'
      )
        throw new Error('Copy connection runtime is unavailable');
      const bootstrap = path.join(path.dirname(launch.args[0]), 'copyHandoff.js');
      const bootstrapStat = await lstat(bootstrap);
      if (!bootstrapStat.isFile() || bootstrapStat.isSymbolicLink())
        throw new Error('Copy connection runtime is unavailable');
      const descriptor = {
        schemaVersion: 1,
        context: connection.context,
        profileFingerprint: connection.profileFingerprint,
        root,
        controlUrl,
        authReference: reference,
      };
      const identity = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
      // A freshly admitted request may replace a known old epoch/origin, including HTTP retry.
      if (this.current && this.current.identity !== identity) await this.retireCurrent();
      let file = this.current?.file;
      if (!file) {
        const parent = await privateDirectory(this.deps.userDataPath);
        const directory = path.join(parent, 'copy-handoffs');
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await validatePrivatePath(directory, true);
        file = path.join(directory, `${randomUUID()}.json`);
        await replacePrivateJson(file, descriptor, validatePrivatePath);
        const stat = await validatePrivatePath(file);
        this.current = { identity, file, dev: stat.dev, ino: stat.ino };
      } else {
        const stat = await validatePrivatePath(file);
        if (stat.dev !== this.current!.dev || stat.ino !== this.current!.ino)
          throw new Error('Copy connection config changed');
      }
      const fresh = await this.deps.getConnectionInfo();
      check(fresh);
      if (
        this.deps.getRoot() !== root ||
        this.deps.getControlUrl() !== controlUrl ||
        fresh.mcp.url !== connection.mcp.url ||
        fresh.mcp.generation !== connection.mcp.generation
      )
        throw new Error('App connection changed. Refresh the prompt before copying.');
      return {
        connection: fresh,
        registration: {
          name: `agent-teams-${connection.profileFingerprint.slice(0, 12)}-${connection.context.appInstanceId}-${connection.context.connectionGeneration}`,
          command: launch.command,
          args: [bootstrap, '--handoff', file],
          ...(launch.env?.ELECTRON_RUN_AS_NODE === '1'
            ? { env: { ELECTRON_RUN_AS_NODE: '1' as const } }
            : {}),
        },
      };
    });
  }
}
