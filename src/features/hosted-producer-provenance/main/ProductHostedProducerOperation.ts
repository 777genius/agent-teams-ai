import {
  type HostedProducerProvenance,
  type ProductHostedProducerInstance,
  type ProductHostedProducerOperation,
} from './HostedProducerProvenanceContracts';

import type { QueryContext } from '@shared/contracts/hosted';

const NONCE = /^[0-9a-f]{64}$/u;

const operations = new WeakMap<QueryContext, ProductHostedProducerOperation>();
const instances = new WeakMap<HostedProducerProvenance, ProductHostedProducerInstance>();

export function bindProductHostedProducerInstance(
  provenance: HostedProducerProvenance,
  instance: ProductHostedProducerInstance
): ProductHostedProducerInstance {
  if (
    instances.has(provenance) ||
    !instance.deploymentId ||
    !instance.bootId ||
    !instance.ownerAuthority ||
    !Number.isSafeInteger(instance.ownerGeneration) ||
    instance.ownerGeneration < 1 ||
    !instance.ownerSessionId
  ) {
    throw new TypeError('producer-provenance-instance-binding');
  }
  const binding = Object.freeze({ ...instance });
  instances.set(provenance, binding);
  return binding;
}

export function requireProductHostedProducerInstance(
  provenance: HostedProducerProvenance
): ProductHostedProducerInstance {
  const instance = instances.get(provenance);
  if (instance === undefined) throw new TypeError('producer-provenance-instance-binding-missing');
  return instance;
}

export function bindProductHostedProducerOperation(
  context: QueryContext,
  provenance: HostedProducerProvenance,
  operationNonce: string
): ProductHostedProducerOperation {
  if (!NONCE.test(operationNonce) || operations.has(context)) {
    throw new TypeError('producer-provenance-operation-binding');
  }
  const instance = requireProductHostedProducerInstance(provenance);
  if (instance.deploymentId !== context.deploymentId || instance.bootId !== context.bootId) {
    throw new TypeError('producer-provenance-operation-instance-drift');
  }
  const operation = Object.freeze({
    operationNonce,
    actorId: context.actorId,
    sessionId: context.sessionId,
    deploymentId: context.deploymentId,
    bootId: context.bootId,
    requestId: context.requestId,
    ownerAuthority: instance.ownerAuthority,
    ownerGeneration: instance.ownerGeneration,
    ownerSessionId: instance.ownerSessionId,
  });
  operations.set(context, operation);
  return operation;
}

export function requireProductHostedProducerOperation(
  context: QueryContext,
  provenance: HostedProducerProvenance
): ProductHostedProducerOperation {
  const operation = operations.get(context);
  if (operation === undefined) {
    throw new TypeError('producer-provenance-operation-binding-missing');
  }
  const instance = requireProductHostedProducerInstance(provenance);
  if (
    operation.actorId !== context.actorId ||
    operation.sessionId !== context.sessionId ||
    operation.deploymentId !== context.deploymentId ||
    operation.bootId !== context.bootId ||
    operation.requestId !== context.requestId ||
    operation.deploymentId !== instance.deploymentId ||
    operation.bootId !== instance.bootId ||
    operation.ownerAuthority !== instance.ownerAuthority ||
    operation.ownerGeneration !== instance.ownerGeneration ||
    operation.ownerSessionId !== instance.ownerSessionId
  ) {
    throw new TypeError('producer-provenance-operation-binding-drift');
  }
  return operation;
}
