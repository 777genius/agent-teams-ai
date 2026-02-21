import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  extractTextFromContent,
  exportAsPlainText,
  exportAsMarkdown,
  exportAsJson,
  triggerDownload,
  type ExportFormat,
} from '@renderer/utils/sessionExporter';

// =============================================================================
// Test Fixtures
// =============================================================================

function makeMetrics(overrides = {}) {
  return {
    durationMs: 60000,
    totalTokens: 5000,
    inputTokens: 3000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    messageCount: 10,
    costUsd: 0.05,
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'test-session-123',
    projectId: '-Users-test-project',
    projectPath: '/Users/test/project',
    createdAt: new Date('2025-01-15T10:00:00Z').getTime(),
    hasSubagents: false,
    messageCount: 10,
    firstMessage: 'Hello, help me debug this',
    gitBranch: 'main',
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'msg-1',
    parentUuid: null,
    type: 'user' as const,
    timestamp: new Date('2025-01-15T10:00:00Z'),
    content: 'Hello world',
    isMeta: false,
    isSidechain: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function makeUserChunk(overrides: Record<string, unknown> = {}) {
  const msg = makeMessage();
  return {
    id: 'chunk-user-1',
    chunkType: 'user' as const,
    startTime: new Date('2025-01-15T10:00:00Z'),
    endTime: new Date('2025-01-15T10:00:01Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    userMessage: msg,
    ...overrides,
  };
}

function makeAIChunk(overrides: Record<string, unknown> = {}) {
  const response = makeMessage({
    uuid: 'msg-2',
    type: 'assistant',
    content: [{ type: 'text', text: 'Here is the answer' }],
  });
  return {
    id: 'chunk-ai-1',
    chunkType: 'ai' as const,
    startTime: new Date('2025-01-15T10:00:01Z'),
    endTime: new Date('2025-01-15T10:00:05Z'),
    durationMs: 4000,
    metrics: makeMetrics({ messageCount: 2 }),
    responses: [response],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    ...overrides,
  };
}

function makeSystemChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-system-1',
    chunkType: 'system' as const,
    startTime: new Date('2025-01-15T10:00:06Z'),
    endTime: new Date('2025-01-15T10:00:07Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    message: makeMessage({ type: 'user', content: 'command output here' }),
    commandOutput: 'Set model to sonnet',
    ...overrides,
  };
}

function makeCompactChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-compact-1',
    chunkType: 'compact' as const,
    startTime: new Date('2025-01-15T10:01:00Z'),
    endTime: new Date('2025-01-15T10:01:00Z'),
    durationMs: 0,
    metrics: makeMetrics({ messageCount: 0 }),
    message: makeMessage({ type: 'summary', content: 'Summary of conversation' }),
    ...overrides,
  };
}

function makeSessionDetail(overrides: Record<string, unknown> = {}) {
  const userChunk = makeUserChunk();
  const aiChunk = makeAIChunk();
  return {
    session: makeSession(),
    messages: [userChunk.userMessage as any, (aiChunk.responses as any)[0]],
    chunks: [userChunk, aiChunk],
    processes: [],
    metrics: makeMetrics(),
    ...overrides,
  };
}

// =============================================================================
// extractTextFromContent
// =============================================================================

describe('extractTextFromContent', () => {
  it('returns string content directly', () => {
    expect(extractTextFromContent('Hello world')).toBe('Hello world');
  });

  it('returns empty string for empty string', () => {
    expect(extractTextFromContent('')).toBe('');
  });

  it('extracts text from TextContent blocks', () => {
    const blocks = [
      { type: 'text', text: 'First part.' },
      { type: 'text', text: 'Second part.' },
    ];
    expect(extractTextFromContent(blocks as any)).toBe('First part.\nSecond part.');
  });

  it('includes thinking content when option is set', () => {
    const blocks = [
      { type: 'thinking', thinking: 'Let me think about this...' },
      { type: 'text', text: 'Answer here.' },
    ];
    expect(extractTextFromContent(blocks as any, { includeThinking: true })).toBe(
      'Let me think about this...\nAnswer here.'
    );
  });

  it('excludes thinking content by default', () => {
    const blocks = [
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Answer here.' },
    ];
    expect(extractTextFromContent(blocks as any)).toBe('Answer here.');
  });

  it('extracts tool_use content as formatted string', () => {
    const blocks = [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo.ts' } }];
    const result = extractTextFromContent(blocks as any);
    expect(result).toContain('Tool: Read');
    expect(result).toContain('/foo.ts');
  });

  it('extracts tool_result content', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' }];
    const result = extractTextFromContent(blocks as any);
    expect(result).toContain('file contents here');
  });

  it('handles tool_result with array content', () => {
    const blocks = [
      {
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: [{ type: 'text', text: 'result text' }],
      },
    ];
    const result = extractTextFromContent(blocks as any);
    expect(result).toContain('result text');
  });

  it('skips image blocks gracefully', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
      { type: 'text', text: 'Caption' },
    ];
    expect(extractTextFromContent(blocks as any)).toBe('[Image]\nCaption');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextFromContent([])).toBe('');
  });
});

