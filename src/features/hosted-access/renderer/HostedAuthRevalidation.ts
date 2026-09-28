import { createContext, useContext } from 'react';

import type { HostedAuthStatus } from '../contracts';

export type HostedAuthRevalidationResult =
  | {
      readonly kind: 'authenticated';
      readonly identity: 'same' | 'changed';
      readonly auth: HostedAuthStatus;
    }
  | { readonly kind: 'unauthenticated'; readonly auth: HostedAuthStatus }
  | { readonly kind: 'unavailable'; readonly error: string };

export type HostedAuthAvailability = 'available' | 'checking' | 'unavailable';

export interface HostedAuthRevalidation {
  readonly availability: HostedAuthAvailability;
  readonly revalidate: () => Promise<HostedAuthRevalidationResult>;
}

export const HostedAuthRevalidationContext = createContext<HostedAuthRevalidation | null>(null);

/** Available only to an authenticated child of HostedAuthGate. */
export function useHostedAuthRevalidation(): HostedAuthRevalidation {
  const context = useContext(HostedAuthRevalidationContext);
  if (context === null) throw new Error('HostedAuthGate is required for auth revalidation.');
  return context;
}
