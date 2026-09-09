import { request, type IncomingMessage } from 'node:http';

export class SelectedProbeUnavailable extends Error {
  constructor() { super('selected_opencode_not_listening'); }
}
/** No body, URL, credentials or original error cause escapes this private
 * probe. Returned bytes are genuine, complete identity-encoded response bytes
 * owned by the caller, which must wipe them after its private proof lifetime. */
export function readSelectedPrivateResponse(path: string,
  credentials: Readonly<{ username: string; password: string }>, signal: AbortSignal,
): Promise<{ status: number; bytes: Buffer; data: unknown }> {
  if (!['/global/health', '/config', '/config/providers', '/agent', '/mcp',
    '/experimental/agent-teams/hosted-approval-capability'].includes(path)) {
    return Promise.reject(new Error('selected_opencode_private_probe'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, settled = false;
    let response: IncomingMessage | undefined;
    const releaseChunks = () => { for (const bytes of chunks) bytes.fill(0); chunks.length = 0; };
    const fail = (unavailable = false) => {
      if (settled) return; settled = true;
      releaseChunks(); response?.destroy(); req.destroy();
      reject(unavailable ? new SelectedProbeUnavailable() : new Error('selected_opencode_private_probe'));
    };
    const req = request({ host: '127.0.0.1', port: 4096, path, method: 'GET',
      auth: `${credentials.username}:${credentials.password}`, agent: false,
      headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    }, res => {
      response = res;
      if (settled) { res.destroy(); return; }
      if (res.socket.remoteAddress !== '127.0.0.1' || res.socket.remotePort !== 4096 ||
        res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        fail(); return;
      }
      res.on('data', (part: Buffer) => {
        if (settled) return;
        length += part.length;
        if (length > 1024 * 1024) { fail(); return; }
        chunks.push(Buffer.from(part));
      });
      res.once('error', () => fail());
      res.once('aborted', () => fail());
      res.once('end', () => {
        if (settled) return;
        const bytes = Buffer.concat(chunks, length); releaseChunks();
        try {
          if (!res.complete || res.statusCode !== 200) throw new Error();
          const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          settled = true; resolve({ status: res.statusCode, bytes, data });
        } catch { bytes.fill(0); fail(); }
      });
      res.once('close', () => { if (!res.complete) fail(); });
    });
    req.once('error', (error: NodeJS.ErrnoException) => fail(error.code === 'ECONNREFUSED' && !response));
    req.end();
  });
}
