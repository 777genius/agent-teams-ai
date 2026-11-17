import { pathToFileURL } from 'node:url';

import type { VerifiedOpenCodeV2EmbeddedGraph } from './OpenCodeV2EmbeddedGraph.js';

type Value = Record<string, unknown>;
const record = (value: unknown): value is Value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const held = (): never => {
  throw new Error('OpenCode V2 configured package unavailable');
};
interface NativeRewrite {
  rewrite(
    target: Value,
    input: { specifier: string; providerID: string; canonical?: string; modelID?: string }
  ): void;
}
interface NativePackages {
  builtinPackages: ReadonlySet<string>;
}

/** Exact native rewriting decides builtins. Remaining SDKs use only manifest-contained files, never npm.add. */
export async function bindOpenCodeV2ConfiguredPackages(
  raw: Readonly<Value>,
  graph: VerifiedOpenCodeV2EmbeddedGraph
): Promise<Value> {
  const config = structuredClone(raw);
  if (config.providers === undefined) return config;
  if (!record(config.providers) || Object.keys(config.providers).length > 256) return held();
  const modules = graph.configurationModules;
  if (!modules) return held();
  const native = (await import(pathToFileURL(modules.nativeRewritePath).href)) as NativeRewrite;
  const packages = (await import(pathToFileURL(modules.providerPath).href)) as NativePackages;
  if (typeof native.rewrite !== 'function' || !(packages.builtinPackages instanceof Set))
    return held();
  async function bind(value: Value, providerID: string, inherited?: string, modelID?: string) {
    const original = value.package ?? inherited;
    if (original === undefined) return;
    if (typeof original !== 'string' || original.length > 1024) return held();
    const rewritten = structuredClone(value);
    native.rewrite(rewritten, {
      specifier: original,
      providerID,
      ...(typeof value.canonical === 'string' ? { canonical: value.canonical } : {}),
      ...(modelID === undefined ? {} : { modelID }),
    });
    const selected = rewritten.package ?? original;
    if (typeof selected !== 'string') return held();
    if (packages.builtinPackages.has(selected)) {
      // Leave the original declaration intact: the engine performs its complete native translation.
      await modules!.resolvePackage(selected);
      return;
    }
    const sdk = selected.startsWith('aisdk:'),
      specifier = sdk ? selected.slice(6) : selected;
    const entry = await modules!.resolvePackage(specifier);
    value.package = (sdk ? 'aisdk:' : '') + pathToFileURL(entry).href;
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!record(provider)) return held();
    const inherited = typeof provider.package === 'string' ? provider.package : undefined;
    await bind(provider, providerId);
    if (provider.models === undefined) continue;
    if (!record(provider.models) || Object.keys(provider.models).length > 2048) return held();
    for (const [id, model] of Object.entries(provider.models)) {
      if (!record(model)) return held();
      await bind(
        model,
        providerId,
        inherited,
        typeof model.modelID === 'string' ? model.modelID : id
      );
    }
  }
  return config;
}
