import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TeamOwnerError } from '../team/contracts.js';
import { McpToolFailure } from './contracts.js';
import { createTeamMcpTools } from './tools.js';

import type {
  TeamMcpCatalogReceipt,
  TeamMcpEndpoint,
  TeamMcpEndpointOptions,
} from './contracts.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new McpToolFailure('invalid');
  return value;
}

function httpFailure(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code } }));
}

function toolFailure(error: unknown): CallToolResult {
  // Do not reflect controller exceptions, paths, payloads, tokens or SDK diagnostics.
  const code =
    error instanceof McpToolFailure || error instanceof TeamOwnerError ? error.code : 'internal';
  const value = { error: { code } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function readBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      request.off('aborted', aborted);
      if (error) {
        request.resume();
        reject(error);
      }
    };
    const failed = () => finish(new McpToolFailure('invalid'));
    const aborted = () => failed();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        finish(new McpToolFailure('output-limit'));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      finish();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new McpToolFailure('invalid'));
      }
    };
    const timer = setTimeout(failed, 10_000);
    timer.unref();
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    request.once('aborted', aborted);
  });
}

/**
 * One private, captured member capability. Stateless MCP HTTP authentication runs
 * on every request; tool dispatch checks generation again before the Team fence.
 * Each request gets its own SDK transport, so concurrent native callbacks do not
 * wait on a conversation turn or share MCP session state across members.
 */
