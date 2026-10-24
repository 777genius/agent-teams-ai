const byteLengthGetter = (() => {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const getter = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get;
  if (!getter) throw new Error('Typed array byte length getter is unavailable');
  return getter;
})();

/** Read the actual byte view, independently of shadowed instance properties. */
export function intrinsicByteLength(data: Uint8Array): number {
  return Reflect.apply(byteLengthGetter, data, []) as number;
}
