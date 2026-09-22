/**
 * FileIcon — renders a file-type icon.
 *
 * For programming languages/frameworks: uses Devicon CDN SVG (real colorful logos).
 * For generic types (images, fonts, configs): uses lucide-react icons with tinted color.
 * Falls back to lucide if the Devicon image fails to load.
 *
 * Applies a subtle glow (drop-shadow) in dark mode so dark-colored icons
 * remain visible against dark backgrounds (e.g. Go, Rust, C).
 */

import { memo, useCallback, useState } from 'react';

import { cn } from '@renderer/lib/utils';

import { getDeviconUrl, getFileIcon } from './fileIcons';

// =============================================================================
// Types
// =============================================================================

interface FileIconProps {
  /** File name (e.g. "index.ts", "Dockerfile", "logo.png") */
  fileName: string;
  /** Tailwind size class (e.g. "size-3.5", "size-4"). Defaults to "size-3.5" */
  className?: string;
}

// Track slugs that failed to load so we don't retry them across mounts
const failedSlugs = new Set<string>();

// =============================================================================
// Component
// =============================================================================

export const FileIcon = memo(({ fileName, className = 'size-3.5' }: FileIconProps) => {
  const info = getFileIcon(fileName);
  const slug = info.deviconSlug;
  const canUseDevicon = slug != null && !failedSlugs.has(slug);

  const [imgFailed, setImgFailed] = useState(false);

  const handleError = useCallback(() => {
    if (slug) failedSlugs.add(slug);
    setImgFailed(true);
  }, [slug]);

  if (canUseDevicon && !imgFailed) {
    return (
      <img
        src={getDeviconUrl(slug)}
        className={cn('file-icon-glow shrink-0', className)}
        onError={handleError}
        alt=""
        draggable={false}
        loading="lazy"
      />
    );
  }

  // Fallback to lucide icon
  const Icon = info.icon;
  return <Icon className={cn('shrink-0', className)} style={{ color: info.color }} />;
});

FileIcon.displayName = 'FileIcon';
