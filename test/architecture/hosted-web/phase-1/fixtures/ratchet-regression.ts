import type {
  ContentRatchet,
  ParityReference,
} from '../../../../../scripts/hosted-web/phase-1/check-parity-references';

export function createParityDriftFixture(reference: ParityReference): ParityReference {
  return { ...reference, semanticTest: '' };
}

export const ratchetRegressionFixture: ContentRatchet = {
  id: 'expired-legacy-team-list-quarantine',
  needle: "'team:list'",
  maximumMatches: 1,
  expired: true,
};
