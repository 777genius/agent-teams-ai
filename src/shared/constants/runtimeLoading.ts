/** Cold startup/catalog work shares this allowance in the runtime. */
export const OPENCODE_LOADING_TIMEOUT_MS = 3 * 60_000;

// Scoped provider catalogs already have a four-minute lease. The desktop must
// preserve that allowance and leave time for the runtime's owned cleanup.
export const PROVIDER_CLI_TIMEOUT_MS = Math.max(OPENCODE_LOADING_TIMEOUT_MS, 4 * 60_000) + 60_000;
export const PROVIDER_UI_TIMEOUT_MS = PROVIDER_CLI_TIMEOUT_MS + 30_000;
