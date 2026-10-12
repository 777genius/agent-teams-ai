import * as React from 'react';

import type { FenceState } from '../contracts';

export interface MermaidVisualizationProps {
  source: string;
  fenceState: FenceState;
}

export type MermaidVisualizationAdapter = React.ComponentType<MermaidVisualizationProps>;

interface ChatVisualizationCompositionValue {
  MermaidVisualization: MermaidVisualizationAdapter | null;
}

const ChatVisualizationCompositionContext = React.createContext<ChatVisualizationCompositionValue>({
  MermaidVisualization: null,
});

export const ChatVisualizationProvider = ({
  MermaidVisualization,
  children,
}: Readonly<{
  MermaidVisualization: MermaidVisualizationAdapter;
  children: React.ReactNode;
}>): React.JSX.Element => {
  const value = React.useMemo(() => ({ MermaidVisualization }), [MermaidVisualization]);
  return (
    <ChatVisualizationCompositionContext.Provider value={value}>
      {children}
    </ChatVisualizationCompositionContext.Provider>
  );
};

export function useChatVisualizationComposition(): ChatVisualizationCompositionValue {
  return React.useContext(ChatVisualizationCompositionContext);
}
