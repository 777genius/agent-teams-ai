export const TERMINAL_WORKSPACE_CONSOLE_CSS = `
          .agent-team-terminal-console::before {
            content: '';
            position: absolute;
            inset: calc(var(--agent-terminal-background-image-blur) * -1);
            z-index: 0;
            pointer-events: none;
            background-color: var(--agent-terminal-background-color);
            background-image:
              linear-gradient(
                rgba(3, 7, 12, var(--agent-terminal-image-dim-opacity)),
                rgba(3, 7, 12, var(--agent-terminal-image-dim-opacity))
              ),
              var(--agent-terminal-background-image);
            background-position: var(--agent-terminal-background-position);
            background-repeat: var(--agent-terminal-background-repeat);
            background-size: var(--agent-terminal-background-size);
            opacity: var(--agent-terminal-panel-opacity);
            backdrop-filter: blur(var(--agent-terminal-backdrop-blur));
            filter: blur(var(--agent-terminal-background-image-blur));
          }

          .agent-team-terminal-console > * {
            position: relative;
            z-index: 1;
          }

          .agent-team-terminal-console tp-terminal-screen::part(screen-chrome) {
            display: none;
          }

          .agent-team-terminal-console tp-terminal-screen::part(line-number) {
            display: none;
          }

          .agent-team-terminal-console tp-terminal-workspace {
            display: block;
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-workspace::part(body),
          .agent-team-terminal-console tp-terminal-workspace::part(content),
          .agent-team-terminal-console tp-terminal-workspace::part(operations-deck),
          .agent-team-terminal-console tp-terminal-workspace::part(terminal-column) {
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-workspace::part(terminal-column) {
            --tp-workspace-terminal-column-min-height: 0;
            height: 100%;
          }

          .agent-team-terminal-console tp-terminal-screen::part(screen),
          .agent-team-terminal-console tp-terminal-screen::part(screen-lines) {
            height: 100%;
            min-height: 0;
          }

          .agent-team-terminal-console tp-terminal-screen {
            display: block;
            height: 100%;
            min-height: 0;
            overflow: hidden;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen {
            --tp-terminal-screen-panel-padding: 0;
            --tp-terminal-screen-panel-padding-bottom: 0;
            --tp-terminal-screen-panel-shadow: none;
            --tp-terminal-history-font-size: var(--agent-terminal-font-size);
          }

          .agent-team-terminal-console tp-terminal-screen {
            --tp-terminal-history-font-size: var(--agent-terminal-font-size);
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(body),
          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(content),
          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-workspace::part(operations-deck) {
            gap: 0;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen::part(screen) {
            border: 0;
            background: transparent;
            box-shadow: none;
            backdrop-filter: none;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-screen::part(screen-lines) {
            border: 0;
            box-shadow: none;
            background: transparent;
            padding: 0;
            backdrop-filter: none;
          }

          .agent-team-terminal-console tp-terminal-command-dock {
            --tp-terminal-command-font-size: var(--agent-terminal-font-size);
            display: block;
            min-width: 0;
          }

          .agent-team-terminal-console tp-terminal-command-dock::part(command-dock) {
            padding-top: 0;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-command-dock::part(command-dock) {
            border: 0;
            background: transparent;
            padding: 0 1rem 0.25rem;
            backdrop-filter: none;
          }

          .agent-team-terminal-console[data-surface="sheet"] tp-terminal-command-dock::part(composer) {
            background: rgba(5, 8, 13, 0.24);
            border-color: rgba(125, 211, 252, 0.28);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
            backdrop-filter: blur(18px);
          }

          .agent-team-terminal-console tp-terminal-command-dock::part(status),
          .agent-team-terminal-console tp-terminal-command-dock::part(command-history),
          .agent-team-terminal-console tp-terminal-command-dock::part(session-actions),
          .agent-team-terminal-console tp-terminal-command-dock::part(terminal-accessories) {
            display: none;
          }
        `;
