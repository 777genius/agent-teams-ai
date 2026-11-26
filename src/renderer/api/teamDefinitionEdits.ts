import { isTeamDefinitionEditRefusal } from '@shared/utils/teamDefinitionEditRefusal';

import type { TeamsAPI } from '@shared/types/api';
import type { TeamDefinitionEditApi } from '@shared/types/teamDefinitionEdit';

const definitionMethods = new Set<keyof TeamDefinitionEditApi>([
  'updateConfig',
  'addMember',
  'replaceMembers',
  'removeMember',
  'restoreMember',
  'updateMemberRole',
]);
const adaptedTeams = new WeakMap<TeamsAPI, TeamsAPI>();

/** Recreate only the tagged domain refusal after it has crossed the isolated-world boundary. */
export function withTeamDefinitionEdits(teams: TeamsAPI): TeamsAPI {
  const transport = teams.definitionEdits;
  if (!transport) return teams;
  const existing = adaptedTeams.get(teams);
  if (existing) return existing;
  const methods = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>();
  // contextBridge freezes its API object; a copied target permits replacing method values.
  const adapted = new Proxy(
    { ...teams },
    {
      get(target, property, receiver) {
        if (definitionMethods.has(property as keyof TeamDefinitionEditApi)) {
          let method = methods.get(property);
          if (!method) {
            const invoke = Reflect.get(transport, property) as (
              ...args: unknown[]
            ) => Promise<unknown>;
            method = async (...args) => {
              const result = await invoke(...args);
              if (isTeamDefinitionEditRefusal(result))
                throw Object.assign(new Error(result.message), { failure: result.failure });
              return result;
            };
            methods.set(property, method);
          }
          return method;
        }
        return Reflect.get(target, property, receiver);
      },
    }
  );
  adaptedTeams.set(teams, adapted);
  return adapted;
}
