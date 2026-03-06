import { describe, it, expect } from 'vitest';
import {
  teamNameSchema,
  taskIdSchema,
  memberNameSchema,
  taskStatusSchema,
  kanbanColumnSchema,
  clarificationSchema,
  linkTypeSchema,
  linkOperationSchema,
  reviewDecisionSchema,
  reviewerOperationSchema,
  taskIdsArraySchema,
  filePathSchema,
  safeFilenameSchema,
  mimeTypeSchema,
} from '../src/schemas.js';

describe('teamNameSchema', () => {
  it('accepts valid team names', () => {
    expect(teamNameSchema.parse('acme')).toBe('acme');
    expect(teamNameSchema.parse('my-team')).toBe('my-team');
    expect(teamNameSchema.parse('My_Team')).toBe('My_Team');
    expect(teamNameSchema.parse('team123')).toBe('team123');
  });

  it('rejects empty', () => {
    expect(() => teamNameSchema.parse('')).toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => teamNameSchema.parse('..')).toThrow();
    expect(() => teamNameSchema.parse('.')).toThrow();
    expect(() => teamNameSchema.parse('a/b')).toThrow();
    expect(() => teamNameSchema.parse('a\\b')).toThrow();
    expect(() => teamNameSchema.parse('a..b')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => teamNameSchema.parse('a\0b')).toThrow();
  });

  it('rejects too long', () => {
    expect(() => teamNameSchema.parse('a'.repeat(129))).toThrow();
  });
});

describe('taskIdSchema', () => {
  it('accepts numeric IDs', () => {
    expect(taskIdSchema.parse('1')).toBe('1');
    expect(taskIdSchema.parse('42')).toBe('42');
    expect(taskIdSchema.parse('1234567890')).toBe('1234567890');
  });

  it('accepts zero', () => {
    expect(taskIdSchema.parse('0')).toBe('0');
  });

  it('accepts leading zeros', () => {
    expect(taskIdSchema.parse('007')).toBe('007');
  });

  it('rejects non-numeric', () => {
    expect(() => taskIdSchema.parse('abc')).toThrow();
    expect(() => taskIdSchema.parse('')).toThrow();
    expect(() => taskIdSchema.parse('1.5')).toThrow();
    expect(() => taskIdSchema.parse('-1')).toThrow();
  });

  it('rejects too long', () => {
    expect(() => taskIdSchema.parse('12345678901')).toThrow();
  });
});

describe('memberNameSchema', () => {
  it('accepts valid member names', () => {
    expect(memberNameSchema.parse('alice')).toBe('alice');
    expect(memberNameSchema.parse('bob-smith')).toBe('bob-smith');
    expect(memberNameSchema.parse('user_1')).toBe('user_1');
  });

  it('rejects path traversal', () => {
    expect(() => memberNameSchema.parse('..')).toThrow();
    expect(() => memberNameSchema.parse('a/b')).toThrow();
    expect(() => memberNameSchema.parse('a\\b')).toThrow();
    expect(() => memberNameSchema.parse('a..b')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => memberNameSchema.parse('a\0b')).toThrow();
  });

  it('rejects too long', () => {
    expect(() => memberNameSchema.parse('a'.repeat(129))).toThrow();
  });

  it('rejects empty', () => {
    expect(() => memberNameSchema.parse('')).toThrow();
  });
});

