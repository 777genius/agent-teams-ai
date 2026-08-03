import { deriveHostedReadinessBannerState } from '../../core/domain/HostedReadinessProjectionPolicy';

import type { HostedReadinessProjection } from '../../contracts';

export interface HostedReadinessBannerProps {
  readonly projection: HostedReadinessProjection;
}

const COPY = Object.freeze({
  ready: Object.freeze({
    heading: 'Hosted features are ready',
    description: 'The hosted features offered by this deployment are available.',
  }),
  degraded: Object.freeze({
    heading: 'Hosted features are degraded',
    description: 'Some hosted features are temporarily unavailable. Try again after they recover.',
  }),
  not_offered: Object.freeze({
    heading: 'Hosted features are not offered',
    description: 'This deployment does not offer hosted product features.',
  }),
});

export const HostedReadinessBanner = ({ projection }: HostedReadinessBannerProps) => {
  const state = deriveHostedReadinessBannerState(projection);
  const copy = COPY[state];
  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={copy.heading}
      data-hosted-readiness-state={state}
      className="bg-card text-card-foreground rounded-md border border-border px-4 py-3"
    >
      <h2 className="text-sm font-semibold">{copy.heading}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{copy.description}</p>
    </section>
  );
};
