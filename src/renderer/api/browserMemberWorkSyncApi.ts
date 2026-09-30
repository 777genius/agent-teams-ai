import type { MemberWorkSyncElectronApi } from '@features/member-work-sync/contracts';

interface BrowserMemberWorkSyncTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export function createBrowserMemberWorkSyncApi(
  transport: BrowserMemberWorkSyncTransport
): MemberWorkSyncElectronApi {
  return {
    getStatus: (request) =>
      transport.get(
        `/api/teams/${encodeURIComponent(request.teamName)}/member-work-sync/${encodeURIComponent(
          request.memberName
        )}`
      ),
    refreshStatus: (request) =>
      transport.post(
        `/api/teams/${encodeURIComponent(request.teamName)}/member-work-sync/${encodeURIComponent(
          request.memberName
        )}/refresh`,
        {}
      ),
    getMetrics: (request) =>
      transport.get(`/api/teams/${encodeURIComponent(request.teamName)}/member-work-sync/metrics`),
    report: (request) =>
      transport.post(
        `/api/teams/${encodeURIComponent(request.teamName)}/member-work-sync/report`,
        request
      ),
    stopAutoResume: async () => {
      throw new Error('Member work sync stop is not available in browser mode.');
    },
    resumeAutoResume: async () => {
      throw new Error('Member work sync resume is not available in browser mode.');
    },
    continueManually: async () => {
      throw new Error('Member work sync continue is not available in browser mode.');
    },
  };
}
