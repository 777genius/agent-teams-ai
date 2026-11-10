#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const PROMPT = 'Look at the attached image. Reply with exactly one word: red, green, or blue.';
const MULTI_IMAGE_PROMPT =
  'Look at every attached image. Each image has a dominant background color. Reply with exactly one word: red, green, or blue. Use red if the dominant background color is red in all images.';
const TIMEOUT_MS = 90_000;

const CASES = [
  {
    id: 'claude-subscription-streaming',
    runtime: 'claude',
    model: process.env.CLAUDE_ATTACHMENTS_SMOKE_CLAUDE_MODEL || 'claude-haiku-4-5',
    command: async (imagePath, cwd, testCase, imagePaths) => ({
      bin: 'claude',
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--model',
        testCase.model,
      ],
      cwd,
      stdin: await buildClaudeStreamJsonPrompt(imagePaths, PROMPT),
    }),
    expected: /red/i,
  },
  {
    id: 'claude-subscription-streaming-multi-image',
    runtime: 'claude',
    model: process.env.CLAUDE_ATTACHMENTS_SMOKE_CLAUDE_MODEL || 'claude-haiku-4-5',
    imageCount: 3,
    imageWidth: 1600,
    imageHeight: 1100,
    command: async (imagePath, cwd, testCase, imagePaths) => ({
      bin: 'claude',
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--model',
        testCase.model,
      ],
      cwd,
      stdin: await buildClaudeStreamJsonPrompt(imagePaths, MULTI_IMAGE_PROMPT),
    }),
    expected: /red/i,
  },
  {
    id: 'codex-native-gpt-5-4-mini',
    runtime: 'codex',
    model: 'gpt-5.4-mini',
    command: (imagePath, cwd) => ({
      bin: 'codex',
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        cwd,
        '--model',
        'gpt-5.4-mini',
        '--image',
        imagePath,
        '-',
      ],
      stdin: PROMPT,
    }),
    expected: /red/i,
  },
  {
    id: 'codex-native-gpt-5-4-mini-multi-image',
    runtime: 'codex',
    model: 'gpt-5.4-mini',
    imageCount: 3,
    imageWidth: 1600,
    imageHeight: 1100,
    command: (imagePath, cwd, testCase, imagePaths) => ({
      bin: 'codex',
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        cwd,
        '--model',
        'gpt-5.4-mini',
        ...imagePaths.flatMap((candidate) => ['--image', candidate]),
        '-',
      ],
      stdin: MULTI_IMAGE_PROMPT,
    }),
    expected: /red/i,
  },
  {
    id: 'opencode-openai-gpt-5-4-mini',
    runtime: 'opencode',
    model: 'openai/gpt-5.4-mini',
    command: (imagePath, cwd) => ({
      bin: 'opencode',
      args: [
        'run',
        '--pure',
        '--format',
        'json',
        '--dir',
        cwd,
        '--model',
        'openai/gpt-5.4-mini',
        PROMPT,
        '-f',
        imagePath,
      ],
    }),
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-kimi-k2-6-multi-image',
    runtime: 'opencode',
    model: 'openrouter/moonshotai/kimi-k2.6',
    envRequired: ['OPENROUTER_API_KEY'],
    imageCount: 3,
    imageWidth: 1600,
    imageHeight: 1100,
    command: (imagePath, cwd, testCase, imagePaths) => ({
      bin: 'opencode',
      args: [
        'run',
        '--pure',
        '--format',
        'json',
        '--dir',
        cwd,
        '--model',
        'openrouter/moonshotai/kimi-k2.6',
        MULTI_IMAGE_PROMPT,
        ...imagePaths.flatMap((candidate) => ['-f', candidate]),
      ],
    }),
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-kimi-k2-6',
    runtime: 'opencode',
    model: 'openrouter/moonshotai/kimi-k2.6',
    envRequired: ['OPENROUTER_API_KEY'],
    command: (imagePath, cwd) => ({
      bin: 'opencode',
      args: [
        'run',
        '--pure',
        '--format',
        'json',
        '--dir',
        cwd,
        '--model',
        'openrouter/moonshotai/kimi-k2.6',
        PROMPT,
        '-f',
        imagePath,
      ],
    }),
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-glm-4-5v',
    runtime: 'opencode',
    model: 'openrouter/z-ai/glm-4.5v',
    envRequired: ['OPENROUTER_API_KEY'],
    command: (imagePath, cwd) => ({
      bin: 'opencode',
      args: [
        'run',
        '--pure',
        '--format',
        'json',
        '--dir',
        cwd,
        '--model',
        'openrouter/z-ai/glm-4.5v',
        PROMPT,
        '-f',
        imagePath,
      ],
    }),
    expected: /red/i,
  },
  {
    id: 'opencode-openrouter-glm-5-1-negative',
    runtime: 'opencode',
    model: 'openrouter/z-ai/glm-5.1',
    envRequired: ['OPENROUTER_API_KEY'],
    command: (imagePath, cwd) => ({
      bin: 'opencode',
      args: [
        'run',
        '--pure',
        '--format',
        'json',
        '--dir',
        cwd,
        '--model',
        'openrouter/z-ai/glm-5.1',
        PROMPT,
        '-f',
        imagePath,
      ],
    }),
    expectedUnsupported: true,
  },
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function createRedCardPng(width = 320, height = 240) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const marker = x > 135 && x < 185 && y > 95 && y < 145;
      raw[offset] = 230;
      raw[offset + 1] = marker ? 245 : 20;
      raw[offset + 2] = marker ? 245 : 20;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function buildClaudeStreamJsonPrompt(imagePaths, prompt) {
  const imageBlocks = [];
  for (const imagePath of imagePaths) {
    const data = await readFile(imagePath, 'base64');
    imageBlocks.push({
      type: 'image',
      source: {
        // Claude stream-json expects image bytes inside a structured image block.
        // Do not replace this with base64-in-text fallback because that tests a different path.
        type: 'base64',
        media_type: 'image/png',
        data,
      },
    });
  }
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imageBlocks,
      ],
    },
  })}\n`;
}

function parseArgs(argv) {
  const selected = [];
  let all = false;
  let list = false;
  let jsonPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--case' && argv[index + 1]) {
      selected.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--json' && argv[index + 1]) {
      jsonPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (all && selected.length) {
    throw new Error('Use either --all or one or more --case arguments, not both');
  }
  return { all, jsonPath, list, selected };
}

function hasPathSeparator(value) {
  return value.includes('/') || value.includes('\\');
}

function resolveWindowsSpawnBinary(binary) {
  if (process.platform !== 'win32') {
    return binary;
  }

  if (hasPathSeparator(binary)) {
    if (!path.extname(binary) && existsSync(`${binary}.cmd`)) {
      return `${binary}.cmd`;
    }
    return binary;
  }

  const whereResult = spawnSync('where.exe', [binary], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    return binary;
  }

  const candidates = whereResult.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const extensionlessShim = candidates.find(
    (candidate) => !path.extname(candidate) && existsSync(`${candidate}.cmd`)
  );
  if (extensionlessShim) {
    return `${extensionlessShim}.cmd`;
  }
  return (
    candidates.find((candidate) => /\.exe$/i.test(candidate)) ??
    candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate)) ??
    candidates[0] ??
    binary
  );
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (text.length === 0) {
    return '""';
  }
  if (!/[ \t\r\n"&|<>^()%!]/.test(text)) {
    return text;
  }
  return `"${text.replace(/%/g, '%%').replace(/(["^&|<>])/g, '^$1')}"`;
}

