import { lazy, Suspense } from 'react';

import type { ComponentProps } from 'react';

// Utility imports from the public renderer entrypoint must not load the model editor.
const LazyEditTeamMemberDialog = lazy(() =>
  import('./EditTeamMemberDialog').then((module) => ({ default: module.EditTeamMemberDialog }))
);
const LazyTeamMemberSettingsDialogBridge = lazy(() =>
  import('./TeamMemberSettingsDialogBridge').then((module) => ({
    default: module.TeamMemberSettingsDialogBridge,
  }))
);

export const EditTeamMemberDialog = (
  props: ComponentProps<typeof LazyEditTeamMemberDialog>
): React.JSX.Element | null => {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyEditTeamMemberDialog {...props} />
    </Suspense>
  ) : null;
};

// The caller owns the selected target and mounts this bridge only while editing.
export const TeamMemberSettingsDialogBridge = (
  props: ComponentProps<typeof LazyTeamMemberSettingsDialogBridge>
): React.JSX.Element => {
  return (
    <Suspense fallback={null}>
      <LazyTeamMemberSettingsDialogBridge {...props} />
    </Suspense>
  );
};
