export const hostedElectronApiFixtureSource = [
  "import type { ElectronAPI } from '@shared/types/api';",
  'export interface HostedTeamFacet extends ElectronAPI {',
  "  teams: ElectronAPI['teams'];",
  '}',
].join('\n');