function buildSpawnInvocation(command) {
  if (process.platform !== 'win32') {
    return {
      bin: command.bin,
      args: command.args,
      options: { windowsHide: true },
    };
  }

  const resolvedBin = resolveWindowsSpawnBinary(command.bin);
  if (/\.(?:cmd|bat)$/i.test(resolvedBin)) {
    const commandLine = [resolvedBin, ...command.args].map(quoteWindowsCmdArg).join(' ');
    return {
      bin: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
      options: { windowsHide: true, windowsVerbatimArguments: true },
    };
  }

  return {
    bin: resolvedBin,
    args: command.args,
    options: { windowsHide: true },
  };
}

function runCommand(command) {
  return new Promise((resolve) => {
    const spawnInvocation = buildSpawnInvocation(command);
    const child = spawn(spawnInvocation.bin, spawnInvocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      cwd: command.cwd,
      ...spawnInvocation.options,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, timedOut: true, exitCode: null, stdout, stderr });
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, exitCode: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut: false, exitCode: code, stdout, stderr });
    });
    if (command.stdin) {
      child.stdin.end(command.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function redactSmokeText(value) {
  let redacted = value
    .replace(/(data:image\/[a-z0-9.+-]+;base64,)[a-z0-9+/=]+/gi, '$1[redacted]')
    .replace(/("[Dd]ata"\s*:\s*")[a-z0-9+/=]{80,}(")/g, '$1[redacted]$2')
    .replace(/("[Ss]ignature"\s*:\s*")[^"]{80,}(")/g, '$1[redacted]$2')
    .replace(/\b[A-Za-z0-9+/]{400,}={0,2}\b/g, '[redacted long encoded payload]')
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, '$1[redacted]')
    .replace(/\b(sk-(?:ant|or|proj|live|test|codex|openai)[A-Za-z0-9._~+/=-]{12,})\b/g, '[redacted api key]');

  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8) continue;
    if (!/(API[_-]?KEY|TOKEN|SECRET|AUTH|PASSWORD|OPENROUTER|ANTHROPIC|OPENAI|CODEX)/i.test(name)) {
      continue;
    }
    redacted = redacted.split(secret).join(`[redacted ${name}]`);
  }

  return redacted;
}

function extractAssistantTextFromJsonLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed.result === 'string') {
    return parsed.result;
  }
  if (parsed.type === 'item.completed' && typeof parsed.item?.text === 'string') {
    return parsed.item.text;
  }
  if (parsed.type === 'text' && typeof parsed.part?.text === 'string') {
    return parsed.part.text;
  }
  const content = parsed.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return null;
}

