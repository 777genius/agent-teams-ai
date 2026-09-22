/**
 * React error boundary wrapping CodeMirrorEditor.
 *
 * Catches runtime CM6 errors (OOM, bad extension, corrupted EditorState)
 * and shows a fallback UI instead of crashing the entire overlay.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { captureRendererException } from '@renderer/sentry';
import { AlertTriangle } from 'lucide-react';

interface Props {
  filePath: string;
  onRetry?: () => void;
  children: React.ReactNode;
  labels?: {
    crashed: string;
    unknownError: string;
    retry: string;
  };
}

interface State {
  hasError: boolean;
  error: string | null;
}

class EditorErrorBoundaryInner extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[EditorErrorBoundary] ${this.props.filePath}:`, error, info.componentStack);
    captureRendererException(error, { componentStack: info.componentStack });
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
            {this.props.labels?.crashed}: {this.state.error ?? this.props.labels?.unknownError}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
          >
            {this.props.labels?.retry}
          </button>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

export const EditorErrorBoundary = ({
  children,
  ...props
}: Omit<Props, 'labels'>): React.ReactElement => {
  const { t } = useAppTranslation('team');
  return (
    <EditorErrorBoundaryInner
      {...props}
      labels={{
        crashed: t('editor.errorBoundary.crashed'),
        unknownError: t('editor.errorBoundary.unknownError'),
        retry: t('editor.actions.retry'),
      }}
    >
      {children}
    </EditorErrorBoundaryInner>
  );
};
