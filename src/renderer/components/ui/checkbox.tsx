import * as React from 'react';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn } from '@renderer/lib/utils';
import { Check, Minus } from 'lucide-react';

const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer size-4 shrink-0 rounded border border-[var(--color-border-emphasis)] bg-transparent',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-[var(--color-accent)] data-[state=checked]:bg-[var(--color-accent)] data-[state=checked]:text-white',
      'data-[state=indeterminate]:border-[var(--color-accent)] data-[state=indeterminate]:bg-[var(--color-accent)] data-[state=indeterminate]:text-white',
      className
    )}
    checked={checked}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
