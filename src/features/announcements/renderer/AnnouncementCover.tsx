import { useEffect, useRef, useState } from 'react';

import { Newspaper } from 'lucide-react';

import type { AnnouncementsApi } from '../contracts';

let nextRequest = 0;

export const AnnouncementCover = ({
  client,
  id,
  revision,
  available,
}: {
  client: AnnouncementsApi;
  id: string;
  revision: string | null;
  available: boolean;
}): React.JSX.Element => {
  const container = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    setSource(null);
    if (!available) return;
    const requestId = `cover_${(++nextRequest).toString(36)}`;
    let alive = true;
    let started = false;
    const load = (): void => {
      if (started) return;
      started = true;
      void client
        .loadCover(id, requestId)
        .then((value) => {
          if (alive && value) setSource(value);
        })
        .catch(() => undefined);
    };
    const node = container.current;
    let observer: IntersectionObserver | null = null;
    if (node && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            load();
          }
        },
        { rootMargin: '160px 0px' }
      );
    }
    if (node && observer) observer.observe(node);
    else load();
    return () => {
      alive = false;
      observer?.disconnect();
      if (started) void client.cancelCover(requestId).catch(() => undefined);
    };
  }, [available, client, id, revision]);

  return (
    <span
      ref={container}
      aria-hidden="true"
      className="relative min-h-[104px] overflow-hidden border-r border-[var(--color-border)] bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--color-accent)_24%,transparent),transparent_62%),var(--color-surface-raised)]"
    >
      {source ? (
        <img
          src={source}
          alt=""
          className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover:scale-[1.035] motion-reduce:transition-none"
          onError={() => setSource(null)}
        />
      ) : (
        <Newspaper className="absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 text-[var(--color-text-muted)] opacity-55" />
      )}
      <span className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-black/[0.08]" />
    </span>
  );
};
