import type { TeamGroupChatsAPI } from '../../contracts';

export function createHttpTeamGroupChatsAPI(baseUrl: string): TeamGroupChatsAPI {
  const post = async <T>(operation: string, request: unknown): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${baseUrl}/api/team-group-chats/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
      const result: unknown = await response.json();
      if (!response.ok) {
        const failure = result as { error?: { code?: string; message?: string } };
        throw Object.assign(new Error(failure.error?.message ?? `HTTP ${response.status}`), { code: failure.error?.code });
      }
      return result as T;
    } finally { clearTimeout(timer); }
  };
  return { list: (request) => post('list', request), create: (request) => post('create', request), setArchived: (request) => post('setArchived', request), send: (request) => post('send', request) };
}
