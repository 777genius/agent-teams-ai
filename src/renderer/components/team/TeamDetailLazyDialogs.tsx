import { lazy, Suspense } from 'react';

import type { ComponentProps } from 'react';

// Keep closed dialog graphs out of the initial Team view, including after reload.
const LazyAddMemberDialog = lazy(() =>
  import('./dialogs/AddMemberDialog').then((module) => ({ default: module.AddMemberDialog }))
);
const LazyEditTeamDialog = lazy(() =>
  import('./dialogs/EditTeamDialog').then((module) => ({ default: module.EditTeamDialog }))
);
const LazyReviewDialog = lazy(() =>
  import('./dialogs/ReviewDialog').then((module) => ({ default: module.ReviewDialog }))
);
const LazyTrashDialog = lazy(() =>
  import('./kanban/TrashDialog').then((module) => ({ default: module.TrashDialog }))
);

export const AddMemberDialog = (
  props: ComponentProps<typeof LazyAddMemberDialog>
): React.JSX.Element | null => {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyAddMemberDialog {...props} />
    </Suspense>
  ) : null;
};

export const EditTeamDialog = (
  props: ComponentProps<typeof LazyEditTeamDialog>
): React.JSX.Element | null => {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyEditTeamDialog {...props} />
    </Suspense>
  ) : null;
};

export const ReviewDialog = (
  props: ComponentProps<typeof LazyReviewDialog>
): React.JSX.Element | null => {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyReviewDialog {...props} />
    </Suspense>
  ) : null;
};

export const TrashDialog = (
  props: ComponentProps<typeof LazyTrashDialog>
): React.JSX.Element | null => {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyTrashDialog {...props} />
    </Suspense>
  ) : null;
};
