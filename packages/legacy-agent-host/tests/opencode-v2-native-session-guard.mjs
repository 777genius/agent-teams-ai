// TEST-only native V2 readback boundary. The captured session must remain in
// the original isolated workspace with its exact ordered permission rules.
export function isOwnedNativeSessionSnapshot(reply, sessionId, directory, permissions) {
  const observed = reply?.data?.data;
  return reply?.status === 200 &&
    typeof sessionId === 'string' && sessionId.length > 0 &&
    typeof directory === 'string' && directory.length > 0 &&
    Array.isArray(permissions) && Array.isArray(observed?.permissions) &&
    observed.id === sessionId && observed.location?.directory === directory &&
    JSON.stringify(observed.permissions) === JSON.stringify(permissions);
}

/** Keep the exact native JSON variant; missing is not an attested null/default. */
export function nativeSessionModelVariant(model) {
  return model !== null && typeof model === 'object' && !Array.isArray(model) &&
    Object.hasOwn(model, 'variant') ? model.variant : undefined;
}
