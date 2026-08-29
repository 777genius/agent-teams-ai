export type MissingCompositionKey<Composition, Keys extends readonly PropertyKey[]> = Exclude<
  keyof Composition,
  Keys[number]
>;

export type DuplicateCompositionKey<
  Keys extends readonly PropertyKey[],
  Seen extends PropertyKey = never,
> = Keys extends readonly [
  infer Key extends PropertyKey,
  ...infer RemainingKeys extends readonly PropertyKey[],
]
  ? Key extends Seen
    ? Key
    : DuplicateCompositionKey<RemainingKeys, Seen | Key>
  : never;
