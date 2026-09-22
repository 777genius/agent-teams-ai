import * as React from 'react';

import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { cn } from '@renderer/lib/utils';

type ComposerSurfaceProps = React.ComponentPropsWithoutRef<'div'>;

export const ComposerSurface = React.forwardRef<HTMLDivElement, ComposerSurfaceProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('message-composer-flat-layout relative', className)} {...props} />
  )
);
ComposerSurface.displayName = 'ComposerSurface';

interface ComposerTextareaProps extends React.ComponentPropsWithoutRef<typeof MentionableTextarea> {
  connectedToHeader?: boolean;
}

export const ComposerTextarea = React.forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(
  (
    {
      connectedToHeader = false,
      surfaceClassName,
      surfaceFadeColor,
      className,
      footerClassName,
      ...props
    },
    ref
  ) => (
    <MentionableTextarea
      ref={ref}
      {...props}
      surfaceClassName={cn(
        'message-composer-flat-body',
        !connectedToHeader && 'message-composer-flat-body-standalone',
        surfaceClassName
      )}
      surfaceFadeColor={surfaceFadeColor ?? 'var(--message-composer-flat-bg)'}
      className={cn('rounded-none border-0 shadow-none focus-visible:ring-0', className)}
      footerClassName={cn('message-composer-flat-footer', footerClassName)}
    />
  )
);
ComposerTextarea.displayName = 'ComposerTextarea';
