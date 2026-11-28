import { assemblyFor, declareModule, input } from '@get-modular/assembly';
import { githubGroup, GitHubHost, githubModule } from '@pr-monitor/github/module';

import type { PullRequestReader } from '@pr-monitor/core';
import type { GitHubTransport } from '@pr-monitor/github';
import type { GitHubCapabilities } from '@pr-monitor/github/module';

const host = input<GitHubCapabilities>()(
  declareModule({
    moduleId: 'desktop/pr-monitor-host',
    implementationId: 'desktop/pr-monitor-host/v1',
    owner: { authority: 'desktop', path: ['pr-monitor'] },
    provides: [GitHubHost.provide()],
    slots: [],
  })
);

function prepare() {
  return assemblyFor<GitHubCapabilities>().prepare({
    profileId: 'desktop/pr-monitor',
    modules: [githubGroup],
    roots: { reader: githubModule },
    inputs: { host },
  });
}

/** One validated static graph, with host-owned transport bound per repository. */
export function createGitHubReaders() {
  let graph: ReturnType<typeof prepare> | undefined;
  return {
    get(transport: GitHubTransport): Promise<PullRequestReader> {
      graph ??= prepare();
      return graph.then(async (prepared) => {
        if (prepared.status === 'failed')
          throw new Error('Pull request module could not be prepared.');
        const outcome = await prepared.prepared.run({
          signal: AbortSignal.timeout(5_000),
          inputs: {
            host: { 'pr-monitor/github/host': { transport } },
          },
        });
        if (outcome.status !== 'succeeded')
          throw new Error('Pull request module could not be connected.');
        return outcome.roots.reader;
      });
    },
    dispose() {
      graph = undefined;
    },
  };
}
