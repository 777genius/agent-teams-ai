# Plan68 revision2: independent prospective R2

**ACCEPT — exact two-path prospective scope; no blocking finding.**

The approved document is SHA256 c859c7342a74681636c3d10ee39778a483d5272632c93c5b73d2f4120bd31422. Revision1 remains intact. Only one test paragraph changed to make the regression exercise actual provider-state memo recomputation.

The original typed-lint failure is concrete: Date.now executes inside the provider-state render memo. The selected layout effect performs the actual clock observation after commit, records it with the exact predicate identity, and lets render evaluate the original pure predicate using that snapshot. Loading and scoped-OpenCode precedence remain unchanged. A changed predicate must reject the old snapshot until the effect supplies the new one.

The existing Launch owner creates permits freshly on each parent render and already owns expiry+1 invalidation and timer cleanup. A local child state update does not change that parent prop, so the synchronization does not form a feedback loop. Action-time createLaunchGuard and captureForSubmit keep independent actual-time checks; display evidence grants no mutation authority.

The revised real-owner regression must force child memo recomputation with a fresh equivalent loading-map object while keeping the exact parent predicate identity. It observes timestamps through a wrapper that delegates to the actual predicate, separates guard calls, checks rejection at strict expiry before the timer runs, then observes invalidation from the original hook timer without a synthetic parent refresh. Existing API/logo mocks, all nine direct and three parameterized declarations, and every original assertion stay retained.

Both paths and direct dependencies are already original source pins and the two paths already have explicit lint admission. Current immutable ESLint config independently confirms set-state-in-effect is a warning. The bounded synchronization may retain that warning; no lint-policy change or warning-free result is claimed.

No afterimages or project/compiler/test/linter/provider/native/GUI execution, CI observation/action, or remote mutation were performed. Actual source and resulting-source validation remain separate gates. The exact current parent must be rebound before publication.
