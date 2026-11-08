/** Verify the authenticated physical listener before publishing its authority. */
export async function checkApiReadiness(baseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/auth/ready`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Authenticated API readiness failed');
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('ready' in body) ||
    body.ready !== true ||
    !('service' in body) ||
    body.service !== 'api'
  )
    throw new Error('Authenticated API readiness failed');
}
