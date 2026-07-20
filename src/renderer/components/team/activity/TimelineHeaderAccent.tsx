import type { JSX } from 'react';

interface TimelineHeaderAccentProps {
  color: string;
}

export const TimelineHeaderAccent = ({ color }: TimelineHeaderAccentProps): JSX.Element => (
  <span
    aria-hidden="true"
    data-timeline-header-accent
    className="pointer-events-none absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-[1px]"
    style={{ backgroundColor: color }}
  />
);
