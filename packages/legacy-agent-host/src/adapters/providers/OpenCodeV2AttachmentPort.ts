import { isDeepStrictEqual } from 'node:util';
import type { MemberProviderContext } from './MemberProvider.js';

type AttachmentPort = NonNullable<MemberProviderContext['attachments']>;

/** Bridge stable V2 checkpoint authority to the exact live Host attachment claim. */
export function bindOpenCodeV2AttachmentPort(
  source: AttachmentPort,
  trustedBinding: string,
  hostBinding: string,
  isCurrent: () => boolean
): AttachmentPort {
  const model = source.model,
    revision = source.revision,
    mimeTypes = [...source.mimeTypes],
    resolve = source.resolve;
  return {
    model,
    revision,
    mimeTypes,
    async resolve(request, signal) {
      const guard = () => {
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('OpenCode V2 attachment authority revoked');
      };
      guard();
      const binding = structuredClone(request);
      if (binding.trustedBinding !== trustedBinding) return undefined;
      const translated = structuredClone({ ...binding, trustedBinding: hostBinding });
      const expected = structuredClone(translated);
      guard();
      const value = await Reflect.apply(resolve, source, [translated, signal]);
      guard();
      if (!value) return undefined;
      const returnedBinding = value.binding,
        bytes = value.bytes,
        nativePath = value.nativePath;
      if (!isDeepStrictEqual(returnedBinding, expected)) return undefined;
      guard();
      return { binding, bytes, ...(nativePath === undefined ? {} : { nativePath }) };
    },
  };
}
