export type VisualizationKind = 'openui' | 'mermaid';

export type FenceState = 'open' | 'closed';

export interface VisualizationBlockProps {
  readonly kind: VisualizationKind;
  readonly source: string;
  readonly fenceState: FenceState;
}

export type VisualizationPresentation = 'inline' | 'card';
