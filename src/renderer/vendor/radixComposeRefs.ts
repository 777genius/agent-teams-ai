import * as React from 'react';

type PossibleRef<T> = React.Ref<T> | undefined;

function setRef<T>(ref: PossibleRef<T>, value: T | null): void | (() => void) {
  if (typeof ref === 'function') {
    return ref(value);
  }

  if (ref !== null && ref !== undefined) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

export function composeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  return (node) => {
    let hasCleanup = false;
    const cleanups = refs.map((ref) => {
      const cleanup = setRef(ref, node);
      if (!hasCleanup && typeof cleanup === 'function') {
        hasCleanup = true;
      }
      return cleanup;
    });

    if (hasCleanup) {
      return () => {
        for (let index = 0; index < cleanups.length; index += 1) {
          const cleanup = cleanups[index];
          if (typeof cleanup === 'function') {
            cleanup();
          } else {
            setRef(refs[index], null);
          }
        }
      };
    }

    return undefined;
  };
}

export function useComposedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  // This file is aliased over @radix-ui/react-compose-refs, so Radix imports this
  // export directly even though local source code does not reference it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Radix expects refs to be the dependency list.
  return React.useCallback(composeRefs(...refs), refs);
}
