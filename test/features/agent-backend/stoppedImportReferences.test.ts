import { describe, expect, it } from 'vitest';

import {
  hostTeamSelectionKey,
  parseHostTeamSelectionKey,
} from '../../../src/features/agent-backend/contracts/teamSelection';
import {
  qualifyHostTaskReferenceTeam,
  translateHostTaskReferences,
} from '../../../src/features/agent-backend/renderer/translateHostTaskReferences';
import {
  createEncodedTaskReference,
  findTaskReferenceMatches,
  parseTaskLinkHref,
} from '../../../src/renderer/utils/taskReferenceUtils';

describe('detached source reference navigation', () => {
  const selection = hostTeamSelectionKey('TEST-imported-handle');
  it('keeps exact imported internal references at the captured handle', () => {
    const map = (team?: string) =>
      qualifyHostTaskReferenceTeam(team, 'TEST-destination', selection);
    const text = createEncodedTaskReference('a', 'TEST-task', 'TEST-destination');
    const rewritten = translateHostTaskReferences(text, map);
    expect(findTaskReferenceMatches(rewritten, [])[0]!.suggestion.teamName).toBe(selection);
    expect(map('TEST-destination')).toBe(selection);
  });
  it('source archive and explicit gap identities never become live or legacy names', () => {
    for (const kind of ['archive', 'gap']) {
      const source = `legacy-${kind}:${'a'.repeat(64)}`;
      const destination = qualifyHostTaskReferenceTeam(source, 'TEST-destination', selection);
      expect(destination).toContain(`:source-${kind}:`);
      expect(() => parseHostTeamSelectionKey(destination)).toThrow();
      const translated = translateHostTaskReferences(
        `task://TEST-old?team=${encodeURIComponent(source)}&display=old`,
        (team) => qualifyHostTaskReferenceTeam(team, 'TEST-destination', selection)
      );
      expect(parseTaskLinkHref(translated)!.teamName).toBe(destination);
      expect(translated).not.toContain('TEST-destination');
    }
  });
  it('a same-named Host Team remains unbound without an exact captured resource map', () => {
    const destination = qualifyHostTaskReferenceTeam(
      'TEST-colliding-human-name',
      'TEST-destination',
      selection
    );
    expect(destination).toContain(':unbound:');
    expect(() => parseHostTeamSelectionKey(destination)).toThrow();
  });
});
