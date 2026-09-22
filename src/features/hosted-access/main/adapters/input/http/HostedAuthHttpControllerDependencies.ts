import type { HostedAuthMode } from '../../../../contracts';
import type {
  HostedAuthenticationProvider,
  HostedTeamWorkspaceAttribution,
  OidcAuthenticationCapability,
  PersonalAuthenticationCapability,
} from '../../../../core/application';
import type { HostedHttpAuthorization } from '../../../../core/domain';
import type { InternalStorageHostedAccessRepository } from '../../output/InternalStorageHostedAccessRepository';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedAuthHttpControllerDependencies {
  readonly mode: HostedAuthMode;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly authentication: HostedAuthenticationProvider;
  readonly personal: PersonalAuthenticationCapability | null;
  readonly oidc: OidcAuthenticationCapability | null;
  readonly repository: InternalStorageHostedAccessRepository;
  readonly restoreGeneration: number;
  readonly runtimeIdentity?: { readonly deploymentId: string; readonly bootId: string } | null;
  readonly sessionMaxAgeSeconds: number;
  readonly deviceMaxAgeSeconds: number;
  readonly tryEnterPublicRequest: () => boolean;
  readonly leavePublicRequest: () => void;
  readonly isPublicAccessActive: () => boolean;
  readonly isLifecycleOwnerReady?: () => boolean;
  readonly isTaskBoardMutationRouteEnabled?: () => boolean;
  readonly isTeamMessageSendRouteEnabled?: () => boolean;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  readonly authorizationPolicy?: (method: string, url: string) => HostedHttpAuthorization;
}
