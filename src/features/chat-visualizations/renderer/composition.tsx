import * as React from 'react';

import type { FenceState, VisualizationPresentation } from '../contracts';

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

const ChatVisualizationPresentationContext = React.createContext<VisualizationPresentation | null>(
  null
);

export const ChatVisualizationPresentationProvider = ({
  presentation,
  children,
}: Readonly<{
  presentation: VisualizationPresentation;
  children: React.ReactNode;
}>): React.JSX.Element => (
  <ChatVisualizationPresentationContext.Provider value={presentation}>
    {children}
  </ChatVisualizationPresentationContext.Provider>
);

export function useChatVisualizationPresentation(): VisualizationPresentation | null {
  return React.useContext(ChatVisualizationPresentationContext);
}
