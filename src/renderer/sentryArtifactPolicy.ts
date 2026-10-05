import { APP_RELEASE, BUILD_GIT_SHA, BUILD_ID } from '@shared/utils/buildMetadata';
import {
  parseSentryArtifactInventory,
  SENTRY_INVENTORY_PAYLOAD_ID,
} from '@shared/utils/sentryArtifactInventory';
import {
  createSentryArtifactPolicy,
  type SentryArtifactPolicy,
} from '@shared/utils/sentryArtifactPolicy';

/** Only the producer's nonexecuting HTML payload and this owned document define renderer coverage. */
export function loadRendererSentryArtifactPolicy(): SentryArtifactPolicy | null {
  try {
    const payloads = document.querySelectorAll(`#${SENTRY_INVENTORY_PAYLOAD_ID}`);
    const payload = payloads[0];
    const suffix = 'out/renderer/index.html';
    const href = document.location.href;
    if (
      payloads.length !== 1 ||
      payload?.tagName !== 'SCRIPT' ||
      payload.getAttribute('type') !== 'application/json' ||
      !href.startsWith('file:///') ||
      !href.endsWith(suffix)
    )
      return null;
    const identity = { release: APP_RELEASE, buildId: BUILD_ID, gitSha: BUILD_GIT_SHA };
    const inventory = parseSentryArtifactInventory(payload.textContent ?? '', identity);
    if (
      !inventory ||
      inventory.coverage.renderer !== 'covered' ||
      inventory.artifacts.some((row) => row.target !== 'renderer')
    )
      return null;
    return createSentryArtifactPolicy([inventory], identity, {
      fileUrl: href.slice(0, -suffix.length),
      rawTargets: ['renderer'],
    });
  } catch {
    return null;
  }
}
