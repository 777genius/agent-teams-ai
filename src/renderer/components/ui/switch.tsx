import * as React from 'react';

import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@renderer/lib/utils';

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-[var(--color-border-emphasis)] transition-colors',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]',
      'disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:bg-[var(--color-accent)]',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
