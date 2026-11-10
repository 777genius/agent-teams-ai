import { useLayoutEffect, useRef, useState } from 'react';

interface BottomSheetLayoutOptions {
  active: boolean;
  fallbackHeaderHeight: number;
  mountPoint?: Element | null;
  refreshKey: string;
}

interface BottomSheetGeometryOptions {
  footerHeight: number;
  headerHeight: number;
  mountHeight: number;
  snapIndex: number;
}

export function calculateBottomSheetGeometry({
  footerHeight,
  headerHeight,
  mountHeight,
  snapIndex,
}: BottomSheetGeometryOptions) {
  const maxOpenHeight = mountHeight > 0 ? Math.max(mountHeight - 1, 0) : Number.POSITIVE_INFINITY;
  const collapsedHeight = Math.min(headerHeight, maxOpenHeight);
  const composerHeight = Math.min(
    Math.max(collapsedHeight + footerHeight, collapsedHeight + 120),
    maxOpenHeight
  );
  const centeredHeight = Math.min(
    Math.max(mountHeight > 0 ? Math.round(mountHeight * 0.58) : 520, composerHeight + 140),
    maxOpenHeight
  );
  const snapPoints = [0, collapsedHeight, composerHeight, centeredHeight, 1];
  const normalizedSnapIndex = Math.min(Math.max(snapIndex, 1), 4);
  const visibleHeight =
    normalizedSnapIndex === 4 ? mountHeight : (snapPoints[normalizedSnapIndex] ?? 0);
  return {
    contentHeight: Math.max(0, visibleHeight - headerHeight),
    normalizedSnapIndex,
    snapPoints,
  };
}

export function useBottomSheetLayout({
  active,
  fallbackHeaderHeight,
  mountPoint,
  refreshKey,
}: BottomSheetLayoutOptions) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(fallbackHeaderHeight);
  const [footerHeight, setFooterHeight] = useState(196);
  const [mountHeight, setMountHeight] = useState(0);

  useLayoutEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return;

    const mount = mountPoint instanceof HTMLElement ? mountPoint : null;
    const header = headerRef.current;
    const footer = footerRef.current;
    const search = searchRef.current;
    const naturalHeight = (node: HTMLElement | null): number =>
      node
        ? Math.ceil(
            Math.max(
              node.getBoundingClientRect().height,
              node.scrollHeight + node.offsetHeight - node.clientHeight
            )
          )
        : 0;
    const update = (): void => {
      setHeaderHeight(naturalHeight(header) || fallbackHeaderHeight);
      setFooterHeight(naturalHeight(footer) + naturalHeight(search));
      if (mount) setMountHeight(Math.ceil(mount.getBoundingClientRect().height));
    };

    update();
    const observer = new ResizeObserver(update);
    [mount, header, footer, search, footer?.querySelector('[data-messages-composer-content]')]
      .filter((node): node is Element => node instanceof Element)
      .forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [active, fallbackHeaderHeight, mountPoint, refreshKey]);

  return { footerHeight, footerRef, headerHeight, headerRef, mountHeight, searchRef };
}
