import { gitIdentityResolver } from '@main/services/parsing/GitIdentityResolver';

export interface RecentProjectIdentity {
  id: string;
  name?: string;
}

export class RecentProjectIdentityResolver {
  async resolve(projectPath: string): Promise<RecentProjectIdentity | null> {
    const identity = await gitIdentityResolver.resolveIdentity(projectPath);
    if (!identity) {
      return null;
    }

    return {
      id: identity.id,
      name: identity.name,
    };
  }
}
