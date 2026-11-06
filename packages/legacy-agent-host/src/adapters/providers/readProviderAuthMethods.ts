import type { ProviderAuthenticationMethod } from '../../management/contracts.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid auth metadata');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\0'))
    throw new Error('Invalid auth metadata');
  return value;
};
const optionalText = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (value === '') return '';
  return text(value);
};

/** Project descriptive form metadata only; native auth/config extensions are never forwarded. */
export function readProviderAuthMethods(raw: unknown): ProviderAuthenticationMethod[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('Invalid auth metadata');
  return raw.flatMap((entry, methodIndex) => {
    const method = object(entry);
    if (method.type !== 'api' && method.type !== 'oauth') return [];
    const result: ProviderAuthenticationMethod = {
      methodIndex,
      type: method.type,
      label: text(method.label ?? (method.type === 'api' ? 'API key' : 'Browser sign-in')),
      supported: true,
      prompts: [],
    };
    try {
      const prompts = method.prompts ?? [];
      if (!Array.isArray(prompts) || prompts.length > 64) throw new Error('Unsupported prompts');
      result.prompts = prompts.map((rawPrompt): ProviderAuthenticationMethod['prompts'][number] => {
        const prompt = object(rawPrompt);
        if (prompt.type !== 'text' && prompt.type !== 'select')
          throw new Error('Unsupported prompt');
        const options = prompt.options ?? [];
        if (
          !Array.isArray(options) ||
          options.length > 256 ||
          (prompt.type === 'select' && !options.length)
        )
          throw new Error('Unsupported options');
        const when = prompt.when === undefined ? null : object(prompt.when);
        if (when && when.op !== 'eq' && when.op !== 'neq') throw new Error('Unsupported condition');
        return {
          key: text(prompt.key),
          type: prompt.type,
          label: text(prompt.message ?? prompt.key),
          placeholder: optionalText(prompt.placeholder),
          options: options.map((rawOption) => {
            const option = object(rawOption);
            return {
              label: text(option.label ?? option.value),
              value: text(option.value),
              hint: optionalText(option.hint),
            };
          }),
          when: when ? { key: text(when.key), op: text(when.op), value: text(when.value) } : null,
        };
      });
      if (new Set(result.prompts.map((prompt) => prompt.key)).size !== result.prompts.length)
        throw new Error('Duplicate prompts');
    } catch {
      // A new native prompt type must be explicitly supported before permitting that method.
      result.supported = false;
      result.prompts = [];
    }
    return [result];
  });
}
