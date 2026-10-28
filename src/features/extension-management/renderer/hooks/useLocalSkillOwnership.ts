import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

import type { LocalSkillStatus } from '../../contracts';

type Ownership = LocalSkillStatus | { ownership: 'unknown'; reason: string };

/** Display guard only; Go always verifies ownership again while holding its mutation lock. */
export function useLocalSkillOwnership(skillPath: string | null, projectPath?: string) {
  const [status, setStatus] = useState<Ownership>({ ownership: 'unknown', reason: '' });
  useEffect(() => {
    let current = true;
    setStatus({ ownership: 'unknown', reason: '' });
    if (!skillPath) return;
    const backend = api.extensionManagement;
    if (!backend) {
      setStatus({
        ownership: 'unknown',
        reason: 'Local Skill ownership requires the desktop extension manager.',
      });
      return;
    }
    void backend
      .capture({
        client: 'claude',
        scope: 'user',
        ...(projectPath ? { authoringProject: projectPath } : {}),
      })
      .then((context) => backend.localSkillStatus({ contextId: context.contextId, skillPath }))
      .then((value) => {
        if (current) setStatus(value);
      })
      .catch((error: unknown) => {
        if (current)
          setStatus({
            ownership: 'unknown',
            reason:
              error instanceof Error
                ? error.message
                : 'Local Skill ownership could not be checked.',
          });
      });
    return () => {
      current = false;
    };
  }, [skillPath, projectPath]);
  return status;
}
