import * as React from 'react';

interface Props {
  children: React.ReactNode;
  fallback: React.ReactNode;
}

interface State {
  failed: boolean;
}

export class VisualizationErrorBoundary extends React.Component<Readonly<Props>, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidUpdate(previousProps: Props): void {
    if (previousProps.children !== this.props.children && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
