import { isIP } from 'node:net';

/** Frozen OpenCode access policy: named authless routes or loopback OpenAI-compatible config. */
const authless = new Set([
  'atomic-chat',
  'cursor-acp',
  'kiro',
  'llama.cpp',
  'llamacpp',
  'lmstudio',
  'lm-studio',
  'local',
  'ollama',
  'vllm',
]);
export function isConfiguredAuthless(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const provider = entry as Record<string, unknown>;
  if (typeof provider.id === 'string' && authless.has(provider.id.trim().toLowerCase()))
    return true;
  if (provider.npm !== '@ai-sdk/openai-compatible') return false;
  const options = provider.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const row = options as Record<string, unknown>;
  const value = row.baseURL ?? row.baseUrl;
  if (typeof value !== 'string') return false;
  return isLiteralLoopback(value);
}

function isLiteralLoopback(value: string): boolean {
  const source = value.trim();
  const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(source)?.[1];
  if (!authority || authority.includes('@')) return false;
  try {
    const url = new URL(source);
    if (url.username || url.password) return false;
    let literal: string;
    if (authority.startsWith('[')) {
      const end = authority.indexOf(']');
      if (end < 0 || !/^(?::\d+)?$/.test(authority.slice(end + 1))) return false;
      literal = authority.slice(0, end + 1).toLowerCase();
    } else {
      const port = authority.lastIndexOf(':');
      literal = (port < 0 ? authority : authority.slice(0, port)).toLowerCase();
      if ((port >= 0 && !/^:\d+$/.test(authority.slice(port))) || literal.includes(':'))
        return false;
    }
    const hostname = url.hostname.toLowerCase();
    if (literal === 'localhost' || literal === '0.0.0.0') return hostname === literal;
    if (literal.startsWith('[')) return literal === '[::1]' && hostname === literal;
    return isIP(literal) === 4 && Number(literal.split('.')[0]) === 127 && hostname === literal;
  } catch {
    return false;
  }
}
