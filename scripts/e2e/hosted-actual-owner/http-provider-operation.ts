// Port of accepted Owner 18d6568771003bd8f344bb9a984bc354532f087f. Data only.
import type { HostedHttpOperationV2 as HostedHttpOperation, SupervisedProviderOperationName } from './raw-http-types';

/** Classifies the actual native client request before authority preparation.
 * This is a bounded request vocabulary, not authorization: every result still
 * requires the admitted operation token and same-socket final effect fence. */
export function classifySupervisedProviderOperation(method: string, path: string): HostedHttpOperation {
  if ((method !== 'GET' && method !== 'POST') || Buffer.byteLength(path) > 16 * 1024 ||
    !path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) {
    throw new Error('OpenCode supervised operation unsupported')
  }
  const url = new URL(path, 'http://127.0.0.1')
  if (url.pathname + url.search !== path || url.hash) throw new Error('OpenCode supervised operation path invalid')
  const fixed: Record<string, SupervisedProviderOperationName> = {
    'GET /global/health': 'health', 'GET /config': 'config', 'GET /config/providers': 'config-providers',
    'GET /provider': 'providers', 'GET /provider/auth': 'provider-auth-methods', 'GET /doc': 'server-doc',
    'GET /agent': 'agents', 'GET /mcp': 'mcp-read', 'POST /mcp': 'mcp-add',
    'POST /session': 'session-create', 'GET /session/status': 'session-status',
  }
  let name = !url.search ? fixed[`${method} ${path}`] : undefined
  if (!name && !url.search && method === 'POST' && /^\/mcp\/[A-Za-z0-9_.-]{1,256}\/connect$/.test(path)) name = 'mcp-connect'
  const session = /^\/session\/[A-Za-z0-9_-]{1,256}(?:\/(message|prompt_async|abort)(?:\/([A-Za-z0-9_-]{1,256}))?)?$/.exec(url.pathname)
  if (!name && session) {
    if (method === 'GET' && !url.search) {
      if (!session[1]) name = 'session-read'
      else if (session[1] === 'message') name = session[2] ? 'message-read' : 'messages-read'
    } else if (method === 'GET' && session[1] === 'message' && !session[2] &&
      /^\?limit=[1-9][0-9]{0,3}$/.test(url.search)) name = 'messages-read'
    else if (method === 'POST' && !url.search && !session[2]) {
      if (session[1] === 'message') name = 'message-send'
      if (session[1] === 'prompt_async') name = 'prompt-async'
      if (session[1] === 'abort') name = 'session-abort'
    }
  }
  if (!name && method === 'GET' && (url.pathname === '/experimental/tool/ids' || url.pathname === '/experimental/tool')) {
    const keys = [...url.searchParams.keys()]
    if (new Set(keys).size !== keys.length || keys.some(key =>
      !(url.pathname.endsWith('/ids') ? ['directory'] : ['directory', 'provider', 'model']).includes(key))) {
      throw new Error('OpenCode supervised tool query invalid')
    }
    name = url.pathname.endsWith('/ids') ? 'tool-ids' : 'tools'
  }
  // Credential writes/OAuth and stock permission fallback are intentionally
  // absent: the supervisor owns credentials and approvals use conditional v2.
  if (!name) throw new Error('OpenCode supervised operation unsupported')
  return Object.freeze({ kind: 'provider', name, method, path })
}
