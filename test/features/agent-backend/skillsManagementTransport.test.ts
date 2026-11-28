import { expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createHostServer } from '../../../packages/legacy-agent-host/src/index';
import { DEFAULT_HOST_LIMITS, MAX_HOST_FRAME_BYTES, SKILLS_HOST_PAYLOAD_METHODS, hostMethodFrameLimit, hostPayloadLimit, resolveHostProfileLimits } from '../../../packages/legacy-agent-host/src/contracts';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function frame(id: number, method: string, size: number) { const base = JSON.stringify({ jsonrpc: '2.0', id, method, params: '' }); return base + ' '.repeat(size - Buffer.byteLength(base)) + '\n'; }
function fixture(profile?: 'review-v1') {
  const input = new PassThrough(), output = new PassThrough(), rows: { id: number; result?: unknown; error?: { code: number } }[] = []; let tail = '', calls = 0;
  output.on('data', (chunk: Buffer) => { tail += chunk.toString(); let at: number; while ((at = tail.indexOf('\n')) !== -1) { rows.push(JSON.parse(tail.slice(0, at))); tail = tail.slice(at + 1); } });
  const handle = () => { calls++; return null; };
  const server = createHostServer({ input, output, buildId: 'TEST-skills-frame', ...(profile ? { reviewTransport: profile } : {}), methods: { 'management.skills.mutate': { lane: 'work', handle }, 'management.skills.capture': { lane: 'work', handle }, 'management.oauth.start': { lane: 'work', handle } } });
  const handshake = async () => { input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'host.handshake',params:{protocolVersion:1}})+'\n'); await tick(); };
  return { input, rows, server, handshake, calls: () => calls };
}
it('only four finite Skills methods share the already opted-in payload budget and reserve', () => {
  expect(SKILLS_HOST_PAYLOAD_METHODS).toEqual(['management.skills.read','management.skills.preview','management.skills.mutate','management.skills.pending']);
  for (const method of SKILLS_HOST_PAYLOAD_METHODS) { expect(hostPayloadLimit(method)).toBe(32*1024*1024); expect(hostMethodFrameLimit(method)).toBe(DEFAULT_HOST_LIMITS.maxFrameBytes); expect(hostMethodFrameLimit(method,'review-v1')).toBe(MAX_HOST_FRAME_BYTES); }
  for (const method of ['management.skills.capture','management.skills.lookup','management.skills.trash.finish','provider.management.invoke','management.oauth.start','management.skills.any']) expect(hostMethodFrameLimit(method,'review-v1')).toBe(DEFAULT_HOST_LIMITS.maxFrameBytes);
  expect(resolveHostProfileLimits('review-v1').reservedControlRequests).toBe(DEFAULT_HOST_LIMITS.reservedControlRequests);
  expect(resolveHostProfileLimits('review-v1').maxPriorityBytes).toBe(2*(MAX_HOST_FRAME_BYTES+1));
});
it('actual NDJSON accepts exactly the Skills frame budget, then refuses limit plus one before another dispatch', async () => {
  const f = fixture('review-v1'); await f.handshake();
  f.input.write(frame(2,'management.skills.mutate',MAX_HOST_FRAME_BYTES)); await tick();
  expect(f.calls()).toBe(1); expect(f.rows.find(r=>r.id===2)?.result).toBeNull();
  f.input.write(frame(3,'management.skills.mutate',MAX_HOST_FRAME_BYTES+1));
  expect((await f.server.closed).reason).toBe('frame_too_large'); expect(f.calls()).toBe(1);
});
it('nonSkills methods stay one-MiB under opt-in, and default Skills cannot use the large frame', async () => {
  const f = fixture('review-v1'); await f.handshake();
  for (const [id,method] of [[2,'management.skills.capture'],[3,'management.oauth.start']] as const) { f.input.write(frame(id,method,DEFAULT_HOST_LIMITS.maxFrameBytes+1)); await tick(); expect(f.rows.find(r=>r.id===id)?.error?.code).toBe(-32602); }
  expect(f.calls()).toBe(0); await f.server.dispose();
  const ordinary = fixture(); await ordinary.handshake(); ordinary.input.write(frame(2,'management.skills.mutate',DEFAULT_HOST_LIMITS.maxFrameBytes+1));
  expect((await ordinary.server.closed).reason).toBe('frame_too_large'); expect(ordinary.calls()).toBe(0);
});
