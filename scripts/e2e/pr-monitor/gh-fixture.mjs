// External GitHub CLI fixture. The production transport still executes a process.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync(process.env.PR_MONITOR_E2E_STATE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(
  process.env.PR_MONITOR_E2E_AUDIT,
  JSON.stringify({ args, phase: state.phase }) + '\n'
);
if (args[0] === 'api' && args[5] === '/user') {
  assert.deepEqual(args, [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    '/user',
    '--jq',
    '{login: .login}',
  ]);
  if (state.cliAuthenticated === false) {
    process.stderr.write('TEST authentication required');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ login: 'TEST-user' }));
  process.exit(0);
}
assert.deepEqual(args.slice(0, 6), [
  'api',
  '--hostname',
  'github.com',
  '--method',
  'GET',
  '--include',
]);
const url = new URL(args[6], 'https://api.github.com');
assert(url.pathname.toLowerCase().startsWith('/repos/test/fixture/'), 'Escaped sandbox repository');
const respond = (status, body, headers = {}) => {
  process.stdout.write(
    `HTTP/2.0 ${status} Fixture\r\nContent-Type: application/json\r\n` +
      Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('') +
      '\r\n' +
      JSON.stringify(body)
  );
  process.exitCode = status >= 400 ? 1 : 0;
};
if (state.phase === 'offline') {
  process.stderr.write('TEST provider detail that must never reach the renderer');
  process.exit(1);
}
if (state.phase === 'unauthorized') {
  respond(401, { message: 'TEST_SECRET_PROVIDER_PAYLOAD' });
} else if (state.phase === 'limited') {
  respond(429, { message: 'TEST_SECRET_PROVIDER_PAYLOAD' }, { 'Retry-After': '120' });
} else {
  const head = (state.phase === 'pushed' ? 'c' : 'a').repeat(40);
  const pending = state.phase === 'queued' || state.phase === 'pushed';
  const times = { created_at: '2026-11-28T12:00:00Z', updated_at: '2026-11-28T12:05:00Z' };
  const pull = {
    number: 3,
    title: 'TEST deterministic pull request',
    state: 'open',
    draft: false,
    merged_at: null,
    user: { login: 'TEST-contributor', token: 'TEST_SECRET_PROVIDER_PAYLOAD' },
    head: { sha: head, ref: 'TEST-topic' },
    base: { ref: 'main', repo: { name: 'fixture', owner: { login: 'TEST' } } },
    mergeable: true,
    mergeable_state: 'clean',
    ...times,
  };
  const run = {
    id: 40,
    workflow_id: 8,
    name: 'TEST Build',
    head_sha: head,
    run_attempt: 2,
    status: pending ? 'queued' : 'completed',
    conclusion: pending ? null : 'success',
    run_started_at: pending ? null : '2026-11-28T12:03:00Z',
    ...times,
  };
  const request = url.pathname;
  let body;
  if (request.endsWith('/pulls')) body = [pull];
  else if (request.endsWith('/pulls/3')) body = pull;
  else if (request.endsWith('/check-runs'))
    body = {
      total_count: 1,
      check_runs: [
        {
          id: 4,
          name: 'TEST CI',
          head_sha: head,
          status: pending ? 'queued' : 'completed',
          conclusion: pending ? null : 'success',
          app: { id: 9 },
          started_at: pending ? null : '2026-11-28T12:02:00Z',
          completed_at: pending ? null : '2026-11-28T12:05:00Z',
          html_url: 'https://github.com/TEST/fixture/runs/4',
        },
      ],
    };
  else if (request.endsWith('/statuses')) body = [];
  else if (request.endsWith('/reviews'))
    body = [
      {
        id: 5,
        user: { login: 'TEST-reviewer' },
        state: 'APPROVED',
        commit_id: 'b'.repeat(40),
        submitted_at: '2026-11-28T12:04:00Z',
        html_url: 'https://github.com/TEST/fixture/pull/3#review-5',
      },
    ];
  else if (request.endsWith('/actions/runs')) body = { total_count: 1, workflow_runs: [run] };
  else if (request.endsWith('/attempts/1'))
    body = {
      ...run,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'failure',
      run_started_at: '2026-11-28T12:01:00Z',
    };
  else if (request.endsWith('/jobs')) {
    const attempt = request.includes('/attempts/1/') ? 1 : 2;
    body = {
      total_count: 1,
      jobs: [
        {
          id: 200 + attempt,
          name: 'TEST matrix (linux, node24)',
          status: attempt === 2 && pending ? 'queued' : 'completed',
          conclusion: attempt === 1 ? 'failure' : pending ? null : 'success',
          created_at: '2026-11-28T12:03:00Z',
          started_at: pending ? null : '2026-11-28T12:03:20Z',
          completed_at: pending ? null : '2026-11-28T12:05:00Z',
          html_url: `https://github.com/TEST/fixture/actions/runs/40/job/${200 + attempt}`,
        },
      ],
    };
  } else throw new Error('Unexpected fixture endpoint: ' + request);
  respond(200, body);
}
