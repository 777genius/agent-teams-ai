import { describe, expect, it } from 'vitest';

import {
  isInboxNoiseMessage,
  isOnlyTeammateMessageBlocks,
  isThoughtProtocolNoise,
  stripTeammateMessageBlocks,
} from '../../../src/shared/utils/inboxNoise';

describe('stripTeammateMessageBlocks', () => {
  it('removes a single teammate-message block', () => {
    const text =
      '<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello world</teammate-message>';
    expect(stripTeammateMessageBlocks(text)).toBe('');
  });

  it('removes multiple teammate-message blocks', () => {
    const text = [
      '<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello</teammate-message>',
      '<teammate-message teammate_id="bob" color="#0f0" summary="ok">OK</teammate-message>',
    ].join('\n');
    expect(stripTeammateMessageBlocks(text)).toBe('');
  });

  it('preserves normal text around teammate-message blocks', () => {
    const text =
      'Before\n<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello</teammate-message>\nAfter';
    expect(stripTeammateMessageBlocks(text)).toBe('Before\n\nAfter');
  });

  it('returns text unchanged when no blocks are present', () => {
    const text = 'Just some normal text without protocol blocks.';
    expect(stripTeammateMessageBlocks(text)).toBe(text);
  });
});

describe('isOnlyTeammateMessageBlocks', () => {
  it('returns true for a single block', () => {
    expect(
      isOnlyTeammateMessageBlocks(
        '<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello</teammate-message>'
      )
    ).toBe(true);
  });

  it('returns true for multiple blocks with whitespace', () => {
    const text = [
      '<teammate-message teammate_id="a" color="" summary="">X</teammate-message>',
      '  ',
      '<teammate-message teammate_id="b" color="" summary="">Y</teammate-message>',
    ].join('\n');
    expect(isOnlyTeammateMessageBlocks(text)).toBe(true);
  });

  it('returns false when there is also regular text', () => {
    const text =
      'Hello\n<teammate-message teammate_id="a" color="" summary="">X</teammate-message>';
    expect(isOnlyTeammateMessageBlocks(text)).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(isOnlyTeammateMessageBlocks('Just a normal message')).toBe(false);
  });
});

describe('isThoughtProtocolNoise', () => {
  it('detects idle_notification JSON', () => {
    expect(
      isThoughtProtocolNoise('{"type":"idle_notification","message":"alice is idle"}')
    ).toBe(true);
  });

  it('detects shutdown_request JSON', () => {
    expect(
      isThoughtProtocolNoise('{"type":"shutdown_request","reason":"done"}')
    ).toBe(true);
  });

  it('detects shutdown_approved JSON', () => {
    expect(isThoughtProtocolNoise('{"type":"shutdown_approved"}')).toBe(true);
  });

  it('detects teammate_terminated JSON', () => {
    expect(isThoughtProtocolNoise('{"type":"teammate_terminated"}')).toBe(true);
  });

  it('detects pure teammate-message XML', () => {
    expect(
      isThoughtProtocolNoise(
        '<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello</teammate-message>'
      )
    ).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(isThoughtProtocolNoise('Reviewing the PR now.')).toBe(false);
  });

  it('returns false for non-noise JSON', () => {
    expect(
      isThoughtProtocolNoise('{"type":"message","message":"Hello from lead"}')
    ).toBe(false);
  });

  it('returns false for text with teammate-message mixed with content', () => {
    expect(
      isThoughtProtocolNoise(
        'Starting work.\n<teammate-message teammate_id="a" color="" summary="">X</teammate-message>'
      )
    ).toBe(false);
  });
});

describe('isInboxNoiseMessage', () => {
  it('detects idle_notification', () => {
    expect(isInboxNoiseMessage('{"type":"idle_notification"}')).toBe(true);
  });

  it('does not flag regular JSON messages', () => {
    expect(isInboxNoiseMessage('{"type":"message","text":"hi"}')).toBe(false);
  });

  it('does not flag plain text', () => {
    expect(isInboxNoiseMessage('Hello world')).toBe(false);
  });
});
