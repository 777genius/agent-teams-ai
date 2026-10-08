import { requireThat } from './contract.js';
import { RELEASE216_TOOLING } from './nativeReadinessAuthority.js';

export function checkPublisherExecution(
  toolingSha: string,
  executionSha: string,
  githubSha: string | undefined,
  checkoutSha: string,
  planSha256: string
): void {
  requireThat(/^[a-f0-9]{40}$/.test(executionSha), 'Invalid publisher execution SHA');
  requireThat(
    githubSha === executionSha && checkoutSha === executionSha,
    'Wrong actual publisher execution'
  );
  if (executionSha !== toolingSha)
    requireThat(
      toolingSha === RELEASE216_TOOLING &&
        planSha256 === '87207cedd0bf2a8a7fcee0ea44c876a04acea0873c30553b9da26bafa62f4c91',
      'Separate publisher requires original release216 plan'
    );
}
