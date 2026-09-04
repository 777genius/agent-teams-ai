import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { getOverlaySnapshot } from '@renderer/hooks/useOverlayOccupancy';
import { ArrowLeft, ArrowUpRight, Newspaper, RefreshCw } from 'lucide-react';

import { AnnouncementMarkdown } from './AnnouncementMarkdown';
import { useAnnouncementHost } from './useAnnouncementHost';

import type { AnnouncementsApi } from '../contracts';

export const AnnouncementHost = ({
  ready,
  client = api.announcements,
}: {
  ready: boolean;
  client?: AnnouncementsApi;
}): React.JSX.Element => {
  const { t, resolvedLanguage } = useAppTranslation('common');
  const host = useAnnouncementHost(client, ready);
  const date = (value: string): string =>
    new Date(value).toLocaleDateString(resolvedLanguage, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  const items = [...(host.snapshot?.items ?? [])].sort((a, b) =>
    b.publishedAt < a.publishedAt ? -1 : b.publishedAt > a.publishedAt ? 1 : a.id < b.id ? 1 : -1
  );
  const unavailable =
    host.snapshot?.status === 'writer_busy' || host.snapshot?.status === 'unavailable';
  const status = host.snapshot?.status;
  const statusKey =
    status === 'offline'
      ? 'announcements.status.offline'
      : status === 'writer_busy'
        ? 'announcements.status.writer_busy'
        : status === 'unavailable'
          ? 'announcements.status.unavailable'
          : status === 'state_unavailable'
            ? 'announcements.status.state_unavailable'
            : null;
  return (
    <Dialog
      open={host.mode !== 'idle'}
      onOpenChange={(open) => {
        if (!open) host.close();
      }}
    >
      <DialogContent
        blocksAnnouncements={false}
        className="max-w-[760px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0"
        onCloseAutoFocus={(event) => {
          if (!document.hasFocus() || getOverlaySnapshot().count > 0) event.preventDefault();
        }}
      >
        <header className="border-b border-[var(--color-border)] px-6 pb-3 pr-12 pt-4">
          <div className="mb-2 flex items-center justify-between gap-4 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
            <span className="flex items-center gap-2">
              <Newspaper className="size-3.5" />
              {t('announcements.title')}
            </span>
            {host.article && (
              <time
                dateTime={host.article.announcement.publishedAt}
                className="shrink-0 normal-case tracking-normal"
                aria-hidden="true"
              >
                {date(host.article.announcement.publishedAt)}
              </time>
            )}
          </div>
          <DialogTitle className="text-xl font-semibold leading-tight tracking-tight">
            {host.article?.announcement.title ?? t('announcements.historyTitle')}
          </DialogTitle>
          <DialogDescription className={host.article ? 'sr-only' : 'mt-1 text-xs leading-relaxed'}>
            {host.article
              ? date(host.article.announcement.publishedAt)
              : t('announcements.description')}
          </DialogDescription>
        </header>
        <div
          className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"
          style={{ maxHeight: 'min(66vh, 720px)' }}
        >
          {host.article ? (
            <article>
              <AnnouncementMarkdown
                markdown={host.article.markdown}
                bodyUrl={host.article.bodyUrl}
                heroImagePath={host.article.announcement.heroImagePath}
                heroImageAlt={host.article.announcement.title}
                notice={
                  <>
                    {statusKey && (
                      <p
                        role="status"
                        className="mb-4 rounded-lg bg-[var(--color-surface-raised)] p-3 text-xs leading-relaxed text-[var(--color-text-muted)]"
                      >
                        {t(statusKey)}
                      </p>
                    )}
                    {host.error && (
                      <p role="alert" className="mb-4 text-sm text-[var(--color-text-muted)]">
                        {t('announcements.loadError')}
                      </p>
                    )}
                    {Date.now() >= Date.parse(host.article.announcement.validUntil) && (
                      <p className="mb-5 text-xs text-[var(--color-text-muted)]">
                        {t('announcements.expired')}
                      </p>
                    )}
                  </>
                }
              />
            </article>
          ) : (
            <div className="px-6 py-5">
              {statusKey && (
                <p
                  role="status"
                  className="mb-4 rounded-lg bg-[var(--color-surface-raised)] p-3 text-xs leading-relaxed text-[var(--color-text-muted)]"
                >
                  {t(statusKey)}
                </p>
              )}
              {host.error && (
                <p role="alert" className="mb-4 text-sm text-[var(--color-text-muted)]">
                  {t('announcements.loadError')}
                </p>
              )}
              {host.loading ? (
                <p
                  role="status"
                  className="py-5 text-center text-sm text-[var(--color-text-muted)]"
                >
                  {t('announcements.loading')}
                </p>
              ) : (
                <div className="space-y-2">
                  {items.length === 0 && (
                    <div className="py-10 text-center">
                      <Newspaper className="mx-auto mb-4 size-8 text-[var(--color-text-muted)]" />
                      <p className="text-sm font-medium text-[var(--color-text)]">
                        {t('announcements.empty')}
                      </p>
                      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                        {t('announcements.emptyDescription')}
                      </p>
                    </div>
                  )}
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={unavailable}
                      onClick={() => void host.openArticle(item.id)}
                      className="group flex w-full items-center justify-between gap-5 rounded-xl border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-border-emphasis)] disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="mb-2 block text-xs text-[var(--color-text-muted)]">
                          {date(item.publishedAt)}
                          {Date.now() >= Date.parse(item.validUntil)
                            ? ` · ${t('announcements.expired')}`
                            : ''}
                        </span>
                        <span className="block break-words text-sm font-medium text-[var(--color-text)]">
                          {item.title}
                        </span>
                      </span>
                      <ArrowUpRight className="size-4 shrink-0 text-[var(--color-text-muted)]" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-6 py-2.5">
          {host.mode === 'history' && host.article ? (
            <Button variant="ghost" size="sm" onClick={host.back}>
              <ArrowLeft className="mr-2 size-4" />
              {t('announcements.allNews')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={host.loading}
              onClick={() => void host.refresh()}
            >
              <RefreshCw className="mr-2 size-3.5" />
              {t('actions.refresh')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={host.close}>
            {t('actions.close')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
};
