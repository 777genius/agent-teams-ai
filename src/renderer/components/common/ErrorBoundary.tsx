import React, { Component, type ErrorInfo, type ReactNode } from 'react';

import { useStore } from '@renderer/store';
import { createLogger } from '@shared/utils/logger';
import { AlertTriangle, Bug, Check, Copy, RefreshCw } from 'lucide-react';

import {
  buildBugReportText,
  buildGitHubBugReportUrl,
  type BugReportContext,
} from '@renderer/utils/bugReportUtils';

const logger = createLogger('Component:ErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  copiedReport: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  private copyResetTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      copiedReport: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReset = (): void => {
    if (this.copyResetTimeout) {
      clearTimeout(this.copyResetTimeout);
      this.copyResetTimeout = null;
    }

    this.setState({
      hasError: false,
      copiedReport: false,
      error: null,
      errorInfo: null,
    });
  };

  componentWillUnmount(): void {
    if (this.copyResetTimeout) {
      clearTimeout(this.copyResetTimeout);
      this.copyResetTimeout = null;
    }
  }

  getBugReportContext = (): BugReportContext => {
    const state = useStore.getState();
    const activeTab = state.getActiveTab();

    return {
      activeTabType: activeTab?.type ?? null,
      activeTabLabel: activeTab?.label ?? null,
      activeTeamName: activeTab?.teamName ?? null,
      selectedTeamName: state.selectedTeamName,
      taskId: state.globalTaskDetail?.taskId ?? state.pendingReviewRequest?.taskId ?? null,
      sessionId: activeTab?.sessionId ?? null,
      projectId: activeTab?.projectId ?? state.activeProjectId,
    };
  };

  handleCreateGitHubIssue = (): void => {
    const issueUrl = buildGitHubBugReportUrl({
      error: this.state.error,
      componentStack: this.state.errorInfo?.componentStack ?? null,
      context: this.getBugReportContext(),
    });

    if (window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(issueUrl);
      return;
    }

    window.open(issueUrl, '_blank', 'noopener,noreferrer');
  };

  handleCopyErrorDetails = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        buildBugReportText({
          error: this.state.error,
          componentStack: this.state.errorInfo?.componentStack ?? null,
          context: this.getBugReportContext(),
        })
      );

      if (this.copyResetTimeout) {
        clearTimeout(this.copyResetTimeout);
      }

      this.setState({ copiedReport: true });
      this.copyResetTimeout = setTimeout(() => {
        this.setState({ copiedReport: false });
        this.copyResetTimeout = null;
      }, 2000);
    } catch (error) {
      logger.warn('Failed to copy error details:', error);
    }
  };

  // eslint-disable-next-line sonarjs/function-return-type -- Error boundaries inherently return different content based on error state
  render(): ReactNode {
    const { hasError, copiedReport, error, errorInfo } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="flex h-screen flex-col items-center justify-center bg-claude-dark-bg p-8 text-claude-dark-text">
          <div className="mb-6 flex items-center gap-3">
            <AlertTriangle className="size-10 text-red-500" />
            <h1 className="text-2xl font-semibold">Something went wrong</h1>
          </div>

          <p className="mb-6 max-w-md text-center text-claude-dark-text-secondary">
            An unexpected error occurred in the application. You can try reloading the page or
            resetting the error state.
          </p>

          {error && (
            <div className="mb-6 w-full max-w-2xl overflow-auto rounded-lg border border-claude-dark-border bg-claude-dark-surface p-4">
              <p className="mb-2 font-mono text-sm text-red-400">{error.message}</p>
              {errorInfo?.componentStack && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-claude-dark-text-secondary hover:text-claude-dark-text">
                    Component Stack
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-claude-dark-text-secondary">
                    {errorInfo.componentStack}
                  </pre>
                </details>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-center gap-4">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 rounded-lg border border-claude-dark-border bg-claude-dark-surface px-4 py-2 transition-colors hover:bg-claude-dark-border"
            >
              Try Again
            </button>
            <button
              onClick={() => void this.handleCopyErrorDetails()}
              className="flex items-center gap-2 rounded-lg border border-claude-dark-border bg-claude-dark-surface px-4 py-2 transition-colors hover:bg-claude-dark-border"
            >
              {copiedReport ? (
                <Check className="size-4 text-green-400" />
              ) : (
                <Copy className="size-4" />
              )}
              {copiedReport ? 'Copied' : 'Copy Error Details'}
            </button>
            <button
              onClick={this.handleCreateGitHubIssue}
              className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-red-300 transition-colors hover:bg-red-500/20"
            >
              <Bug className="size-4" />
              Report Bug on GitHub
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 transition-colors hover:bg-blue-700"
            >
              <RefreshCw className="size-4" />
              Reload App
            </button>
          </div>
          <p className="mt-4 max-w-md text-center text-xs text-claude-dark-text-secondary">
            GitHub bug reports and copied diagnostics include the error message, stack traces, app
            version, active tab, selected team, task context, and environment details.
          </p>
        </div>
      );
    }

    return children;
  }
}
