// REAL vendor proof for native next-message prompt suggestions. Run through
// `pnpm test:real:suggestions` (scripts/e2e/native-prompt-suggestions-real/README.md).
//
// Outcomes are deliberately three-valued and written to the receipt:
//   pass          - the original captured Host delivered bound, provable suggestions;
//   fail          - the Host/contract misbehaved (never hidden behind vendor noise);
//   inconclusive  - the account, quota, binary or the vendor model produced nothing to judge.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { startHost, tick } from './fixtures/native-host.ts';
import {
  Inconclusive,
  assertFreeDisk,
  classifyVendorFailure,
  discoverTarget,
} from './fixtures/real-vendor/discovery.ts';
import { buildRealHostProfile, digest } from './fixtures/real-vendor/host-profile.ts';

import type { RealMember } from './fixtures/real-vendor/host-profile.ts';
import type { RealVendor } from './fixtures/real-vendor/discovery.ts';

const vendor = process.env.REAL_VENDOR as RealVendor | undefined;
const ps = promisify(execFile);
type Rec = Record<string, unknown>;
const record = (value: unknown): Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
const rows = (value: unknown) => (Array.isArray(value) ? value : []).map(record);

/** Exact public notice shape of CapturedPromptSuggestionNotice; any extra field is a leak. */
const NOTICE_KEYS = [
  'completedTurnRef',
  'generation',
  'inputId',
  'memberId',
  'memberName',
  'messageId',
  'operationRef',
  'provider',
  'runId',
  'suggestionId',
  'teamId',
  'text',
];
const MAX_ROUNDS = Number(process.env.REAL_MAX_ROUNDS ?? 6);
const TURN_TIMEOUT_MS = 150_000;
// The first turn of a Claude session never gets a suggestion; keep that wait short.
const WARM_WINDOW_MS = 8_000;
const OFFER_WINDOW_MS = 45_000;
const PROMPTS = [
  (n: string) => `Hi ${n}, what is the capital of France?`,
  () => 'Thanks. Name two famous landmarks in that city.',
  () => 'Great. Which of those two is older? One sentence.',
  () => 'Thanks. What language do they speak there? One sentence.',
  () => 'And which river runs through it? One sentence.',
  () => 'Last one: what currency do they use? One sentence.',
];
const MEMBERS: Record<RealVendor, RealMember[]> = {
  claude: [{ name: 'alice', memberId: 'alice-id', role: 'member' }],
  codex: [
    { name: 'lead', memberId: 'lead-id', role: 'lead' },
    { name: 'peer', memberId: 'peer-id', role: 'member' },
  ],
};