export async function startTeamMcpEndpoint(
  options: TeamMcpEndpointOptions
): Promise<TeamMcpEndpoint> {
  const binding = Object.freeze(structuredClone(options.binding));
  if (
    Object.keys(binding).sort().join(',') !==
      'backendId,generation,memberId,runId,teamId,teamName' ||
    Object.values(binding).some(
      (value) => typeof value !== 'string' || !value.trim() || value.length > 256
    )
  )
    throw new McpToolFailure('invalid');
  const now = options.now ?? Date.now;
  const expiresAtMs = options.expiresAtMs;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now() ||
    typeof options.isCurrentBinding !== 'function'
  )
    throw new McpToolFailure('invalid');
  const isCurrentBinding = options.isCurrentBinding;
  const maxRequestBytes = bounded(options.maxRequestBytes ?? 64 * 1024, 1024 * 1024);
  const maxConcurrentRequests = bounded(options.maxConcurrentRequests ?? 32, 256);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new McpToolFailure('invalid');
  // Snapshot the actual captured methods, not a later mutable host-service object.
  const crossTeam = options.connection.crossTeam;
  const process = options.connection.process;
  const reads = options.connection.readQueries;
  const nativeMemberCreation = options.connection.nativeMemberCreation;
  const nativeMemberActions = options.connection.nativeMemberActions;
  const workSync = options.connection.workSync;
  const connection = Object.freeze({
    execute: options.connection.execute.bind(options.connection),
    lookup: options.connection.lookup.bind(options.connection),
    getTask: options.connection.getTask.bind(options.connection),
    listTasks: options.connection.listTasks.bind(options.connection),
    ...(reads ? { readQueries: Object.freeze({
      getTeam: reads.getTeam.bind(reads),
      getKanbanState: reads.getKanbanState.bind(reads),
      listReviewers: reads.listReviewers.bind(reads),
      getTaskComment: reads.getTaskComment.bind(reads),
      listTaskInventory: reads.listTaskInventory.bind(reads),
      taskBriefing: reads.taskBriefing.bind(reads),
      leadBriefing: reads.leadBriefing.bind(reads),
      ...(reads.memberBriefing ? { memberBriefing: reads.memberBriefing.bind(reads) } : {}),
    }) } : {}),
    ...(nativeMemberCreation ? {
      nativeMemberCreation: Object.freeze({ invoke: nativeMemberCreation.invoke.bind(nativeMemberCreation) }),
    } : {}),
    ...(nativeMemberActions ? {
      nativeMemberActions: Object.freeze({ invoke: nativeMemberActions.invoke.bind(nativeMemberActions) }),
    } : {}),
    ...(workSync ? {
      workSync: Object.freeze({ status: workSync.status.bind(workSync), report: workSync.report.bind(workSync) }),
    } : {}),
    ...(process
      ? {
          process: Object.freeze({
            register: process.register.bind(process),
            metadata: process.metadata.bind(process),
            list: process.list.bind(process),
            lookup: process.lookup.bind(process),
          }),
        }
      : {}),
    ...(crossTeam
      ? {
          crossTeam: Object.freeze({
            listTargets: crossTeam.listTargets.bind(crossTeam),
            send: crossTeam.send.bind(crossTeam),
            lookup: crossTeam.lookup.bind(crossTeam),
            getOutbox: crossTeam.getOutbox.bind(crossTeam),
          }),
        }
      : {}),
  });
  const tools = createTeamMcpTools(connection);
  const path = `/mcp/${randomBytes(24).toString('base64url')}`;
  const bearerToken = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${bearerToken}`);
  const active = new Set<Server>();
  let concurrent = 0;
  let revoked = false;
  let origin = '';
  let catalogReceipt: TeamMcpCatalogReceipt | undefined;
  let catalogSequence = 0;
  const assertCurrent = () => {
    if (revoked || now() >= expiresAtMs || !isCurrentBinding(binding))
      throw new McpToolFailure('forbidden');
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => httpFailure(response, 500, 'internal'));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = maxConcurrentRequests + 4;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    // Each stateless SDK transport owns exactly this response. Do not let native
    // clients reuse a socket after its request-owned transport has been retired.
    response.setHeader('connection', 'close');
    if (request.url !== path) {
      httpFailure(response, 404, 'not-found');
      request.resume();
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    let authorized =
      supplied.length === authorization.length && timingSafeEqual(supplied, authorization);
    try {
      assertCurrent();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      httpFailure(response, 401, 'forbidden');
      request.resume();
      return;
    }
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    ) {
      httpFailure(response, 403, 'forbidden');
      request.resume();
      return;
    }
    if (request.method !== 'POST') {
      httpFailure(response, 405, 'method-not-allowed');
      request.resume();
      return;
    }
    if (concurrent >= maxConcurrentRequests) {
      httpFailure(response, 503, 'busy');
      request.resume();
      return;
    }
    concurrent++;
    let mcp: Server | undefined;
    let returnedCatalog: string[] | undefined;
    response.once('finish', () => {
      if (response.statusCode !== 200 || !returnedCatalog) return;
      try {
        assertCurrent();
        catalogReceipt = Object.freeze({
          binding,
          toolNames: Object.freeze([...returnedCatalog]),
          sequence: ++catalogSequence,
          servedAtMs: now(),
        });
      } catch {
        /* A revoked/expired response cannot publish current discovery evidence. */
      }
    });
    try {
      const body = await readBody(request, maxRequestBytes);
      assertCurrent();
      mcp = new Server(
        { name: 'legacy-agent-host-team', version: '0.1.0' },
        {
          capabilities: { tools: {} },
          instructions:
            'This endpoint captures your Team actor. Never send authority fields (from/actor/teamName/claudeDir/backend/run/member/generation). Mutating tools require a stable commandId chosen before first dispatch; preserve it on retry. Lookup uncertain outcomes; do not invent a replacement ID. Catalog is a partial P2 slice.',
        }
      );
      mcp.onerror = () => {
        /* SDK error details never enter product logs or responses. */
      };
      mcp.setRequestHandler(ListToolsRequestSchema, () => {
        assertCurrent();
        const catalog = tools.list();
        returnedCatalog = catalog.map((tool) => tool.name).sort();
        return { tools: catalog };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          assertCurrent();
          const result = await tools.callAsync(request.params.name, request.params.arguments ?? {});
          assertCurrent();
          return result;
        } catch (error) {
          return toolFailure(error);
        }
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      active.add(mcp);
      // SDK 1.30's concrete optional callback accessors include undefined, while
      // its own Transport interface uses exact optionals. Runtime behavior is the
      // SDK's documented stateless transport; no host-service cast is involved.
      await mcp.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      const status =
        error instanceof McpToolFailure
          ? error.code === 'forbidden'
            ? 401
            : error.code === 'output-limit'
              ? 413
              : 400
          : 500;
      httpFailure(
        response,
        status,
        status === 413
          ? 'request-limit'
          : status === 401
            ? 'forbidden'
            : status === 400
              ? 'invalid'
              : 'internal'
      );
    } finally {
      concurrent--;
      if (mcp) {
        active.delete(mcp);
        await mcp.close().catch(() => {});
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new McpToolFailure('invalid');
  }
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    url: origin + path,
    bearerToken,
    binding,
    getCatalogReceipt: () => {
      try {
        assertCurrent();
        return catalogReceipt ? structuredClone(catalogReceipt) : undefined;
      } catch {
        return undefined;
      }
    },
    revoke: () => {
      revoked = true;
    },
    close: () => {
      revoked = true;
      closing ??= (async () => {
        await Promise.allSettled([...active].map((entry) => entry.close()));
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  });
}
