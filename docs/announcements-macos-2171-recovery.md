# Temporary macOS 2.17.1 recovery announcement

The macOS 2.17.1 release cannot automatically update (reported by the owner). A temporary `macosManualUpdate2171Only: true` metadata flag targets exactly Electron `app.getVersion() === '2.17.1'` and `process.platform === 'darwin'`, for both Apple Silicon and Intel. Other versions, prereleases, platforms, and missing runtime identity are excluded. Omitted/false flags preserve ordinary news behavior. The flag is validated in the publisher and client, included in the feed revision, and immutable after publication. The disposable feed cache uses format version 2, rejecting old normalized feeds and their ETags because old clients stripped audience fields; read/dismissal state is unaffected. Filtering occurs in the main application service before list, automatic selection, manual document and cover access.

## Shipped-client limitation: publication is blocked

Inspection of `v2.17.1:src/features/announcements/core/domain/policy.ts` and `normalize.ts` shows that the shipped client has no runtime audience filter and drops unknown metadata. It will ignore this new flag. Deploying a flagged post in `feed.v1.json` can therefore expose it to other old clients too. Shipping filtering in a newer desktop release does not retrofit clients remaining on 2.17.1. The existing anonymous static feed carries no app-version/platform request identity for server targeting.

Do not publish this draft as an exclusively targeted recovery message until a delivery strategy for already installed clients has been established. If a broadly visible notice is chosen explicitly, describe its audience in the title/body and acknowledge that it is not strictly targeted. Do not assume a schema bump or unknown field hides a post from old clients.

## Prepared content, not in the publication catalog

The [draft](announcements-drafts/macos-2171-manual-update/body.md) and [metadata](announcements-drafts/macos-2171-manual-update/meta.json) live outside `landing/content/announcements`, so neither the landing build nor feed generation publishes them. `feed.config.json` remains unchanged. The draft is English, matching the single-language feed; title: **⚠️ macOS 2.17.1: manual update required**.

The first body line links directly to `https://agentteams.live/#download`, whose `download` anchor is owned by `landing/components/sections/DownloadSection.vue`. Do not promise that auto-update is fixed in the destination release until release verification proves it.

After resolving the delivery limitation and verifying a newer macOS release is downloadable, set the real publication timestamp and an explicit validity window, retain `minUsageMinutes: 0`, then copy the draft directory into the source catalog through the normal publishing workflow. Retain `showToNewUsers: true` because eligibility is based on installed version/platform, not profile age. Check global auto-display configuration separately; manual history is available independently. Keep the flag while affected clients remain; withdraw the post when recovery is over. Removal of the temporary implementation is a separate compatibility decision.
