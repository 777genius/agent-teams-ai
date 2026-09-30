// External packages are denied for both value and type imports by default.
// This small set documents deliberate, side-effect-free domain dependencies
// instead of trying to enumerate every runtime, framework, and provider SDK.
const DOMAIN_SAFE_PACKAGES = new Set(['@claude-teams/agent-graph', 'yaml', 'zod']);

function packageName(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

export function isProjectSpecifier(specifier) {
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
  return !DOMAIN_SAFE_PACKAGES.has(packageName(edge.specifier));
}
