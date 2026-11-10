// The pinned SDK checks this flag before its development-only inspector auto-mount.
// Chat visualizations use no inspector or observability UI.
Reflect.set(globalThis, Symbol.for('openui.devtools.autoMount'), true);
