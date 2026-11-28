import { isAbsolute } from 'node:path';

/** Immutable Main-selected read source, reused for the original owner's explicit recovery. */
export function captureReviewFlowDefaultsEnvironment(
  directory?: string
): Readonly<Record<string, string>> {
  if (directory !== undefined && (!isAbsolute(directory) || directory.includes('\0')))
    throw new TypeError('Invalid review flow defaults source');
  // Clear any ambient/profile value when composition did not select the app source.
  return Object.freeze({ AGENT_TEAMS_REVIEW_FLOW_DEFAULTS_DIRECTORY: directory ?? '' });
}