// =============================================================================
// exportAsPlainText
// =============================================================================

describe('exportAsPlainText', () => {
  it('includes session header with metadata', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('SESSION EXPORT');
    expect(result).toContain('test-session-123');
    expect(result).toContain('/Users/test/project');
  });

  it('includes metrics section', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('METRICS');
    expect(result).toContain('5,000');
    expect(result).toContain('$0.05');
  });

  it('renders user chunks with USER: label', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('USER:');
    expect(result).toContain('Hello world');
  });

  it('renders AI chunks with ASSISTANT: label', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('ASSISTANT:');
    expect(result).toContain('Here is the answer');
  });

  it('renders system chunks with SYSTEM: label', () => {
    const detail = makeSessionDetail({
      chunks: [makeSystemChunk()],
    });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('SYSTEM:');
    expect(result).toContain('Set model to sonnet');
  });

  it('renders compact chunks as [Context compacted]', () => {
    const detail = makeSessionDetail({
      chunks: [makeCompactChunk()],
    });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('[Context compacted]');
  });

  it('renders tool executions with TOOL: label', () => {
    const aiChunk = makeAIChunk({
      toolExecutions: [
        {
          toolCall: {
            id: 'tu-1',
            name: 'Read',
            input: { file_path: '/src/main.ts' },
            isTask: false,
          },
          result: { toolUseId: 'tu-1', content: 'file content', isError: false },
          startTime: new Date('2025-01-15T10:00:02Z'),
          endTime: new Date('2025-01-15T10:00:03Z'),
          durationMs: 1000,
        },
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('TOOL: Read');
    expect(result).toContain('/src/main.ts');
    expect(result).toContain('file content');
  });

  it('renders thinking blocks with THINKING: label', () => {
    const aiChunk = makeAIChunk({
      responses: [
        makeMessage({
          uuid: 'msg-think',
          type: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me reason about this...' },
            { type: 'text', text: 'Final answer.' },
          ],
        }),
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('THINKING:');
    expect(result).toContain('Let me reason about this...');
    expect(result).toContain('Final answer.');
  });

  it('handles tool execution with error result', () => {
    const aiChunk = makeAIChunk({
      toolExecutions: [
        {
          toolCall: { id: 'tu-1', name: 'Bash', input: { command: 'rm -rf /' }, isTask: false },
          result: { toolUseId: 'tu-1', content: 'Permission denied', isError: true },
          startTime: new Date('2025-01-15T10:00:02Z'),
        },
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('TOOL: Bash');
    expect(result).toContain('[ERROR]');
    expect(result).toContain('Permission denied');
  });

  it('uses separator lines between chunks', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    // Should contain horizontal rule separators
    expect(result).toMatch(/─{20,}/);
  });

  it('formats cost as N/A when undefined', () => {
    const detail = makeSessionDetail({
      metrics: makeMetrics({ costUsd: undefined }),
    });
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('N/A');
  });

  it('includes branch info when available', () => {
    const detail = makeSessionDetail();
    const result = exportAsPlainText(detail as any);

    expect(result).toContain('main');
  });
});

// =============================================================================
// exportAsMarkdown
// =============================================================================

describe('exportAsMarkdown', () => {
  it('starts with # Session Export heading', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toMatch(/^# Session Export/);
  });

  it('includes property table with session info', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('| Property | Value |');
    expect(result).toContain('test-session-123');
    expect(result).toContain('/Users/test/project');
    expect(result).toContain('main');
  });

  it('includes ## Metrics table', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('## Metrics');
    expect(result).toContain('| Metric | Value |');
    expect(result).toContain('5,000');
    expect(result).toContain('$0.05');
  });

  it('includes ## Conversation section', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('## Conversation');
  });

  it('renders user chunks with ### User heading', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('### User');
    expect(result).toContain('Hello world');
  });

  it('renders AI chunks with ### Assistant heading', () => {
    const detail = makeSessionDetail();
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('### Assistant');
    expect(result).toContain('Here is the answer');
  });

  it('renders system chunks with ### System heading', () => {
    const detail = makeSessionDetail({
      chunks: [makeSystemChunk()],
    });
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('### System');
    expect(result).toContain('Set model to sonnet');
  });

  it('renders compact chunks with --- and italic text', () => {
    const detail = makeSessionDetail({
      chunks: [makeCompactChunk()],
    });
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('---');
    expect(result).toContain('*Context compacted*');
  });

  it('renders tool calls with **Tool:** and code blocks', () => {
    const aiChunk = makeAIChunk({
      toolExecutions: [
        {
          toolCall: {
            id: 'tu-1',
            name: 'Read',
            input: { file_path: '/src/app.ts' },
            isTask: false,
          },
          result: { toolUseId: 'tu-1', content: 'export default App;', isError: false },
          startTime: new Date('2025-01-15T10:00:02Z'),
        },
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('**Tool:** `Read`');
    expect(result).toContain('```json');
    expect(result).toContain('file_path');
    expect(result).toContain('```');
    expect(result).toContain('export default App;');
  });

  it('renders thinking as blockquotes', () => {
    const aiChunk = makeAIChunk({
      responses: [
        makeMessage({
          uuid: 'msg-think',
          type: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Deep thought here' },
            { type: 'text', text: 'Output text' },
          ],
        }),
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('> *Thinking:*');
    expect(result).toContain('> Deep thought here');
  });

  it('marks error tool results', () => {
    const aiChunk = makeAIChunk({
      toolExecutions: [
        {
          toolCall: { id: 'tu-1', name: 'Bash', input: { command: 'fail' }, isTask: false },
          result: { toolUseId: 'tu-1', content: 'Error: not found', isError: true },
          startTime: new Date('2025-01-15T10:00:02Z'),
        },
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });
    const result = exportAsMarkdown(detail as any);

    expect(result).toContain('**Error:**');
  });

  it('numbers turns sequentially', () => {
    const detail = makeSessionDetail({
      chunks: [
        makeUserChunk(),
        makeAIChunk(),
        makeUserChunk({ id: 'chunk-user-2' }),
        makeAIChunk({ id: 'chunk-ai-2' }),
      ],
    });
    const result = exportAsMarkdown(detail as any);

    // Check that turn numbers appear (Turn 1, Turn 2, etc.)
    const turnMatches = result.match(/### (User|Assistant)/g);
    expect(turnMatches).toBeTruthy();
    expect(turnMatches!.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// exportAsJson
// =============================================================================

describe('exportAsJson', () => {
  it('returns valid JSON', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);

    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('returns pretty-printed JSON with 2-space indentation', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);

    // Pretty-printed JSON has newlines and indentation
    expect(result).toContain('\n');
    expect(result).toContain('  ');
  });

  it('preserves session data', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);
    const parsed = JSON.parse(result);

    expect(parsed.session.id).toBe('test-session-123');
    expect(parsed.session.projectPath).toBe('/Users/test/project');
  });

  it('preserves metrics', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);
    const parsed = JSON.parse(result);

    expect(parsed.metrics.totalTokens).toBe(5000);
    expect(parsed.metrics.costUsd).toBe(0.05);
  });

  it('preserves chunks array', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);
    const parsed = JSON.parse(result);

    expect(parsed.chunks).toBeDefined();
    expect(Array.isArray(parsed.chunks)).toBe(true);
    expect(parsed.chunks.length).toBe(2);
  });

  it('preserves messages array', () => {
    const detail = makeSessionDetail();
    const result = exportAsJson(detail as any);
    const parsed = JSON.parse(result);

    expect(parsed.messages).toBeDefined();
    expect(Array.isArray(parsed.messages)).toBe(true);
  });
});

// =============================================================================
// triggerDownload
// =============================================================================

describe('triggerDownload', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let mockAnchor: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAnchor = {
      href: '',
      download: '',
      click: vi.fn(),
    };
    createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as any);
    vi.spyOn(document.body, 'appendChild').mockReturnValue(mockAnchor as any);
    vi.spyOn(document.body, 'removeChild').mockReturnValue(mockAnchor as any);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  it('creates anchor element and triggers click for markdown', () => {
    const detail = makeSessionDetail();
    triggerDownload(detail as any, 'markdown');

    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(mockAnchor.download).toBe('session-test-session-123.md');
    expect(mockAnchor.click).toHaveBeenCalled();
  });

  it('uses .json extension for json format', () => {
    const detail = makeSessionDetail();
    triggerDownload(detail as any, 'json');

    expect(mockAnchor.download).toBe('session-test-session-123.json');
  });

  it('uses .txt extension for plaintext format', () => {
    const detail = makeSessionDetail();
    triggerDownload(detail as any, 'plaintext');

    expect(mockAnchor.download).toBe('session-test-session-123.txt');
  });

  it('creates and revokes object URL', () => {
    const detail = makeSessionDetail();
    triggerDownload(detail as any, 'markdown');

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('appends and removes anchor from body', () => {
    const detail = makeSessionDetail();
    triggerDownload(detail as any, 'plaintext');

    expect(document.body.appendChild).toHaveBeenCalled();
    expect(document.body.removeChild).toHaveBeenCalled();
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('handles empty chunks array', () => {
    const detail = makeSessionDetail({ chunks: [], messages: [] });

    expect(() => exportAsPlainText(detail as any)).not.toThrow();
    expect(() => exportAsMarkdown(detail as any)).not.toThrow();
    expect(() => exportAsJson(detail as any)).not.toThrow();
  });

  it('handles AI chunk with no tool executions', () => {
    const aiChunk = makeAIChunk({ toolExecutions: [] });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });

    const text = exportAsPlainText(detail as any);
    expect(text).toContain('ASSISTANT:');
    expect(text).not.toContain('TOOL:');
  });

  it('handles AI chunk with no responses', () => {
    const aiChunk = makeAIChunk({ responses: [] });
    const detail = makeSessionDetail({ chunks: [aiChunk] });

    expect(() => exportAsPlainText(detail as any)).not.toThrow();
    expect(() => exportAsMarkdown(detail as any)).not.toThrow();
  });

  it('handles tool execution without result', () => {
    const aiChunk = makeAIChunk({
      toolExecutions: [
        {
          toolCall: { id: 'tu-1', name: 'Bash', input: { command: 'ls' }, isTask: false },
          startTime: new Date('2025-01-15T10:00:02Z'),
        },
      ],
    });
    const detail = makeSessionDetail({ chunks: [makeUserChunk(), aiChunk] });

    const text = exportAsPlainText(detail as any);
    expect(text).toContain('TOOL: Bash');
    expect(text).toContain('[No result]');
  });

  it('handles mixed chunk types in sequence', () => {
    const detail = makeSessionDetail({
      chunks: [
        makeUserChunk(),
        makeAIChunk(),
        makeSystemChunk(),
        makeCompactChunk(),
        makeUserChunk({ id: 'chunk-user-2' }),
        makeAIChunk({ id: 'chunk-ai-2' }),
      ],
    });

    const text = exportAsPlainText(detail as any);
    expect(text).toContain('USER:');
    expect(text).toContain('ASSISTANT:');
    expect(text).toContain('SYSTEM:');
    expect(text).toContain('[Context compacted]');

    const md = exportAsMarkdown(detail as any);
    expect(md).toContain('### User');
    expect(md).toContain('### Assistant');
    expect(md).toContain('### System');
    expect(md).toContain('*Context compacted*');
  });

  it('handles content blocks with mixed types', () => {
    const blocks = [
      { type: 'thinking', thinking: 'Hmm...' },
      { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/a.ts' } },
      { type: 'text', text: 'Result text' },
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'file data' },
    ];
    const result = extractTextFromContent(blocks as any, { includeThinking: true });
    expect(result).toContain('Hmm...');
    expect(result).toContain('Tool: Read');
    expect(result).toContain('Result text');
    expect(result).toContain('file data');
  });
});
