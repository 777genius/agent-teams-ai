import { Info } from 'lucide-react';

import type { JSX } from 'react';

export interface LocalTeammateModelRequirementsProps {
  readonly title: string;
  readonly size: string;
  readonly tools: string;
  readonly context: string;
  readonly tiny: string;
}

/** Always-visible teammate size/context/tool requirements for local model settings. */
export const LocalTeammateModelRequirements = ({
  title,
  size,
  tools,
  context,
  tiny,
}: LocalTeammateModelRequirementsProps): JSX.Element => {
  return (
    <div
      data-testid="local-teammate-model-requirements"
      className="rounded-md border border-cyan-300/20 bg-cyan-300/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-cyan-50"
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 size-3.5 shrink-0 text-cyan-200" aria-hidden="true" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium text-cyan-50">{title}</p>
          <ul className="list-disc space-y-1 pl-4 text-cyan-100/80">
            <li>{size}</li>
            <li>{tools}</li>
            <li>{context}</li>
            <li>{tiny}</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
