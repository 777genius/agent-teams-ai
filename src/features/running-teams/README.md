# Running teams

- `renderer/index.ts` exports the existing Desktop composition. It reads the Desktop store and alive-team port through `useRunningTeamsSection`.
- `renderer/hosted.ts` exports the props-only, browser-safe `RunningTeamsSectionView`. Callers supply scoped opaque row keys, read state, labels, and navigation. It performs no source read or navigation itself.
- Missing task counts mean unknown. A `running_unknown` row shows its label without an activity pulse. The source adapter and ranking policy are separate from the view.
