// External issuer boundary for the real Electron Device Flow and fetch adapter.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function githubFixtureFetch(url, init, files) {
  const target = new URL(String(url));
  const state = JSON.parse(await readFile(files.statePath, 'utf8'));
  const method = init?.method ?? 'GET';
  await appendFile(
    files.auditPath,
    JSON.stringify({ provider: 'oauth', path: target.pathname, method }) + '\n'
  );
  const json = (body) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  if (target.hostname === 'github.com') {
    assert.equal(method, 'POST');
    const parameters = new URLSearchParams(init.body);
    assert.equal(parameters.get('client_id'), 'TEST_PUBLIC_CLIENT_ID');
    assert(!parameters.has('client_secret'), 'Backendless login used a client secret');
    if (target.pathname === '/login/device/code')
      return json({
        device_code: 'TEST_PRIVATE_DEVICE_CODE',
        user_code: 'TEST-CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    assert.equal(target.pathname, '/login/oauth/access_token');
    if (!state.oauthApproved) return json({ error: 'authorization_pending' });
    return json({
      access_token: 'TEST_PRIVATE_OAUTH_ACCESS',
      refresh_token: 'TEST_PRIVATE_OAUTH_REFRESH',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token_expires_in: 86400,
    });
  }
  assert.equal(target.hostname, 'api.github.com');
  assert.equal(method, 'GET');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer TEST_PRIVATE_OAUTH_ACCESS');
  if (target.pathname === '/user')
    return json({
      id: 123,
      login: 'TEST-user',
      private_provider_field: 'TEST_SECRET_PROVIDER_PAYLOAD',
    });
  let stdout;
  try {
    ({ stdout } = await run(
      files.gh,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '--include',
        target.pathname + target.search,
      ],
      { env: process.env }
    ));
  } catch (error) {
    if (typeof error.stdout !== 'string' || !error.stdout.startsWith('HTTP/')) throw error;
    stdout = error.stdout;
  }
  const response = stdout.replaceAll('\r\n', '\n');
  const divider = response.indexOf('\n\n');
  const lines = response.slice(0, divider).split('\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    })
  );
  return new Response(response.slice(divider + 2), { status, headers });
}
