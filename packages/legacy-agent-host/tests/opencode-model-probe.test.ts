import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOpenCodeModelProbe } from '../dist/adapters/providers/runOpenCodeModelProbe.js';
import type { OpenCodeProbeClient } from '../src/adapters/providers/runOpenCodeModelProbe.ts';

test('model probe makes one explicit no-tool request and requires exact provider/model/session text completion', async () => {
  let requests = 0,
    creates = 0;
  let wrongModel = false,
    error = false,
    tools = false;
  const client: OpenCodeProbeClient = {
    async getConfig() {
      return { permission: { '*': 'deny' } };
    },
    async getProviders() {
      return { all: [{ id: 'TEST-provider', models: { 'TEST-model': {} } }] };
    },
    async listExperimentalToolIds() {
      return ['bash', 'write', 'TEST-mcp-tool'];
    },
    async createSession() {
      creates++;
      return { id: 'TEST-owned-session' };
    },
    async sendSessionMessage(session, body) {
      requests++;
      assert.deepEqual(body.tools, {
        '*': false,
        bash: false,
        write: false,
        'TEST-mcp-tool': false,
      });
      assert.deepEqual(body.model, { providerID: 'TEST-provider', modelID: 'TEST-model' });
      assert.equal(body.parts.length, 1);
      return {
        info: {
          role: 'assistant',
          sessionID: session,
          providerID: 'TEST-provider',
          modelID: wrongModel ? 'TEST-other' : 'TEST-model',
          time: { completed: 123 },
          ...(error ? { error: { message: 'TEST-private-native-error' } } : {}),
        },
        parts: [{ type: tools ? 'tool' : 'text', text: 'TEST private model reply' }],
      };
    },
  };
  const input = {
    providerId: 'TEST-provider',
    modelId: 'TEST-provider/TEST-model',
    cwd: '/TEST-workspace',
  };
  assert.equal(await runOpenCodeModelProbe(client, input), true);
  assert.equal(requests, 1);
  assert.equal(creates, 1);
  wrongModel = true;
  assert.equal(await runOpenCodeModelProbe(client, input), false);
  wrongModel = false;
  error = true;
  assert.equal(await runOpenCodeModelProbe(client, input), false);
  error = false;
  tools = true;
  assert.equal(await runOpenCodeModelProbe(client, input), false);
  client.getConfig = async () => ({ permission: { '*': 'allow' } });
  const previous = creates;
  await assert.rejects(runOpenCodeModelProbe(client, input));
  assert.equal(creates, previous);
});

test('native limits must match the requested pair before any session allocation', async () => {
  let creates = 0;
  const client = {
    getConfig: async () => ({ permission: { '*': 'deny' } }),
    getProviders: async () => ({
      all: [
        { id: 'TEST-local', models: { 'TEST-model': { limit: { context: 4096, output: 256 } } } },
      ],
    }),
    createSession: async () => {
      creates++;
      return { id: 'TEST-unexpected' };
    },
    listExperimentalToolIds: async () => [],
    sendSessionMessage: async () => {
      throw new Error('TEST-unexpected');
    },
  };
  await assert.rejects(
    runOpenCodeModelProbe(client, {
      providerId: 'TEST-local',
      modelId: 'TEST-model',
      cwd: '/TEST',
      limits: { contextTokens: 4096, outputTokens: 128 },
    })
  );
  assert.equal(creates, 0);
});

test('captured authority is checked after metadata and before handing a model input to native', async () => {
  let current = true,
    creates = 0,
    inputs = 0;
  const client: OpenCodeProbeClient = {
    getConfig: async () => ({ permission: { '*': 'deny' } }),
    getProviders: async () => ({ all: [{ id: 'TEST-provider', models: { 'TEST-model': {} } }] }),
    listExperimentalToolIds: async () => [],
    createSession: async () => {
      creates++;
      current = false;
      return { id: 'TEST-session' };
    },
    sendSessionMessage: async () => {
      inputs++;
      throw new Error('Unexpected input');
    },
  };
  const input = {
    providerId: 'TEST-provider',
    modelId: 'TEST-model',
    cwd: '/TEST',
    isCurrent: () => current,
  };
  await assert.rejects(runOpenCodeModelProbe(client, input), /authority changed/u);
  assert.equal(creates, 1);
  assert.equal(inputs, 0);
  await assert.rejects(runOpenCodeModelProbe(client, input), /authority changed/u);
  assert.equal(creates, 1);
  assert.equal(inputs, 0);
});

test('selected native OpenCode variant is checked before allocation and sent with the one no-tool model request', async () => {
  let creates = 0,
    selected: string | undefined;
  const client: OpenCodeProbeClient = {
    getConfig: async () => ({ permission: { '*': 'deny' } }),
    getProviders: async () => ({
      all: [{ id: 'TEST-provider', models: { 'TEST-model': { variants: { high: {} } } } }],
    }),
    listExperimentalToolIds: async () => [],
    createSession: async () => {
      creates++;
      return { id: 'TEST-owned' };
    },
    sendSessionMessage: async (id, input) => {
      selected = input.variant;
      return {
        info: {
          sessionID: id,
          role: 'assistant',
          providerID: 'TEST-provider',
          modelID: 'TEST-model',
          time: { completed: 1 },
        },
        parts: [{ type: 'text', text: 'OK' }],
      };
    },
  };
  const input = {
    providerId: 'TEST-provider',
    modelId: 'TEST-model',
    cwd: '/TEST',
    variant: 'high',
  };
  assert.equal(await runOpenCodeModelProbe(client, input), true);
  assert.equal(creates, 1);
  assert.equal(selected, 'high');
  await assert.rejects(() => runOpenCodeModelProbe(client, { ...input, variant: 'unsupported' }));
  assert.equal(creates, 1);
});
