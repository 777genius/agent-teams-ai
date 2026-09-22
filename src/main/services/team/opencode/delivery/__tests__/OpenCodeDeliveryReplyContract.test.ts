import { describe, expect, it } from 'vitest';

import {
  classifyOpenCodeDeliveryReplyContract,
  isOpenCodeReplyOptionalDeliveryContract,
  OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT,
} from '../OpenCodeDeliveryReplyContract';

describe('classifyOpenCodeDeliveryReplyContract', () => {
  it('treats the user and missing recipients as user replies', () => {
    expect(classifyOpenCodeDeliveryReplyContract('user')).toBe('user_reply');
    expect(classifyOpenCodeDeliveryReplyContract(' User ')).toBe('user_reply');
    expect(classifyOpenCodeDeliveryReplyContract('')).toBe('user_reply');
    expect(classifyOpenCodeDeliveryReplyContract(undefined)).toBe('user_reply');
    expect(classifyOpenCodeDeliveryReplyContract(null)).toBe('user_reply');
  });

  it('treats the reserved system marker as informational', () => {
    expect(OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT).toBe('system');
    expect(classifyOpenCodeDeliveryReplyContract('system')).toBe('informational');
    expect(classifyOpenCodeDeliveryReplyContract('SYSTEM')).toBe('informational');
  });

  it('treats lead-style recipients as lead replies', () => {
    expect(classifyOpenCodeDeliveryReplyContract('team-lead')).toBe('lead_reply');
    expect(classifyOpenCodeDeliveryReplyContract('lead')).toBe('lead_reply');
    expect(classifyOpenCodeDeliveryReplyContract('orchestrator')).toBe('lead_reply');
  });

  it('treats every other addressable recipient as a teammate report', () => {
    expect(classifyOpenCodeDeliveryReplyContract('alice')).toBe('teammate_report');
    expect(classifyOpenCodeDeliveryReplyContract('reviewer')).toBe('teammate_report');
  });

  it('reports reply-optional contracts for informational notices and teammate reports only', () => {
    expect(isOpenCodeReplyOptionalDeliveryContract('system')).toBe(true);
    expect(isOpenCodeReplyOptionalDeliveryContract('alice')).toBe(true);
    expect(isOpenCodeReplyOptionalDeliveryContract('team-lead')).toBe(false);
    expect(isOpenCodeReplyOptionalDeliveryContract('user')).toBe(false);
    expect(isOpenCodeReplyOptionalDeliveryContract(undefined)).toBe(false);
  });
});
