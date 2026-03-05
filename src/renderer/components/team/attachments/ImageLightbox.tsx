import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';

import { useMemo } from 'react';

import Lightbox from 'yet-another-react-lightbox';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

import type { Plugin, Slide } from 'yet-another-react-lightbox';

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
        container: { backgroundColor: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)' },
      }}
    />
  );
};
