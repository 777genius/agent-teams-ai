import { createContext, useContext } from 'react';

/**
 * True inside the Create/Launch roster, whose dialogs launch OpenCode
 * "Default" as the concrete project route and so must block an unusable one.
 * Other dialogs save Default itself; the next launch resolves and shows it.
 */
export const OpenCodeDefaultMaterializationContext = createContext(false);

export function useOpenCodeDefaultMaterialization(): boolean {
  return useContext(OpenCodeDefaultMaterializationContext);
}
