import '@openuidev/react-ui/components.css';
import './chatVisualization.css';

import * as React from 'react';

import { useChatVisualizationComposition } from '../composition';
import { evaluateChatVisualization } from '../evaluateChatVisualization';
import { createChatVisualizationParser } from '../parseChatVisualization';

import { OpenUIVisualization } from './OpenUIVisualization';
import { VisualizationShell } from './VisualizationShell';

import type { VisualizationBlockProps } from '../../contracts';
import type { VisualizationStatus } from '../evaluateChatVisualization';

export const VisualizationBlock = ({
  kind,
  source,
  fenceState,
}: Readonly<VisualizationBlockProps>): React.JSX.Element => {
  const { MermaidVisualization } = useChatVisualizationComposition();
  const [parser] = React.useState(createChatVisualizationParser);
  const [failedSource, setFailedSource] = React.useState<string | null>(null);
  const onFailure = React.useCallback(() => setFailedSource(source), [source]);
  const evaluation = React.useMemo(
    () =>
      kind === 'openui'
        ? evaluateChatVisualization(parser, source, fenceState)
        : {
            status: fenceState === 'open' ? ('incomplete' as const) : ('content' as const),
            canRender: true,
          },
    [kind, parser, source, fenceState]
  );
  const status: VisualizationStatus = failedSource === source ? 'unavailable' : evaluation.status;
  return (
    <VisualizationShell kind={kind} status={status}>
      {evaluation.canRender &&
        status !== 'unavailable' &&
        (kind === 'openui' ? (
          <OpenUIVisualization source={source} fenceState={fenceState} onFailure={onFailure} />
        ) : MermaidVisualization ? (
          <MermaidVisualization source={source} fenceState={fenceState} />
        ) : null)}
    </VisualizationShell>
  );
};
