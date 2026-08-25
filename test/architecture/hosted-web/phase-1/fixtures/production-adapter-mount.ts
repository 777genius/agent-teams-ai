export const productionAdapterMountFixtureSource = [
  "import { createTestComposition } from '../../../test/features/team-lifecycle/conformance/test-composition';",
  'export const hostedProductionComposition = createTestComposition();',
].join('\n');
