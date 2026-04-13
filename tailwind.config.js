/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/renderer/index.html',
    './src/renderer/**/*.{js,ts,jsx,tsx}',
    './src/shared/**/*.{js,ts,jsx,tsx}',
    './packages/agent-graph/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Theme-aware surface colors (use CSS variables)
        surface: {
          DEFAULT: 'var(--color-surface)',
          raised: 'var(--color-surface-raised)',
          overlay: 'var(--color-surface-overlay)',
          sidebar: 'var(--color-surface-sidebar)',
          code: 'var(--code-bg)',  // Deep black for code blocks
        },
        // Theme-aware border colors (use CSS variables)
        border: {
          DEFAULT: 'var(--color-border)',
          subtle: 'var(--color-border-subtle)',
          emphasis: 'var(--color-border-emphasis)',
        },
        // Theme-aware accent color
        accent: 'var(--color-accent)',
        // Theme-aware text colors (use CSS variables)
        text: {
          DEFAULT: 'var(--color-text)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        // Semantic colors (only for status, not containers)
        semantic: {
          success: '#22c55e',  // green-500
          error: '#ef4444',    // red-500
          warning: '#f59e0b',  // amber-500
          info: '#3b82f6',     // blue-500
        },
        // Theme-aware info color (use for blue informational elements)
        info: {
          DEFAULT: 'var(--info-text)',
          bg: 'var(--info-bg)',
          border: 'var(--info-border)',
        },
        // Theme-aware colors using CSS variables
        // These aliases enable all existing components to automatically support light/dark mode
        'claude-dark': {
          bg: 'var(--color-surface)',
          surface: 'var(--color-surface-raised)',
          border: 'var(--color-border)',
          text: 'var(--color-text)',
          'text-secondary': 'var(--color-text-secondary)'
        }
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('tailwindcss-animate')
  ]
}
