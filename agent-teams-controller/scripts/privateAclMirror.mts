/** One policy, two package formats: preserve the controller's independently distributed CJS seam. */
export function renderControllerAcl(source: string): string {
  const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((match) => match[1]);
  const output = source
    .replace(
      /^import \{ (.+) \} from '(node:[^']+)';$/gm,
      (_match: string, names: string, specifier: string) =>
        `const { ${names} } = require('${specifier}') as typeof import('${specifier}');`
    )
    .replace(
      /^import path from 'node:path';$/m,
      "const path = require('node:path') as typeof import('node:path');"
    )
    .replace(/^export (?=(?:function|const|interface|type)\b)/gm, '');
  if (!names.length || /^(?:import|export) /m.test(output))
    throw new Error('Unsupported ACL policy module format');
  return (
    '/* Generated from src/features/local-http-auth/main/infrastructure/privateFileAcl.ts. */\n' +
    '/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS controller adapter */\n' +
    output.trimEnd() +
    `\n\nmodule.exports = { ${names.join(', ')} };\n`
  );
}
