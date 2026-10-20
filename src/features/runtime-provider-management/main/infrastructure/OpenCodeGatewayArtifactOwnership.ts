import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { findNodeAtLocation, getNodeValue, type Node as JsoncNode } from 'jsonc-parser';

import { hasDuplicateObjectProperties } from './openCodeLocalProviderConnectorUtils';
import { LocalProviderOperationError, readStringNode } from './OpenCodeLocalProviderSupport';

import type { RuntimeLocalProviderConfigureInput } from '../../contracts';
import type { LocalProviderConfigWriteInput } from './openCodeLocalProviderConnectorUtils';

export interface OpenCodeGatewayProviderTarget {
  readonly teamName: string;
  readonly memberName: string;
  readonly gatewayUsageRef: string;
}

export interface OpenCodeGatewayProviderRetireTarget extends OpenCodeGatewayProviderTarget {
  readonly providerId: string;
}

export interface OpenCodeGatewayProviderOwnership extends OpenCodeGatewayProviderRetireTarget {
  readonly schemaVersion: 1;
  readonly owner: 'agent-teams-gateway';
  readonly configPath: string;
  readonly credentialReference: string;
  readonly providerDigest: string;
  readonly previousProviderDigest?: string;
  readonly inputDigest: string;
}

export function assertGatewayProviderInput(
  input: RuntimeLocalProviderConfigureInput,
  target: OpenCodeGatewayProviderTarget
): void {
  assertGatewayProviderTarget({ ...target, providerId: input.providerId ?? '' });
  if (
    input.runtimeId !== 'opencode' ||
    input.scope !== 'global' ||
    input.presetId !== 'custom' ||
    input.setAsDefault !== false ||
    input.setAsSmallModel !== false ||
    !input.apiKey?.trim()
  ) {
    throw ownershipConflict();
  }
}

export function assertGatewayProviderTarget(target: OpenCodeGatewayProviderRetireTarget): void {
  if (
    [target.teamName, target.memberName, target.gatewayUsageRef].some(
      (value) => typeof value !== 'string' || !value.trim() || value.length > 1024
    )
  )
    throw ownershipConflict();
  const suffix = createHash('sha256')
    .update(JSON.stringify([target.teamName, target.memberName, target.gatewayUsageRef]))
    .digest('hex')
    .slice(0, 12);
  if (
    !/^gateway-[a-z0-9_-]+-[a-f0-9]{12}$/.test(target.providerId) ||
    target.providerId.length > 64 ||
    !target.providerId.endsWith(`-${suffix}`)
  ) {
    throw ownershipConflict();
  }
}

export function gatewayProviderInputDigest(input: LocalProviderConfigWriteInput): string {
  return digest([input.baseUrl, input.apiKey]);
}

export function gatewayProviderDigest(tree: JsoncNode, providerId: string): string {
  return digest(getNodeValue(findNodeAtLocation(tree, ['provider', providerId])!));
}

export function gatewayOwnershipMatches(
  ownership: OpenCodeGatewayProviderOwnership,
  target: OpenCodeGatewayProviderRetireTarget,
  configPath: string
): boolean {
  return (
    ownership.schemaVersion === 1 &&
    ownership.owner === 'agent-teams-gateway' &&
    ownership.teamName === target.teamName &&
    ownership.memberName === target.memberName &&
    ownership.gatewayUsageRef === target.gatewayUsageRef &&
    ownership.providerId === target.providerId &&
    ownership.configPath === configPath &&
    typeof ownership.credentialReference === 'string' &&
    typeof ownership.providerDigest === 'string' &&
    typeof ownership.inputDigest === 'string'
  );
}

export function gatewayProviderUnchanged(
  tree: JsoncNode,
  ownership: OpenCodeGatewayProviderOwnership
): boolean {
  return (
    !hasDuplicateObjectProperties(tree) &&
    [ownership.providerDigest, ownership.previousProviderDigest].includes(
      gatewayProviderDigest(tree, ownership.providerId)
    ) &&
    readStringNode(
      findNodeAtLocation(tree, ['provider', ownership.providerId, 'options', 'apiKey'])
    ) === ownership.credentialReference
  );
}

/** Ownership lives beside credentials; OpenCode's schema never receives app-only properties. */
export async function gatewayOwnershipLocation(
  homePath: string,
  configPath: string,
  providerId: string
): Promise<{ directory: string; markerPath: string }> {
  const home = await fs.realpath(homePath);
  let directory = home;
  for (const segment of ['.config', 'opencode', 'agent-teams-credentials']) {
    directory = path.join(directory, segment);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw ownershipConflict();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Reading/retiring absent artifacts must not create directories.
      break;
    }
  }
  directory = path.join(home, '.config', 'opencode', 'agent-teams-credentials');
  const scope = createHash('sha256').update(path.resolve(configPath)).digest('hex').slice(0, 16);
  return { directory, markerPath: path.join(directory, `${providerId}-${scope}.owner.json`) };
}

export async function readGatewayOwnership(
  markerPath: string
): Promise<OpenCodeGatewayProviderOwnership | null> {
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw ownershipConflict();
    const ownership: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership))
      throw ownershipConflict();
    return ownership as OpenCodeGatewayProviderOwnership;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeGatewayOwnership(
  markerPath: string,
  ownership: OpenCodeGatewayProviderOwnership
): Promise<void> {
  return atomicWriteAsync(markerPath, `${JSON.stringify(ownership)}\n`, { mode: 0o600 });
}

export function containsProviderReference(tree: JsoncNode, providerId: string): boolean {
  const value = readStringNode(tree);
  if (value === providerId || value?.startsWith(`${providerId}/`)) return true;
  return tree.children?.some((child) => containsProviderReference(child, providerId)) ?? false;
}

export function ownershipConflict(): LocalProviderOperationError {
  return new LocalProviderOperationError(
    'config-conflict',
    'The gateway provider artifact ownership or configuration changed.'
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
