import '../disableDevtools';

import * as React from 'react';

import { Renderer } from '@openuidev/react-lang';

import { chatVisualizationLibrary } from '../chatVisualizationLibrary';

import type { FenceState } from '../../contracts';
import type { OpenUIError } from '@openuidev/react-lang';

export const OpenUIVisualization = ({
  source,
  fenceState,
  onFailure,
}: Readonly<{
  source: string;
  fenceState: FenceState;
  onFailure: () => void;
}>): React.JSX.Element => {
  const handleErrors = React.useCallback(
    (errors: OpenUIError[]) => {
      if (fenceState === 'closed' && errors.length > 0) onFailure();
    },
    [fenceState, onFailure]
  );
  return (
    <Renderer
      response={source}
      library={chatVisualizationLibrary}
      isStreaming={fenceState === 'open'}
      onError={handleErrors}
      publishObservability={false}
    />
  );
};