function extractAssistantText(output) {
  const texts = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const text = extractAssistantTextFromJsonLine(trimmed);
    if (text?.trim()) {
      texts.push(text.trim());
    }
  }
  return texts.join('\n').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log(CASES.map((testCase) => testCase.id).join('\n'));
    return;
  }

  const selected =
    args.all || !args.selected.length
      ? CASES
      : CASES.filter((testCase) => args.selected.includes(testCase.id));
  const missing = args.selected.filter((id) => !CASES.some((testCase) => testCase.id === id));
  if (missing.length) {
    throw new Error(`Unknown smoke case: ${missing.join(', ')}`);
  }

  const cwd = await mkdtemp(path.join(tmpdir(), 'agent-attachments-smoke-'));
  await mkdir(cwd, { recursive: true });

  const results = [];
  const imagePathsByCase = {};
  for (const testCase of selected) {
    const missingEnv = (testCase.envRequired ?? []).filter((name) => !process.env[name]);
    if (missingEnv.length) {
      results.push({
        id: testCase.id,
        runtime: testCase.runtime,
        model: testCase.model,
        status: 'skipped',
        reason: `missing env: ${missingEnv.join(', ')}`,
      });
      continue;
    }

    const imagePaths = await prepareSmokeImages(cwd, testCase);
    imagePathsByCase[testCase.id] = imagePaths;
    const command = await testCase.command(imagePaths[0], cwd, testCase, imagePaths);
    const result = await runCommand(command);
    const output = `${result.stdout}\n${result.stderr}`;
    const assistantText = extractAssistantText(output);
    const matched = testCase.expected
      ? result.ok && assistantText.length > 0 && testCase.expected.test(assistantText)
      : false;
    const unsupportedMatched = testCase.expectedUnsupported
      ? result.ok &&
        assistantText.length > 0 &&
        /cannot|unable|unsupported|text-only|vision|image|не могу|не поддерживает|изображен/i.test(
          assistantText
        )
      : false;
    results.push({
      id: testCase.id,
      runtime: testCase.runtime,
      model: testCase.model,
      status:
        (testCase.expectedUnsupported ? unsupportedMatched : result.ok && matched)
          ? 'passed'
          : 'failed',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      assistantText: redactSmokeText(assistantText.slice(-1000)),
      stdoutTail: redactSmokeText(result.stdout.slice(-4000)),
      stderrTail: redactSmokeText(result.stderr.slice(-4000)),
    });
  }

  const firstImagePath = Object.values(imagePathsByCase)[0]?.[0] ?? null;
  const report = { imagePath: firstImagePath, imagePathsByCase, results };
  if (args.jsonPath) {
    await writeFile(path.resolve(args.jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.status === 'failed')) {
    process.exitCode = 1;
  }
}

async function prepareSmokeImages(cwd, testCase) {
  const imageCount = testCase.imageCount ?? 1;
  const width = testCase.imageWidth ?? 320;
  const height = testCase.imageHeight ?? 240;
  const paths = [];
  for (let index = 0; index < imageCount; index += 1) {
    const imagePath = path.join(cwd, `red-card-${testCase.id}-${index + 1}.png`);
    await writeFile(imagePath, createRedCardPng(width, height));
    paths.push(imagePath);
  }
  return paths;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
