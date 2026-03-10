import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';

import { createContext, useContext, useEffect, useRef, useMemo } from 'react';

import Lightbox from 'yet-another-react-lightbox';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

import type { Plugin, Slide } from 'yet-another-react-lightbox';

// ---------------------------------------------------------------------------
// LightboxLock context — allows a parent (e.g. Dialog) to know when a
// lightbox is open so it can block dismiss events.
// ---------------------------------------------------------------------------

type LightboxLockCallback = (open: boolean) => void;

const LightboxLockContext = createContext<LightboxLockCallback | null>(null);

/**
 * Wrap a Dialog (or any dismissable container) with this provider and pass a
 * callback that receives `true` when a lightbox opens and `false` when it closes.
 */
export const LightboxLockProvider = LightboxLockContext.Provider;

export interface ImageLightboxSlide {
  src: string;
  alt?: string;
  title?: string;
}

interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  /** Array of slides for gallery mode. */
  slides?: ImageLightboxSlide[];
  /** Starting slide index (default: 0). */
  index?: number;
  /** Single image src — convenience shorthand for `slides={[{ src }]}`. */
  src?: string;
  /** Alt text for single-image mode. */
  alt?: string;
  enableZoom?: boolean;
  enableFullscreen?: boolean;
  showCounter?: boolean;
  /** Called when lightbox open state changes (useful for parent components to block dismiss). */
  onOpenChange?: (open: boolean) => void;
}

export const ImageLightbox = ({
  open,
  onClose,
  slides: slidesProp,
  index = 0,
  src,
  alt,
  enableZoom = true,
  enableFullscreen = true,
  showCounter,
  onOpenChange,
}: ImageLightboxProps): React.JSX.Element | null => {
  const slides = useMemo<Slide[]>(() => {
    if (slidesProp && slidesProp.length > 0) {
      return slidesProp.map((s) => ({ src: s.src, alt: s.alt, title: s.title }));
    }
    if (src) {
      return [{ src, alt }];
    }
    return [];
  }, [slidesProp, src, alt]);

  const plugins = useMemo<Plugin[]>(() => {
    const list: Plugin[] = [];
    if (enableZoom) list.push(Zoom);
    if (enableFullscreen) list.push(Fullscreen);
    // Show counter only when multiple slides (unless explicitly set)
    const shouldShowCounter = showCounter ?? slides.length > 1;
    if (shouldShowCounter) list.push(Counter);
    return list;
  }, [enableZoom, enableFullscreen, showCounter, slides.length]);

  // Resolve the lightbox lock callback: explicit prop takes priority, then context.
  const contextLock = useContext(LightboxLockContext);
  const lockCallback = onOpenChange ?? contextLock;
  const lockCallbackRef = useRef(lockCallback);
  lockCallbackRef.current = lockCallback;

  // Track our notified state to avoid double-calling.
  const notifiedOpenRef = useRef(false);

  // Notify parent on mount when open=true and on unmount.
  useEffect(() => {
    if (open && !notifiedOpenRef.current) {
      notifiedOpenRef.current = true;
      lockCallbackRef.current?.(true);
    }
    return () => {
      if (notifiedOpenRef.current) {
        notifiedOpenRef.current = false;
        lockCallbackRef.current?.(false);
      }
    };
  }, [open]);

  if (!open || slides.length === 0) return null;

  return (
    <Lightbox
      open={open}
      close={onClose}
      slides={slides}
      index={index}
      plugins={plugins}
      carousel={{ finite: slides.length <= 1 }}
      animation={{ fade: 200 }}
      zoom={{
        maxZoomPixelRatio: 5,
        scrollToZoom: true,
      }}
      styles={{
        // Radix Dialog's DismissableLayer sets body.style.pointerEvents = "none"
        // when modal is open. The lightbox portal renders into body, inheriting
        // pointer-events: none — making all buttons unclickable. Override here.
        root: { pointerEvents: 'auto' },
        container: { backgroundColor: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)' },
        button: { padding: 16 },
      }}
    />
  );
};
