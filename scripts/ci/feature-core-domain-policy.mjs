// Runtime packages are denied by default. This small set documents deliberate,
// side-effect-free domain utilities instead of trying to enumerate every current
// or future database, transport, framework, and provider SDK.
const DOMAIN_SAFE_VALUE_PACKAGES = new Set(['yaml', 'zod']);

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

export function isForbiddenCoreDomainPackage(edge) {
  if (isProjectSpecifier(edge.specifier)) return false;
  if (edge.isTypeOnly) return false;
  return !DOMAIN_SAFE_VALUE_PACKAGES.has(packageName(edge.specifier));
}
