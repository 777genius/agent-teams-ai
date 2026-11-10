import * as React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ThemeProvider } from '@openuidev/react-ui';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@renderer/components/ui/dialog';
import { useTheme } from '@renderer/hooks/useTheme';

import { useChatVisualizationPresentation } from '../composition';

import { VisualizationErrorBoundary } from './VisualizationErrorBoundary';

import type { VisualizationKind, VisualizationPresentation } from '../../contracts';
import type { VisualizationStatus } from '../evaluateChatVisualization';

export const CHAT_VISUALIZATION_INLINE_THRESHOLD_PX = 640;
interface Props {
  kind: VisualizationKind;
  status: VisualizationStatus;
  children: React.ReactNode;
}

function useMeasuredPresentation(
  ref: React.RefObject<HTMLElement | null>,
  override: VisualizationPresentation | null
): VisualizationPresentation {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    if (override) return;
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries.at(-1)?.contentRect.width ?? 0)
    );
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref, override]);
  if (override) return override;
  return width !== null && width >= CHAT_VISUALIZATION_INLINE_THRESHOLD_PX ? 'inline' : 'card';
}
const StatusText = ({
  status,
}: Readonly<{ status: VisualizationStatus }>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (status === 'incomplete')
    return (
      <p role="status">
        {t('activity.chatVisualization.incomplete', { defaultValue: 'Visualization incomplete' })}
      </p>
    );
  if (status === 'unavailable')
    return (
      <p role="alert">
        {t('activity.chatVisualization.unavailable', { defaultValue: 'Visualization unavailable' })}
      </p>
    );
  if (status === 'limit')
    return (
      <p role="alert">
        {t('activity.chatVisualization.exceedsLimits', {
          defaultValue: 'Visualization exceeds display limits',
        })}
      </p>
    );
  return null;
};
export const VisualizationShell = ({
  kind,
  status,
  children,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { resolvedTheme } = useTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const forcedPresentation = useChatVisualizationPresentation();
  const presentation = useMeasuredPresentation(containerRef, forcedPresentation);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  React.useLayoutEffect(() => {
    if (forcedPresentation === 'inline') setDialogOpen(false);
  }, [forcedPresentation]);
  const title = kind === 'mermaid' ? 'Diagram' : 'Visualization';
  // Keep the trigger and the sole active renderer in place while the modal is open.
  const activePresentation = dialogOpen ? 'card' : presentation;
  const content = (
    <>
      <StatusText status={status} />
      <VisualizationErrorBoundary fallback={<StatusText status="unavailable" />}>
        {children}
      </VisualizationErrorBoundary>
    </>
  );
  return (
    <ThemeProvider mode={resolvedTheme} cssSelector=".chat-visualization-theme">
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <div
          ref={containerRef}
          role="presentation"
          tabIndex={-1}
          className={`chat-visualization-shell chat-visualization-theme chat-visualization-${activePresentation}`}
          data-chat-visualization-kind={kind}
          data-chat-visualization-presentation={activePresentation}
          data-chat-visualization-status={status}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
        >
          {activePresentation === 'inline' ? (
            content
          ) : (
            <div className="chat-visualization-compact">
              <div>
                <strong>{title}</strong>
                <StatusText status={status} />
              </div>
              <DialogTrigger asChild>
                <Button type="button">
                  {t('activity.chatVisualization.open', { defaultValue: 'Open visualization' })}
                </Button>
              </DialogTrigger>
            </div>
          )}
          <DialogContent
            className="chat-visualization-dialog chat-visualization-theme"
            data-chat-visualization-kind={kind}
            data-chat-visualization-presentation="inline"
            data-chat-visualization-status={status}
            onCloseAutoFocus={(event) => {
              if (presentation === 'inline') {
                event.preventDefault();
                containerRef.current?.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {t('activity.chatVisualization.description', {
                  defaultValue: 'Full visualization view',
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="chat-visualization-dialog-body">{content}</div>
          </DialogContent>
        </div>
      </Dialog>
    </ThemeProvider>
  );
};
