import { readFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';
import postcss from 'postcss';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import cases from '../fixtures/native-tool-parity/lint-cases.json';

import { command, execute, prepareSandbox, proposal, put, requireNativeTools, run, sandbox } from './nativeToolParity.harness';

import type { NativeDiagnostic } from './nativeToolParity.harness';

beforeAll(() => { requireNativeTools(); prepareSandbox(); });

describe('bounded native overlap', () => {
  function assertNative(diagnostics: NativeDiagnostic[], path: string, code: string, severity: string): void {
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code, severity, filename: path });
    expect(diagnostics[0].labels[0].span.line).toBeGreaterThan(0);
    expect(diagnostics[0].labels[0].span.column).toBeGreaterThan(0);
    expect(diagnostics[0].labels[0].span.length).toBeGreaterThan(0);
  }
  for (const row of cases.filter((entry) => entry.native)) {
    it(`native ${row.name}`, () => {
      put(row.path, row.bad);
      const result = run('oxlint', ['--config', '.oxlintrc.json', '--format', 'json', row.path]);
      const diagnostics = (JSON.parse(result.stdout) as { diagnostics: NativeDiagnostic[] }).diagnostics;
      assertNative(diagnostics, row.path, row.nativeCode!, row.severity === 2 ? 'error' : 'warning');
      expect(diagnostics[0].labels[0].span).toEqual(row.nativeSpan);
      expect(result.status).toBe(row.severity === 2 ? 1 : 0);
      put(row.path, row.good);
      const control = run('oxlint', ['--config', '.oxlintrc.json', '--format', 'json', row.path]);
      expect(control.status).toBe(0);
      expect((JSON.parse(control.stdout) as { diagnostics: unknown[] }).diagnostics).toEqual([]);
    });
  }
  it('same-count same-severity wrong-rule output fails the rejecting oracle', () => {
    const path = 'src/main/parity/wrong-rule.ts';
    put(path, 'let value = 1; export { value };');
    const result = run('oxlint', ['--config', '.oxlintrc.json', '--format', 'json', path]);
    const diagnostics = (JSON.parse(result.stdout) as { diagnostics: NativeDiagnostic[] }).diagnostics;
    expect(result.status).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'eslint(prefer-const)', severity: 'error' });
    expect(() => assertNative(diagnostics, path, 'eslint(no-var)', 'error')).toThrow();
    assertNative(diagnostics, path, 'eslint(prefer-const)', 'error');
  });
  it('native overlap applies independently to every source process and feature scope', () => {
    for (const prefix of ['main', 'preload', 'renderer', 'shared', 'features/parity/core/domain', 'features/parity/renderer']) {
      const path = `src/${prefix}/native.ts`;
      put(path, 'export var value = 1;');
      const rejected = run('oxlint', ['--config', '.oxlintrc.json', '--format', 'json', path]);
      expect(rejected.status).toBe(1);
      assertNative((JSON.parse(rejected.stdout) as { diagnostics: NativeDiagnostic[] }).diagnostics,
        path, 'eslint(no-var)', 'error');
      put(path, 'export const value = 1;');
      expect(run('oxlint', ['--config', '.oxlintrc.json', path]).status).toBe(0);
    }
  });
});

