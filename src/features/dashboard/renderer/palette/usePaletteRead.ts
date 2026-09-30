import { useEffect, useState } from 'react';

export interface PaletteReadResult<Row> {
  rows: readonly Row[];
  total: number;
  partial: boolean;
}

interface PaletteReadState<Row> extends PaletteReadResult<Row> {
  key: string;
  loading: boolean;
  error: boolean;
}

const emptyResult = <Row>(): PaletteReadResult<Row> => ({ rows: [], total: 0, partial: false });

/** A read belongs to one query/scope/open lifetime. Late results and errors cannot replace newer state. */
export function usePaletteRead<Row>(
  key: string,
  enabled: boolean,
  delayMs: number,
  load: (signal: AbortSignal) => Promise<PaletteReadResult<Row>>
): PaletteReadResult<Row> & { loading: boolean; error: boolean } {
  const [state, setState] = useState<PaletteReadState<Row>>({
    key,
    ...emptyResult<Row>(),
    loading: false,
    error: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, ...emptyResult<Row>(), loading: enabled, error: false });
    if (!enabled) return () => controller.abort();

    const timeout = setTimeout(() => {
      void load(controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) {
            setState({ key, ...result, loading: false, error: false });
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setState({ key, ...emptyResult<Row>(), loading: false, error: true });
          }
        }
      );
    }, delayMs);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [key, enabled, delayMs, load]);

  // The old rows are hidden during the render before the effect above runs.
  if (state.key !== key || !enabled) {
    return { ...emptyResult<Row>(), loading: enabled, error: false };
  }
  return state;
}
