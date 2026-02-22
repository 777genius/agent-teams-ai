import { describe, expect, it } from 'vitest';

import { estimateBashLinesChanged } from '../../../../src/main/services/team/MemberStatsComputer';

describe('estimateBashLinesChanged', () => {
  it('returns zero for simple non-writing commands', () => {
    expect(estimateBashLinesChanged('ls -la')).toEqual({ added: 0, removed: 0, files: [] });
    expect(estimateBashLinesChanged('cd /tmp')).toEqual({ added: 0, removed: 0, files: [] });
    expect(estimateBashLinesChanged('git status')).toEqual({ added: 0, removed: 0, files: [] });
  });

  it('counts lines in heredoc', () => {
    const cmd = `cat <<'EOF' > /tmp/test.txt\nline1\nline2\nline3\nEOF`;
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(3);
  });

  it('counts lines in heredoc without quotes', () => {
    const cmd = `cat <<EOF > /tmp/test.txt\nfirst\nsecond\nEOF`;
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(2);
  });

  it('counts echo redirect with newlines', () => {
    const cmd = 'echo "line1\\nline2\\nline3" > /tmp/out.txt';
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(3);
    expect(result.files).toContain('/tmp/out.txt');
  });

  it('counts printf redirect', () => {
    const cmd = "printf 'hello\\nworld' > /tmp/out.txt";
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(2);
    expect(result.files).toContain('/tmp/out.txt');
  });

  it('counts sed -i as 1 line changed', () => {
    const cmd = "sed -i 's/old/new/g' /tmp/file.txt";
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.files).toContain('/tmp/file.txt');
  });

  it('counts sed with combined flags', () => {
    const cmd = "sed -Ei 's/pattern/replacement/' /tmp/file.txt";
    const result = estimateBashLinesChanged(cmd);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('extracts file from redirect (catch-all)', () => {
    const cmd = 'some_command > /tmp/output.log';
    const result = estimateBashLinesChanged(cmd);
    expect(result.files).toContain('/tmp/output.log');
  });

  it('extracts file from tee', () => {
    const cmd = 'echo test | tee /tmp/output.txt';
    const result = estimateBashLinesChanged(cmd);
    expect(result.files).toContain('/tmp/output.txt');
  });

  it('extracts file from tee -a (append)', () => {
    const cmd = 'echo test | tee -a /tmp/output.txt';
    const result = estimateBashLinesChanged(cmd);
    expect(result.files).toContain('/tmp/output.txt');
  });

  it('handles empty command', () => {
    expect(estimateBashLinesChanged('')).toEqual({ added: 0, removed: 0, files: [] });
  });
});
