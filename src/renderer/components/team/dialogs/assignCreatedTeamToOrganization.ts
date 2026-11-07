import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';

import type { OrganizationPlacementSelection } from '@features/organizations/contracts';

/**
 * Organization placement is a separate post-create operation.
 * Never throw a placement failure back to the create operation: the team already
 * exists, and retrying creation would risk a duplicate team.
 */
export async function assignCreatedTeamToOrganization({
  placement,
  teamName,
  label,
  failureTitle,
  failureMessage,
  acknowledgeLabel,
}: {
  placement: OrganizationPlacementSelection | null | undefined;
  teamName: string;
  label: string;
  failureTitle: string;
  failureMessage: string;
  acknowledgeLabel: string;
}): Promise<void> {
  if (!placement) return;
  try {
    await api.organizations.assignTeamToUnit({
      ...placement,
      teamName,
      label,
    });
  } catch (error) {
    console.warn('[Organizations] Failed to place created team in organization', error);
    await confirm({
      mode: 'info',
      title: failureTitle,
      message: failureMessage,
      confirmLabel: acknowledgeLabel,
    });
  }
}