describe('enum schemas', () => {
  it('taskStatusSchema accepts valid values', () => {
    expect(taskStatusSchema.parse('pending')).toBe('pending');
    expect(taskStatusSchema.parse('in_progress')).toBe('in_progress');
    expect(taskStatusSchema.parse('completed')).toBe('completed');
    expect(taskStatusSchema.parse('deleted')).toBe('deleted');
    expect(() => taskStatusSchema.parse('invalid')).toThrow();
  });

  it('kanbanColumnSchema accepts valid values', () => {
    expect(kanbanColumnSchema.parse('review')).toBe('review');
    expect(kanbanColumnSchema.parse('approved')).toBe('approved');
    expect(() => kanbanColumnSchema.parse('todo')).toThrow();
    expect(() => kanbanColumnSchema.parse('')).toThrow();
  });

  it('clarificationSchema accepts valid values', () => {
    expect(clarificationSchema.parse('lead')).toBe('lead');
    expect(clarificationSchema.parse('user')).toBe('user');
    expect(clarificationSchema.parse('clear')).toBe('clear');
    expect(() => clarificationSchema.parse('nobody')).toThrow();
  });

  it('linkTypeSchema accepts valid values', () => {
    expect(linkTypeSchema.parse('blocked-by')).toBe('blocked-by');
    expect(linkTypeSchema.parse('blocks')).toBe('blocks');
    expect(linkTypeSchema.parse('related')).toBe('related');
  });

  it('linkOperationSchema accepts valid values', () => {
    expect(linkOperationSchema.parse('link')).toBe('link');
    expect(linkOperationSchema.parse('unlink')).toBe('unlink');
  });

  it('reviewDecisionSchema accepts valid values', () => {
    expect(reviewDecisionSchema.parse('approve')).toBe('approve');
    expect(reviewDecisionSchema.parse('request-changes')).toBe('request-changes');
  });

  it('reviewerOperationSchema accepts valid values', () => {
    expect(reviewerOperationSchema.parse('list')).toBe('list');
    expect(reviewerOperationSchema.parse('add')).toBe('add');
    expect(reviewerOperationSchema.parse('remove')).toBe('remove');
  });
});

describe('taskIdsArraySchema', () => {
  it('accepts valid arrays', () => {
    expect(taskIdsArraySchema.parse(['1', '2', '3'])).toEqual(['1', '2', '3']);
    expect(taskIdsArraySchema.parse([])).toEqual([]);
  });

  it('rejects arrays with invalid IDs', () => {
    expect(() => taskIdsArraySchema.parse(['abc'])).toThrow();
    expect(() => taskIdsArraySchema.parse(['1', 'bad'])).toThrow();
  });
});

describe('filePathSchema', () => {
  it('accepts absolute paths', () => {
    expect(filePathSchema.parse('/home/user/file.txt')).toBe('/home/user/file.txt');
    expect(filePathSchema.parse('/tmp/attachment.pdf')).toBe('/tmp/attachment.pdf');
  });

  it('rejects relative paths', () => {
    expect(() => filePathSchema.parse('relative/path.txt')).toThrow();
    expect(() => filePathSchema.parse('./file.txt')).toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => filePathSchema.parse('/home/user/../etc/passwd')).toThrow();
    expect(() => filePathSchema.parse('/home/../../../etc/shadow')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => filePathSchema.parse('/home/user/\0evil')).toThrow();
  });

  it('rejects empty', () => {
    expect(() => filePathSchema.parse('')).toThrow();
  });
});

describe('safeFilenameSchema', () => {
  it('accepts valid filenames', () => {
    expect(safeFilenameSchema.parse('report.pdf')).toBe('report.pdf');
    expect(safeFilenameSchema.parse('my-file_v2.tar.gz')).toBe('my-file_v2.tar.gz');
  });

  it('rejects path separators', () => {
    expect(() => safeFilenameSchema.parse('../../evil')).toThrow();
    expect(() => safeFilenameSchema.parse('dir/file')).toThrow();
    expect(() => safeFilenameSchema.parse('dir\\file')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => safeFilenameSchema.parse('file\0name')).toThrow();
  });

  it('rejects too long', () => {
    expect(() => safeFilenameSchema.parse('a'.repeat(256))).toThrow();
  });
});

describe('mimeTypeSchema', () => {
  it('accepts valid MIME types', () => {
    expect(mimeTypeSchema.parse('application/pdf')).toBe('application/pdf');
    expect(mimeTypeSchema.parse('image/png')).toBe('image/png');
    expect(mimeTypeSchema.parse('text/plain')).toBe('text/plain');
    expect(mimeTypeSchema.parse('application/octet-stream')).toBe('application/octet-stream');
  });

  it('rejects invalid formats', () => {
    expect(() => mimeTypeSchema.parse('invalid')).toThrow();
    expect(() => mimeTypeSchema.parse('/pdf')).toThrow();
    expect(() => mimeTypeSchema.parse('application/')).toThrow();
    expect(() => mimeTypeSchema.parse('')).toThrow();
  });
});