const vendorProcesses = async (binary: string): Promise<Set<string>> => {
  try {
    const { stdout } = await ps('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 });
    return new Set(
      stdout
        .split('\n')
        .filter((line) => line.includes(binary))
        .map((line) => line.trim().split(/\s+/u)[0]!)
    );
  } catch {
    return new Set();
  }
};

test(
  `REAL ${vendor ?? '(set REAL_VENDOR=claude|codex)'}: captured Host delivers bound native prompt suggestions`,
  { timeout: 900_000 },
  async (t) => {
    assert.equal(
      process.env.REAL_VENDOR_GO,
      '1',
      'explicit gate: run through pnpm test:real:suggestions'
    );
    assert.ok(vendor === 'claude' || vendor === 'codex', 'REAL_VENDOR must be claude or codex');
    const receiptPath = process.env.REAL_RECEIPT;
    assert.ok(receiptPath, 'REAL_RECEIPT is required');
    const startedAt = Date.now();
    const receipt: Rec = { vendor, status: 'fail', startedAt: new Date(startedAt).toISOString() };
    const warnings: string[] = [];
    const diag: string[] = [];
    const notices: Rec[] = [];
    let root: string | undefined;
    let host: ReturnType<typeof startHost> | undefined;
    let authBefore: string | undefined;
    let authSource: string | undefined;
    let before = new Set<string>();
    let binary = '';
    const members = MEMBERS[vendor];
    try {
      await assertFreeDisk();
      const target = await discoverTarget(vendor);
      binary = target.binary;
      authSource = target.authSource;
      Object.assign(receipt, {
        binary: target.binary,
        sha256: target.sha256,
        version: target.version,
        model: target.model,
      });
      if (authSource) authBefore = digest(await readFile(authSource, 'utf8'));
      before = await vendorProcesses(binary);
      // The runner owns REAL_WORK_DIR and removes it even if this process is killed (credential copies live here).
      root = await realpath(
        await mkdtemp(join(process.env.REAL_WORK_DIR ?? tmpdir(), `TEST-real-${vendor}-`))
      );
      for (const directory of ['store', 'tmp', 'home', 'workspace'])
        await mkdir(join(root, directory), { mode: 0o700 });
      const built = await buildRealHostProfile(target, root, members);
      const { envelope } = built;
      host = startHost({
        node: built.node,
        entry: built.entry,
        root,
        profile: built.profilePath,
        profileHash: built.profileHash,
        onDiagnostic: (chunk: Buffer) => diag.push(chunk.toString('utf8').slice(0, 500)),
        onNotification: (method, value) => {
          if (method === 'runtime.prompt-suggestion.updated') notices.push(record(value));
        },
      });
      const handshake = await host.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
      const read = async (memberId: string, extra: Rec = {}) => {
        const reply = await host!.rpc('runtime.read', envelope({ memberId, ...extra }));
        assert.equal(reply.ok, true, `runtime.read: ${JSON.stringify(reply).slice(0, 400)}`);
        return record(reply.value);
      };

      // Opening a native session sometimes reports `open-unknown` on a cold vendor process. Retry once, and
      // surface every attempt in the receipt so the flake rate stays measurable instead of silently absorbed.
      const openAttempts: Rec[] = [];
      for (const member of members) {
        let ready = false;
        for (let attempt = 1; attempt <= 2 && !ready; attempt += 1) {
          const opened = await host.rpc('runtime.open', envelope({ memberId: member.memberId }));
          const state = record(opened.value);
          ready = opened.ok === true && state.nativeReady === true;
          openAttempts.push({
            member: member.name,
            attempt,
            ok: opened.ok,
            ready,
            diagnostic: state.diagnostic,
            phase: state.phase,
          });
          if (!ready && attempt === 1) {
            warnings.push(
              `runtime.open(${member.name}) not ready on first attempt: ${JSON.stringify(state.diagnostic ?? opened.error ?? state).slice(0, 160)}`
            );
            await new Promise((done) => setTimeout(done, 2_000));
          }
        }
        if (!ready) {
          const failure = classifyVendorFailure(diag.join('\n') + JSON.stringify(openAttempts));
          if (failure) throw failure;
          assert.fail(
            `native ${vendor} session ${member.name} never became ready: ${JSON.stringify(openAttempts.at(-1))}`
          );
        }
      }
      receipt.openAttempts = openAttempts;

      const offered = new Map<
        string,
        { messageId: string; inputId: string; operationRef: string }
      >();
      const turns: Rec[] = [];
      const sentMessageIds = new Set<string>();
      const seen = new Set<string>();
      for (
        let round = 0;
        round < Math.min(MAX_ROUNDS, PROMPTS.length) && offered.size < members.length;
        round += 1
      ) {
        for (const member of members.filter((candidate) => !offered.has(candidate.name))) {
          const messageId = `TEST-message-${built.namespace}-${member.name}-${round}`;
          const started = Date.now();
          const sent = await host.rpc(
            'team.execute',
            envelope(
              {
                operation: 'message.send',
                payload: {
                  to: member.name,
                  text: PROMPTS[round]!(member.name),
                  messageId,
                  summary: `TEST real ${round}`,
                  actionMode: 'do',
                },
              },
              messageId
            )
          );
          assert.equal(sent.ok, true, `message.send: ${JSON.stringify(sent).slice(0, 500)}`);
          sentMessageIds.add(messageId);
          const inputId = record(record(sent.value).effects).deliveryId as string;
          assert.ok(inputId, 'message.send returned a delivery id');
          let terminal = '';
          for (const until = Date.now() + TURN_TIMEOUT_MS; Date.now() < until; await tick()) {
            const row = rows((await read(member.memberId)).inputs).find(
              (candidate) => candidate.inputId === inputId
            );
            if (row?.phase === 'terminal') {
              terminal = String(row.terminal);
              break;
            }
          }
          const warm = !seen.has(member.name);
          seen.add(member.name);
          for (
            const until = Date.now() + (warm ? WARM_WINDOW_MS : OFFER_WINDOW_MS);
            Date.now() < until && !notices.some((notice) => notice.messageId === messageId);
            await tick()
          );
          const offer = notices.find((notice) => notice.messageId === messageId);
          turns.push({
            round,
            member: member.name,
            terminal,
            ms: Date.now() - started,
            offered: Boolean(offer),
            text: offer?.text,
          });
          if (terminal !== 'succeeded') {
            const failure = classifyVendorFailure(diag.join('\n'));
            if (failure) throw failure;
            assert.fail(
              `${member.name} round ${round} ended ${JSON.stringify(terminal)} (host diag: ${diag.slice(-3).join(' | ').slice(0, 400)})`
            );
          }
          if (!offer) continue;
          // Contract: the notice is bound to the exact human DM and carries only the public fields.
          assert.deepEqual(
            Object.keys(offer).sort(),
            NOTICE_KEYS,
            'notice exposes exactly the public fields'
          );
          assert.equal(offer.provider, vendor);
          assert.equal(offer.memberName, member.name);
          assert.equal(offer.memberId, member.memberId);
          assert.equal(offer.inputId, inputId, 'suggestion is bound to the delivered human input');
          assert.equal(typeof offer.text === 'string' && offer.text.trim().length > 0, true);
          if (vendor === 'codex')
            assert.notEqual(
              offer.completedTurnRef,
              offer.operationRef,
              'Codex binds a native turn, not the Host operation'
            );
          offered.set(member.name, {
            messageId,
            inputId,
            operationRef: String(offer.operationRef),
          });
        }
      }

      // Proofs: the original owner may confirm its own offer; a forged ref or another member may not.
      const proofs: Rec = {};
      for (const member of members.filter((candidate) => offered.has(candidate.name))) {
        const own = offered.get(member.name)!;
        const proof = { inputId: own.inputId, operationRef: own.operationRef };
        const current = await read(member.memberId, {
          expectedGeneration: '1',
          nativePromptProof: proof,
        });
        const forged = await read(member.memberId, {
          nativePromptProof: { ...proof, operationRef: 'TEST-foreign' },
        });
        const other = members.find((candidate) => candidate.memberId !== member.memberId);
        const cross = other ? await read(other.memberId, { nativePromptProof: proof }) : undefined;
        proofs[member.name] = {
          current: current.nativePromptCurrent,
          forgedRejected: forged.nativePromptCurrent === false,
          crossMemberRejected: cross ? cross.nativePromptCurrent === false : null,
        };
        assert.equal(current.nativePromptCurrent, true, `${member.name}: own proof is current`);
        assert.equal(forged.nativePromptCurrent, false, `${member.name}: forged proof is rejected`);
        if (cross)
          assert.equal(
            cross.nativePromptCurrent,
            false,
            `${member.name}: another member's proof is rejected`
          );
      }
      const strangers = notices.filter((notice) => !sentMessageIds.has(String(notice.messageId)));
      assert.equal(strangers.length, 0, 'no suggestion for a message this run did not send');
      Object.assign(receipt, { turns, proofs, notices: notices.length });

      for (const member of members) {
        const stopped = await host.rpc(
          'runtime.stop',
          envelope({ memberId: member.memberId, expectedGeneration: '1' })
        );
        assert.equal(
          stopped.ok,
          true,
          `runtime.stop ${member.name}: ${JSON.stringify(stopped).slice(0, 300)}`
        );
      }
      const silent = members
        .filter((member) => !offered.has(member.name))
        .map((member) => member.name);
      if (silent.length > 0)
        throw new Inconclusive(
          'vendor-silent',
          `${vendor} produced no suggestion for ${silent.join(', ')} within ${MAX_ROUNDS} turns; the Host raised no contract violation, but the feature is not proven (vendor suggestions are probabilistic, rerun)`
        );
      receipt.status = 'pass';
    } catch (error) {
      if (error instanceof Inconclusive)
        Object.assign(receipt, {
          status: 'inconclusive',
          reasonCode: error.code,
          reason: error.message,
        });
      else
        Object.assign(receipt, {
          status: 'fail',
          reason: error instanceof Error ? error.message : String(error),
        });
    } finally {
      let closeError: unknown;
      try {
        await host?.close();
      } catch (error) {
        closeError = error;
      }
      if (closeError) {
        receipt.closeError = String(closeError);
        if (receipt.status === 'pass') receipt.status = 'fail';
      }
      // A leftover vendor process, or a rotated credential copy, is a defect even when every turn passed.
      const leaked = [...(await vendorProcesses(binary))].filter((pid) => !before.has(pid));
      if (binary && leaked.length > 0) {
        await new Promise((done) => setTimeout(done, 3_000));
        const stillThere = [...(await vendorProcesses(binary))].filter((pid) => !before.has(pid));
        if (stillThere.length > 0) {
          receipt.leakedProcesses = stillThere;
          if (receipt.status === 'pass') receipt.status = 'fail';
          receipt.reason ??= `vendor processes outlived the Host: ${stillThere.join(',')}`;
        }
      }
      if (authSource && authBefore && root) {
        const copies: string[] = [];
        for (const member of members) {
          try {
            copies.push(
              digest(await readFile(join(root, member.name, 'codex-home/auth.json'), 'utf8')) ===
                authBefore
                ? 'unchanged'
                : 'CHANGED'
            );
          } catch {
            copies.push('missing');
          }
        }
        receipt.authCopies = copies;
        receipt.originalAuthUnchanged = digest(await readFile(authSource, 'utf8')) === authBefore;
        if (copies.includes('CHANGED'))
          warnings.push(
            'the vendor refreshed a copied credential; the original file may need `codex login`'
          );
        if (receipt.originalAuthUnchanged !== true)
          warnings.push('the original credential file changed during the run');
      }
      Object.assign(receipt, {
        warnings,
        hostStderr: diag.filter((line) => /FAIL|rror/u.test(line)).slice(0, 6),
        durationMs: Date.now() - startedAt,
      });
      await mkdir(join(receiptPath, '..'), { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      if (root) await rm(root, { recursive: true, force: true });
    }
    t.diagnostic(JSON.stringify(receipt));
    if (receipt.status === 'inconclusive') t.skip(String(receipt.reason));
    else assert.equal(receipt.status, 'pass', String(receipt.reason ?? 'real vendor proof failed'));
  }
);
