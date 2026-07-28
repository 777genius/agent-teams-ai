import { builtinModules } from 'node:module';

// Runtime packages are denied by default. This small set documents deliberate,
// side-effect-free domain utilities instead of trying to enumerate every current
// or future database, transport, framework, and provider SDK.
const DOMAIN_SAFE_VALUE_PACKAGES = new Set(['yaml', 'zod']);
const NODE_RUNTIME_PACKAGES = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name : `node:${name}`])
);

function packageName(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function isProjectSpecifier(specifier) {
  return (
    specifier.startsWith('.') ||
    specifier === '@features' ||
    specifier.startsWith('@features/') ||
    specifier === '@main' ||
    specifier.startsWith('@main/') ||
    specifier === '@preload' ||
    specifier.startsWith('@preload/') ||
    specifier === '@renderer' ||
    specifier.startsWith('@renderer/') ||
    specifier === '@shared' ||
    specifier.startsWith('@shared/')
  );
}

function isRuntimeCoupledPackage(name) {
  return (
    NODE_RUNTIME_PACKAGES.has(name) ||
    name === 'electron' ||
    name === 'fastify' ||
    name.startsWith('@fastify/')
  );
}

export function isForbiddenCoreDomainPackage(edge) {
  if (isProjectSpecifier(edge.specifier)) return false;
  const name = packageName(edge.specifier);
  if (isRuntimeCoupledPackage(name)) return true;
  if (edge.isTypeOnly) return false;
  return !DOMAIN_SAFE_VALUE_PACKAGES.has(name);
}
