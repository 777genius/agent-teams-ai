import type { BackendTeamSnapshot } from '../../contracts/teamSnapshot';

type Message = BackendTeamSnapshot['messages'][number];

/** Both product snapshots and message history publish only complete original fields. */
export function assembleHostMessageParts(group: {
  total: number;
  values: Map<number, Message>;
}): Message {
  const base = group.values.get(0);
  if (
    !base ||
    group.values.size !== group.total ||
    typeof base.text !== 'string' ||
    (base.summary !== undefined && typeof base.summary !== 'string')
  )
    throw new Error('Incomplete Host message history');
  let text = base.text;
  let summary = base.summary;
  for (let part = 1; part < group.total; part++) {
    const value = group.values.get(part);
    if (
      !value ||
      value.from !== base.from ||
      value.messageId !== base.messageId ||
      value.timestamp !== base.timestamp ||
      value.read !== base.read ||
      value.source !== base.source ||
      value.leadSessionId !== base.leadSessionId ||
      typeof value.text !== 'string' ||
      (value.summary !== undefined && typeof value.summary !== 'string')
    )
      throw new Error('Mismatched Host message fragment');
    text += value.text;
    // Older text-only continuations omitted summary; retain their original base.
    if (value.summary !== undefined) {
      if (summary === undefined) throw new Error('Mismatched Host message summary');
      summary += value.summary;
    }
  }
  return { ...base, text, ...(summary === undefined ? {} : { summary }) };
}
