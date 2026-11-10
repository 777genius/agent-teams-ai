/** Inference plans only. Every message is executed by the actual native MCP client. */
export type PeerActor = 'alice' | 'bob' | 'carol';
const actors: PeerActor[] = ['alice', 'bob', 'carol'];
const prefixes = { alice: 'NATIVE', bob: 'CODEX', carol: 'OPENCODE' };
export interface PeerAction {
  name: string;
  input: Record<string, unknown>;
}

export function nativePeerTurn(text: string, actor: PeerActor): string | undefined {
  const choices = [
    'SEND',
    ...actors.filter((name) => name !== actor).map((name) => 'FROM_' + name.toUpperCase()),
    ...actors.filter((name) => name !== actor).map((name) => 'ACK_FROM_' + name.toUpperCase()),
  ];
  return new RegExp(`${prefixes[actor]}_PEER_(${choices.join('|')})(?![A-Z_])`).exec(text)?.[0];
}

export function nativePeerActions(turn: string, actor: PeerActor): PeerAction[] | undefined {
  if (!turn.startsWith(prefixes[actor] + '_PEER_')) return undefined;
  if (turn.startsWith(prefixes[actor] + '_PEER_ACK_FROM_')) return [];
  const send = (id: string, to: string, text: string): PeerAction => ({
    name: 'message_send',
    input: { commandId: 'TEST-native-peer-' + id, to, text },
  });
  if (turn.endsWith('_SEND'))
    return [
      ...actors
        .filter((name) => name !== actor)
        .map((to) =>
          send(`${actor}-to-${to}`, to, `${prefixes[to]}_PEER_FROM_${actor.toUpperCase()}`)
        ),
      send(actor + '-sent', 'user', 'PEER_SENT_' + actor.toUpperCase()),
    ];
  const source = actors.find((name) => turn.endsWith('_FROM_' + name.toUpperCase()));
  if (!source || source === actor) throw new Error('Invalid TEST peer turn');
  return [
    send(
      `${actor}-from-${source}-ack`,
      source,
      `${prefixes[source]}_PEER_ACK_FROM_${actor.toUpperCase()}`
    ),
  ];
}
