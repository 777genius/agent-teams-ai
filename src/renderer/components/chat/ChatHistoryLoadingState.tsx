import type { JSX } from 'react';
/**
 * Loading skeleton for ChatHistory while conversation is loading.
 * Industrial shimmer with organic line widths — no generic pulse.
 */
export const ChatHistoryLoadingState = (): JSX.Element => {
  const rows = [
    { user: ['85%', '60%'], ai: ['92%', '70%', '82%', '45%'] },
    { user: ['75%', '92%', '40%'], ai: ['88%', '65%', '78%'] },
    { user: ['95%', '55%'], ai: ['72%', '85%', '60%', '92%', '35%'] },
  ];

  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden bg-surface">
      <div className="w-full max-w-5xl space-y-8 px-6">
        {rows.map((row, i) => (
          <div key={i} className="space-y-6">
            {/* User message skeleton — right aligned */}
            <div className="flex justify-end">
              <div className="w-2/3 space-y-2">
                {row.user.map((width, j) => (
                  <div
                    key={j}
                    className="skeleton-shimmer ml-auto h-3 rounded-sm"
                    style={{ width, backgroundColor: 'var(--skeleton-base)' }}
                  />
                ))}
              </div>
            </div>
            {/* AI response skeleton — left aligned with border accent */}
            <div className="space-y-2.5 border-l-2 border-border pl-3">
              {row.ai.map((width, j) => (
                <div
                  key={j}
                  className="skeleton-shimmer h-3 rounded-sm"
                  style={{ width, backgroundColor: 'var(--skeleton-base)' }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
