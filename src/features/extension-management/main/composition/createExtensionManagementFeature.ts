import { randomUUID } from 'node:crypto';

import { ManagementError } from '@uap/management-sdk';

import { createExtensionManagementApplication } from '../../core/application/createExtensionManagementApplication';
import { ExtensionRuntimeGate } from '../../core/application/ExtensionRuntimeGate';
import {
  applySchema,
  catalogSchema,
  contextSchema,
  detailSchema,
  discardPlanSchema,
  discoverSchema,
  operationSchema,
  prepareSchema,
  previewSkillSchema,
  selectionSchema,
} from '../adapters/input/validation';

import type {
  ExtensionContextResolver,
  ExtensionManagementFeature,
} from '../../core/application/ports';

/** Validate both input transports before invoking the shared application use cases. */
export function createExtensionManagementFeature(
  resolver: ExtensionContextResolver,
  gate = new ExtensionRuntimeGate()
): ExtensionManagementFeature {
  const feature = createExtensionManagementApplication(
    resolver,
    gate,
    randomUUID,
    (error) =>
      error instanceof ManagementError && ['PLAN_STALE', 'HISTORY_FULL'].includes(error.code)
  );
  return {
    capture: async (raw) => feature.capture(selectionSchema.parse(raw)),
    catalog: async (raw) => feature.catalog(catalogSchema.parse(raw)),
    detail: async (raw) => feature.detail(detailSchema.parse(raw)),
    discoverSkills: async (raw) => feature.discoverSkills(discoverSchema.parse(raw)),
    previewSkill: async (raw) => feature.previewSkill(previewSkillSchema.parse(raw)),
    environment: async (raw) => feature.environment(contextSchema.parse(raw)),
    prepare: async (raw) => feature.prepare(prepareSchema.parse(raw)),
    discardPlan: async (raw) => feature.discardPlan(discardPlanSchema.parse(raw)),
    apply: async (raw) => feature.apply(applySchema.parse(raw)),
    operation: async (raw) => feature.operation(operationSchema.parse(raw)),
    cancel: async (raw) => feature.cancel(operationSchema.parse(raw)),
    close: () => feature.close(),
  };
}
