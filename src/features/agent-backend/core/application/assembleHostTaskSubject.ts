export interface HostTaskSubjectFragment {
  total: number;
  subject: string;
}

/** A retained subject is reconstructed only from every ordered original fragment. */
export function assembleHostTaskSubject(parts: Map<number, HostTaskSubjectFragment>): string {
  const first = parts.get(0);
  if (!first || !Number.isSafeInteger(first.total) || first.total < 2 || parts.size !== first.total)
    throw new Error('Incomplete Host task subject');
  let subject = '';
  for (let part = 0; part < first.total; part++) {
    const value = parts.get(part);
    if (!value || value.total !== first.total || typeof value.subject !== 'string')
      throw new Error('Mismatched Host task subject');
    subject += value.subject;
  }
  return subject;
}
