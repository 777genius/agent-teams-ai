import { HOSTED_AUTH_HEADERS } from '../contracts';

let csrfToken: string | null = null;

export function setHostedCsrfToken(value: string | null): void {
  csrfToken = value;
}

export function getHostedCsrfToken(): string | null {
  return csrfToken;
}

export function getHostedMutationHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(csrfToken ? { [HOSTED_AUTH_HEADERS.csrf]: csrfToken } : {}),
  };
}
