import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemberDraftStatusNotices } from '@renderer/components/team/members/MemberDraftStatusNotices';
import { describe, expect, it } from 'vitest';

describe('MemberDraftStatusNotices', () => {
  it('announces blocking member incompatibility as an error', () => {
    const markup = renderToStaticMarkup(
      React.createElement(MemberDraftStatusNotices, {
        warningMessages: [],
        showSonnetExtraUsageWarning: false,
        errorText: 'OpenCode cannot be the team lead when mixing providers.',
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('var(--field-error-text)');
    expect(markup).toContain('OpenCode cannot be the team lead when mixing providers.');
    expect(markup).not.toContain('bg-amber');
  });
});