describe('native formatter semantic and fallback controls', () => {
  it('hostile nested native config cannot replace the approved root profile', () => {
    const path = 'src/renderer/native-config/value.ts';
    const input = "export const value={message:'approved'}";
    put(path, input);
    put('src/renderer/native-config/.oxfmtrc.json', JSON.stringify({
      semi: false, singleQuote: false, tabWidth: 8,
    }));
    const before = readFileSync(resolve(sandbox, path));
    const controlPath = 'src/renderer/native-config/control.ts';
    put(controlPath, input);
    const unsafe = run('oxfmt', ['--write', controlPath]);
    expect(unsafe.status).toBe(0);
    // This independent control proves the config is actually discovered by the CLI.
    expect(readFileSync(resolve(sandbox, controlPath), 'utf8'))
      .toBe('export const value = { message: "approved" }\n');
    const expected = "export const value = { message: 'approved' };\n";
    const protectedFile = run('oxfmt', ['--disable-nested-config', '--write', controlPath]);
    expect(protectedFile.status).toBe(0);
    expect(readFileSync(resolve(sandbox, controlPath), 'utf8')).toBe(expected);
    const script = resolve(sandbox, 'scripts/local-checks/desktop-native-check.ts');
    const result = command(script, ['--proposal', path]);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as { engine: string; proposal: string };
    expect(observed.engine).toBe('oxfmt');
    expect(observed.proposal).toBe(expected);
    expect(execute(observed.proposal)).toEqual(execute(input));
    expect(proposal(path, observed.proposal)).toBe(expected);
    expect(readFileSync(resolve(sandbox, path))).toEqual(before);
  });
  it('imports, attached comments and executable meaning survive and formatting is idempotent', () => {
    const input = "// side effect B\nimport './b';\n// side effect A\nimport './a';\nimport {value} from './value';\nexport const result={answer:value+2};";
    const output = proposal('src/main/meaning.ts', input);
    expect(output).toContain('// side effect B\nimport');
    expect(output).toContain('// side effect A\nimport');
    expect(execute(output)).toEqual(execute(input));
    expect(proposal('src/main/meaning.ts', output)).toBe(output);
  });
  it('JSON and JSONC preserve parsed values and package key order without trailing commas', () => {
    for (const path of ['package.json', 'settings.json', 'settings.jsonc']) {
      const input = path.endsWith('jsonc') ? '// reason\n{"z":1,"a":[2,3,],}' : '{"z":1,"a":[2,3]}';
      const output = proposal(path, input);
      expect(parseJsonc(output)).toEqual(parseJsonc(input));
      expect(output.indexOf('"z"')).toBeLessThan(output.indexOf('"a"'));
      if (path.endsWith('jsonc')) expect(output).toContain('// reason');
      expect(output).not.toMatch(/,\s*[\]}]/);
      expect(proposal(path, output)).toBe(output);
    }
  });
  it('CSS preserves declarations and Markdown preserves code meaning and prose override', () => {
    const css = '.view{color:var(--color-text);padding:2px 4px}';
    const output = proposal('src/renderer/view.css', css);
    const declarations = (text: string) => {
      const values: string[] = [];
      postcss.parse(text).walkDecls((node) => { values.push(`${node.prop}:${node.value}`); });
      return values;
    };
    expect(declarations(output)).toEqual(declarations(css));
    expect(proposal('src/renderer/view.css', output)).toBe(output);
    const prose = 'A deliberately long prose paragraph '.repeat(8).trim();
    const markdown = `${prose}\n\n\`\`\`json\n{"answer":42}\n\`\`\`\n`;
    const formatted = proposal('README.md', markdown);
    expect(formatted).toContain(prose);
    expect(JSON.parse(formatted.split('```')[1].replace(/^json\n/, '').trim())).toEqual({ answer: 42 });
    expect(proposal('README.md', formatted)).toBe(formatted);
  });
  it('Tailwind v3 custom theme and plugins sort exactly like current Prettier', async () => {
    const path = resolve(sandbox, 'src/renderer/Theme.tsx');
    const input = 'export const View = () => <div className="text-text-secondary p-4 bg-surface-raised animate-in flex" />;';
    const output = proposal(path, input);
    const options = await resolveConfig(path);
    expect(output).toBe(await format(input, { ...options, filepath: path }));
    const classes = (text: string) => text.match(/className="([^"]+)"/)![1].split(' ').sort();
    expect(classes(output)).toEqual(classes(input));
    expect(proposal(path, output)).toBe(output);
    expect(ts.transpileModule(output, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX } }).diagnostics).toEqual([]);
  });
  it('later matching overrides win in the installed native formatter', () => {
    put('override.json', JSON.stringify({ semi: true, overrides: [
      { files: ['*.ts'], options: { semi: false } },
      { files: ['*.ts'], options: { semi: true } },
    ] }));
    const result = run('oxfmt', ['--config', 'override.json', '--stdin-filepath', 'override.ts'], 'const value=1');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('const value = 1;\n');
  });
  it('explicit ignored paths stay byte-identical in check mode', () => {
    for (const path of ['dist/generated.js', 'src/vendor.min.js', 'src/features/localization/renderer/resources.d.ts', 'pnpm-lock.yaml', 'owned.config.ts']) {
      put(path, 'invalid { unformatted');
      const before = readFileSync(resolve(sandbox, path), 'utf8');
      const ignored = run('oxfmt', ['--config', '.oxfmtrc.json', '--disable-nested-config', '--check', path]);
      expect(ignored.status).toBe(2);
      expect(ignored.stderr).toContain('All matched files may have been excluded by ignore rules');
      expect(readFileSync(resolve(sandbox, path), 'utf8')).toBe(before);
      expect(run('prettier', ['--check', '--ignore-path', '.prettierignore', path]).status).toBe(0);
    }
  });
  it('proposal/check never overwrite inputs, reject bare paths and symlinks, and use Prettier for a user plugin', () => {
    const script = resolve(sandbox, 'scripts/local-checks/desktop-native-check.ts');
    const call = (...args: string[]) => command(script, args);
    const path = 'src/renderer/user/value.ts';
    put(path, 'export const value={answer:42}');
    const before = readFileSync(resolve(sandbox, path), 'utf8');
    expect(call('--check', path).status).toBe(1);
    const proposed = call('--proposal', path);
    expect(proposed.status, proposed.stderr).toBe(0);
    expect(JSON.parse(proposed.stdout).engine).toBe('oxfmt');
    expect(readFileSync(resolve(sandbox, path), 'utf8')).toBe(before);
    expect(call('--check').status).not.toBe(0);
    expect(call('--proposal', '../outside.ts').status).not.toBe(0);
    symlinkSync(resolve(sandbox, path), resolve(sandbox, 'src/renderer/link.ts'));
    expect(call('--proposal', 'src/renderer/link.ts').status).not.toBe(0);
    const plugin = resolve(sandbox, 'src/renderer/user/plugin.mts');
    put('src/renderer/user/plugin.mts', 'export default { options: {} };');
    put('src/renderer/user/.prettierrc.json', JSON.stringify({ semi: false, plugins: [plugin] }));
    const fallback = call('--proposal', path);
    expect(fallback.status, fallback.stderr).toBe(0);
    const result = JSON.parse(fallback.stdout) as { engine: string; proposal: string };
    expect(result.engine).toBe('prettier');
    expect(result.proposal).toBe('export const value = { answer: 42 }\n');
    expect(readFileSync(resolve(sandbox, path), 'utf8')).toBe(before);
    put('src/renderer/user/reject-plugin.mts', "throw new Error('user plugin load rejected'); export default { options: {} };");
    put('src/renderer/user/.prettierrc.json', JSON.stringify({
      semi: false, plugins: [resolve(sandbox, 'src/renderer/user/reject-plugin.mts')],
    }));
    const rejectedPlugin = call('--proposal', path);
    expect(rejectedPlugin.status).not.toBe(0);
    expect(rejectedPlugin.stderr).toContain('user plugin load rejected');
    expect(readFileSync(resolve(sandbox, path), 'utf8')).toBe(before);
  });
});
