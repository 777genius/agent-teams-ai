/* eslint-disable react/jsx-props-no-spreading -- Standard shadcn pattern: forward remaining props to underlying elements */
import * as React from 'react';

import { cn } from '@renderer/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-border-emphasis)] focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-[var(--color-text)] text-[var(--color-surface)] shadow',
        secondary:
          'border-transparent bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]',
        destructive: 'border-transparent bg-red-500 text-white shadow',
        outline: 'border-[var(--color-border)] text-[var(--color-text)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
  }
);
Badge.displayName = 'Badge';

// eslint-disable-next-line react-refresh/only-export-components -- Standard shadcn export pattern
export { Badge, badgeVariants };
/* eslint-enable react/jsx-props-no-spreading -- Re-enable after shadcn component */
