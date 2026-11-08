// Observe the entry import before main.tsx or any of its dependencies evaluate.
const bootstrap: NonNullable<Window['__claudeTeamsRendererBootstrap']> = {
  importState: 'pending',
  mainPhase: null,
  errorClass: null,
};
window.__claudeTeamsRendererBootstrap = bootstrap;
import('./main.tsx').then(
  () => {
    bootstrap.importState = 'resolved';
  },
  (error: unknown) => {
    bootstrap.importState = 'rejected';
    let errorClass = 'other';
    try {
      const name: unknown =
        Object.getOwnPropertyDescriptor(error, 'name')?.value ??
        (error as { name?: unknown } | null | undefined)?.name;
      const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value;
      errorClass =
        typeof message === 'string' && message.includes('does not provide an export named')
          ? 'module-export'
          : typeof message === 'string' &&
              /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/.test(
                message
              )
            ? 'module-fetch'
            : typeof name === 'string' &&
                ['SyntaxError', 'ReferenceError', 'TypeError'].includes(name)
              ? name
              : 'other';
    } catch {
      /* Diagnostic inspection must preserve the original import rejection. */
    }
    bootstrap.errorClass = errorClass;
    throw error;
  }
);

export {};
