import { useCallback, useEffect, useRef } from 'react';

/** Data attribute name used to store arbitrary string data on observed elements. */
const DATA_ATTR = 'data-viewport-value';

interface UseViewportObserverOptions {
  /**
   * Scrollable ancestor DOM element used as IntersectionObserver root.
   * Pass the actual element (not a RefObject) so that the hook can
   * react to the element becoming available (e.g. after a Dialog portal mounts).
   *
   * Use a callback-ref + useState pattern in the consumer:
   *   const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
   *   <DialogContent ref={setRootEl}>
   *   useViewportObserver({ root: rootEl, ... })
   */
  root?: HTMLElement | null;
  /** Visibility ratio threshold (0..1). Default: 0.1 (10% visible). */
  threshold?: number;
  /**
   * Called when the set of visible elements changes.
   * Receives the data-viewport-value strings of all currently intersecting elements.
   */
  onVisibleChange: (visibleValues: string[]) => void;
}

/**
 * Generic reusable hook for detecting which elements are visible in a
 * scrollable container using IntersectionObserver.
 *
 * Usage:
 * 1. Call the hook with a root element and a callback.
 * 2. Attach `registerElement(value)` as a ref callback on each element.
 *    `value` is an arbitrary string stored in a data attribute for identification.
 * 3. The callback fires with the list of currently visible values whenever
 *    the intersection state changes.
 *
 * Important: pass the root as a plain DOM element (not a RefObject) so the
 * hook can recreate the observer when the element becomes available.
 * Use `useState` + callback ref in the consumer for this.
 *
 * The hook manages a single IntersectionObserver instance and handles
 * element registration/deregistration automatically.
 */
export function useViewportObserver({
  root,
  threshold = 0.1,
  onVisibleChange,
}: UseViewportObserverOptions): {
  /** Ref callback factory. Attach the returned ref to an observed element. */
  registerElement: (value: string) => (el: HTMLElement | null) => void;
} {
  const onVisibleChangeRef = useRef(onVisibleChange);
  onVisibleChangeRef.current = onVisibleChange;

  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleValuesRef = useRef<Set<string>>(new Set());
  const elementsByValue = useRef<Map<string, HTMLElement>>(new Map());

  // Create / recreate observer when root element or threshold changes.
  // root is a plain DOM element (not a RefObject), so when the consumer
  // updates state (e.g. Dialog portal mounts), this effect re-runs and
  // creates an IO with the correct root.
  useEffect(() => {
    // When root is not yet available (e.g. portal not mounted), skip
    // creating the observer — it would default to document viewport
    // and produce false positives for all visible elements.
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const value = entry.target.getAttribute(DATA_ATTR);
          if (!value) continue;

          if (entry.isIntersecting) {
            if (!visibleValuesRef.current.has(value)) {
              visibleValuesRef.current.add(value);
              changed = true;
            }
          } else {
            if (visibleValuesRef.current.has(value)) {
              visibleValuesRef.current.delete(value);
              changed = true;
            }
          }
        }
        if (changed) {
          onVisibleChangeRef.current(Array.from(visibleValuesRef.current));
        }
      },
      { root, threshold }
    );

    // Re-observe elements that were registered before observer was created
    // (or after root changed).
    for (const [value, el] of elementsByValue.current) {
      el.setAttribute(DATA_ATTR, value);
      observer.observe(el);
    }

    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
      visibleValuesRef.current.clear();
    };
  }, [root, threshold]);

  const registerElement = useCallback((value: string) => {
    return (el: HTMLElement | null) => {
      // Cleanup previous element for this value
      const prev = elementsByValue.current.get(value);
      if (prev) {
        observerRef.current?.unobserve(prev);
        elementsByValue.current.delete(value);
        visibleValuesRef.current.delete(value);
      }

      // Register new element
      if (el) {
        el.setAttribute(DATA_ATTR, value);
        elementsByValue.current.set(value, el);
        observerRef.current?.observe(el);
      }
    };
  }, []);

  return { registerElement };
}
