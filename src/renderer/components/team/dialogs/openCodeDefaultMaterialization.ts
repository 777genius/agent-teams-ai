import { createContext, useContext } from 'react';

interface OpenCodeDefaultMaterialization {
  /** Whether main gives an unset teammate the lead's model at launch. */
  inheritsLeadModel: boolean;
}

/**
 * Set inside the Create/Launch roster, whose dialogs launch OpenCode
 * "Default" as the concrete project route and so must block an unusable one.
 * Other dialogs save Default itself; the next launch resolves and shows it.
 */
export const OpenCodeDefaultMaterializationContext =
  createContext<OpenCodeDefaultMaterialization | null>(null);

export function useOpenCodeDefaultMaterialization(): boolean {
  return useContext(OpenCodeDefaultMaterializationContext) !== null;
}

export function useLaunchInheritsLeadModel(): boolean {
  return useContext(OpenCodeDefaultMaterializationContext)?.inheritsLeadModel ?? false;
}
