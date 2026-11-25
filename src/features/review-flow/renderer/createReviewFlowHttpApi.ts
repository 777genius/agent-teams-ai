import type { ReviewFlowElectronApi } from '../contracts';

/** Review flow settings require the captured Desktop owner. */
export function createReviewFlowHttpApi(): ReviewFlowElectronApi {
  const unavailable = async (): Promise<never> => {
    throw new Error('Review flow settings are only available in the desktop app');
  };
  return { getOverview: unavailable, setDefaults: unavailable, setTeamOverride: unavailable };
}
