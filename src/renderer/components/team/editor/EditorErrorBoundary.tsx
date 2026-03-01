/**
 * React error boundary wrapping CodeMirrorEditor.
 *
 * Catches runtime CM6 errors (OOM, bad extension, corrupted EditorState)
 * and shows a fallback UI instead of crashing the entire overlay.
 */

import React from 'react';

import { AlertTriangle } from 'lucide-react';

interface Props {
  filePath: string;
  onRetry?: () => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: string | null;
}

export class EditorErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[EditorErrorBoundary] ${this.props.filePath}:`, error, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render(): React.ReactElement {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          aria-live="polite"
          className="flex h-full flex-col items-center justify-center gap-3 text-text-muted"
        >
          <AlertTriangle aria-hidden="true" className="size-12 text-red-400 opacity-50" />
          <p className="max-w-md text-center text-sm text-text-secondary">
            Editor crashed: {this.state.error ?? 'Unknown error'}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
          >
            Retry
          </button>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}
