import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import {
  APPROVAL_GENERATION_TRANSITION, approvalGenerationTransitionSigningBytes,
  decodeApprovalGenerationTransition, type ApprovalGenerationTransition,
} from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import type { NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';

const prepared = new WeakMap<ChildProcess, Readonly<{ digest: string; generation: number }>>();
const adopted = new WeakMap<ChildProcess, Readonly<{
  selection: NativeActivationHandleSelection; manifestDigest: string;
}>>();

/** No signer is selected here. Product verifies this independently signed ticket
 * against its original launcher pin before acknowledging a completed drain. */
export async function prepareProductGenerationTransition(product: ChildProcess,
  input: ApprovalGenerationTransition, generation: number, signal: AbortSignal): Promise<void> {
  if (prepared.has(product)) throw new Error('product_transition_overlap');
  const ticket = decodeApprovalGenerationTransition(input);
  const digest = createHash('sha256').update(approvalGenerationTransitionSigningBytes(ticket)).digest('hex');
  if (ticket.successorGeneration !== generation) throw new Error('product_transition_generation');
  prepared.set(product, { digest, generation });
  await observe(product, `${APPROVAL_GENERATION_TRANSITION}/drained`, row => {
    if (Object.keys(row).sort().join(',') !== 'contract,ownerGeneration,transitionSha256' ||
      row.transitionSha256 !== digest || row.ownerGeneration !== generation) throw new Error('product_transition_drain_binding');
  }, signal, () => new Promise<void>((resolve, reject) => {
    product.send!(ticket, error => error ? reject(error) : resolve());
  }));
}

/** Installed BEFORE handle submission so fast adoption cannot be missed. */
export function observeProductGenerationAdoption(product: ChildProcess,
  selection: NativeActivationHandleSelection, signal?: AbortSignal, successorManifest?: string): Promise<void> {
  const expected = prepared.get(product);
  if (selection.ownerGeneration > 1 && (!expected || expected.generation !== selection.ownerGeneration)) {
    return Promise.reject(new Error('product_transition_not_prepared'));
  }
  let observedManifestDigest: string | undefined;
  return observe(product, `${APPROVAL_GENERATION_TRANSITION}/ready`, row => {
    if (Object.keys(row).sort().join(',') !== 'contract,manifestDigest,selection,transitionSha256' ||
      JSON.stringify(row.selection) !== JSON.stringify(selection) ||
      row.transitionSha256 !== (expected?.digest ?? null) ||
      (expected && (!successorManifest || row.manifestDigest !== `sha256:${createHash('sha256').update(successorManifest).digest('hex')}`)) ||
      typeof row.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(row.manifestDigest)) {
      throw new Error('product_transition_ready_binding');
    }
    prepared.delete(product);
    observedManifestDigest = row.manifestDigest;
  }, signal).then(() => {
    if (!observedManifestDigest) throw new Error('product_generation_adoption_missing');
    adopted.set(product, Object.freeze({ selection: Object.freeze({ ...selection }), manifestDigest: observedManifestDigest }));
  });
}

/** Retained only from the existing validated ready message. It supplies the
 * predecessor digest to root issuance, whose signer independently compares
 * its own admitted predecessor. It is not a replacement for that admission. */
export function readProductGenerationAdoption(product: ChildProcess, selection: NativeActivationHandleSelection) {
  const receipt = adopted.get(product);
  if (!receipt || prepared.has(product) || !product.connected || product.exitCode !== null ||
    product.signalCode !== null || JSON.stringify(receipt.selection) !== JSON.stringify(selection)) {
    throw new Error('product_generation_adoption_missing');
  }
  return receipt;
}

function observe(product: ChildProcess, contract: string,
  validate: (row: Record<string, unknown>) => void, signal?: AbortSignal,
  submit?: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false, observed = false, submitted = submit === undefined;
    const finish = (error?: Error) => {
      if (settled || (!error && (!observed || !submitted))) return;
      settled = true;
      clearTimeout(timer);
      product.off('message', message); product.off('exit', lost); product.off('disconnect', lost);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const message = (value: unknown, handle: unknown) => {
      if (!value || typeof value !== 'object' || Reflect.get(value, 'contract') !== contract) return;
      try {
        if (handle || observed) throw new Error('product_transition_response_reused');
        validate(value as Record<string, unknown>);
        if (!product.connected || product.exitCode !== null || product.signalCode !== null) throw new Error('product_transition_process_lost');
        observed = true; finish();
      } catch (error) {
        if (handle instanceof Socket) handle.destroy();
        finish(error instanceof Error ? error : new Error('product_transition_response'));
      }
    };
    const lost = () => finish(new Error('product_transition_process_lost'));
    const aborted = () => finish(new Error('product_transition_cancelled'));
    const timer = setTimeout(() => finish(new Error('product_transition_deadline')), 30_000);
    product.on('message', message); product.once('exit', lost); product.once('disconnect', lost);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    if (!product.connected || !product.send || product.exitCode !== null || product.signalCode !== null) { lost(); return; }
    if (submit) void submit().then(() => { submitted = true; finish(); },
      error => finish(error instanceof Error ? error : new Error('product_transition_send')));
  });
}
