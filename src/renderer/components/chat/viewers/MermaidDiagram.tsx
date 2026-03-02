/**
 * Renders a Mermaid diagram from code string to SVG.
 *
 * Lazy-initializes mermaid once with dark theme.
 * Each render call uses a unique ID to avoid collisions.
 * SVG output is sanitized with DOMPurify before DOM insertion.
 * Falls back to raw code display on parse errors.
 */

import React, { useEffect, useRef, useState } from 'react';

import { PROSE_PRE_BG, PROSE_PRE_BORDER } from '@renderer/constants/cssVariables';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

// =============================================================================
// Mermaid initialization (once per app lifecycle)
// =============================================================================

let initialized = false;

function ensureMermaidInit(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: 'transparent',
      primaryColor: '#3b82f6',
      primaryTextColor: '#fafafa',
      primaryBorderColor: '#3b82f6',
      lineColor: '#71717a',
      secondaryColor: '#27272a',
      tertiaryColor: '#1f1f23',
    },
  });
  initialized = true;
}

// Monotonic counter for unique diagram IDs
let idCounter = 0;

// =============================================================================
// Component
// =============================================================================

interface MermaidDiagramProps {
  code: string;
}

export const MermaidDiagram = React.memo(function MermaidDiagram({
  code,
}: MermaidDiagramProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code.trim()) return;

    ensureMermaidInit();

    let cancelled = false;
    const diagramId = `mermaid-${++idCounter}`;

    mermaid
      .render(diagramId, code.trim())
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) {
          const sanitized = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
          containerRef.current.replaceChildren();
          containerRef.current.insertAdjacentHTML('afterbegin', sanitized);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div
        className="my-3 overflow-auto rounded-lg p-3 text-xs"
        style={{
          backgroundColor: PROSE_PRE_BG,
          border: `1px solid ${PROSE_PRE_BORDER}`,
        }}
      >
        <div className="mb-2 text-amber-400">Mermaid syntax error</div>
        <pre className="whitespace-pre-wrap font-mono text-text-muted">{code}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-3 flex justify-center overflow-auto rounded-lg p-3"
      style={{
        backgroundColor: PROSE_PRE_BG,
        border: `1px solid ${PROSE_PRE_BORDER}`,
      }}
    />
  );
});
