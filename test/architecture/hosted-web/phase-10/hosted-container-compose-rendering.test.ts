import { describe, expect, it } from 'vitest';

import { restoreExplicitBindCreateHostPathFalse } from '../../../../scripts/ci/verify-hosted-container-compose-rendering.mjs';

const LIFECYCLE_TARGET = '/run/agent-teams-orchestrator';

function renderedCompose() {
  return {
    services: {
      application: {
        volumes: [
          {
            type: 'bind',
            source: '/tmp/orchestrator',
            target: LIFECYCLE_TARGET,
            read_only: true,
          },
          {
            type: 'bind',
            source: '/tmp/unrelated',
            target: '/run/unrelated',
            bind: { propagation: 'rprivate' },
          },
        ],
      },
      unrelated: {
        volumes: [
          {
            type: 'bind',
            source: '/tmp/other-service',
            target: LIFECYCLE_TARGET,
          },
        ],
      },
    },
  };
}

function rawCompose(createHostPath: boolean | undefined) {
  const bind =
    createHostPath === undefined
      ? '        bind:\n          propagation: rprivate\n'
      : `        bind:\n          create_host_path: ${createHostPath}\n`;
  return `services:
  application:
    volumes:
      - type: bind
        source: /tmp/orchestrator
        target: ${LIFECYCLE_TARGET}
${bind}`;
}

describe('hosted Compose rendering compatibility normalization', () => {
  it('restores an explicitly false raw long-syntax bind option', () => {
    const rendered = renderedCompose();

    expect(restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false))).toBe(rendered);
    expect(rendered.services.application.volumes[0].bind).toEqual({
      create_host_path: false,
    });
  });

  it.each([
    ['missing', undefined],
    ['true', true],
  ])('does not restore false when the raw bind option is %s', (_label, createHostPath) => {
    const rendered = renderedCompose();

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(createHostPath));

    expect(rendered.services.application.volumes[0]).not.toHaveProperty('bind');
  });

  it('does not change mounts outside the matching raw service and target', () => {
    const rendered = renderedCompose();
    const unrelatedApplicationMount = structuredClone(rendered.services.application.volumes[1]);
    const unrelatedServiceMount = structuredClone(rendered.services.unrelated.volumes[0]);

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false));

    expect(rendered.services.application.volumes[1]).toEqual(unrelatedApplicationMount);
    expect(rendered.services.unrelated.volumes[0]).toEqual(unrelatedServiceMount);
  });

  it('does not overwrite an explicit true value emitted by Compose', () => {
    const rendered = renderedCompose();
    rendered.services.application.volumes[0].bind = { create_host_path: true };

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false));

    expect(rendered.services.application.volumes[0].bind).toEqual({
      create_host_path: true,
    });
  });
});
