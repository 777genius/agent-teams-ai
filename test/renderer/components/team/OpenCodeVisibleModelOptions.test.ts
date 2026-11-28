import { selectVisibleOpenCodeModelOptions } from '@renderer/components/team/dialogs/openCodeVisibleModelOptions';
import { describe, expect, it } from 'vitest';

type Candidate = Parameters<typeof selectVisibleOpenCodeModelOptions>[0]['metadata'][number];

function candidate(
  value: string,
  index: number,
  flags: Partial<Pick<Candidate, 'isFree' | 'isNew'>> = {}
): Candidate {
  return {
    option: { value, label: value || 'Default' },
    index,
    catalogModel: null,
    sourceInfo: { id: 'openrouter' },
    routeTag: null,
    searchText: value,
    isRecommended: false,
    isFree: false,
    isNew: false,
    ...flags,
  };
}

const metadata = [
  candidate('openrouter/mistralai/codestral-2508', 0),
  candidate('openrouter/example/unverified-3000', 1),
  candidate('openrouter/example/new-2', 2, { isNew: true }),
  candidate('openrouter/example/free-1:free', 3, { isFree: true }),
  candidate('openrouter/example/free-2:free', 4, { isFree: true, isNew: true }),
  candidate('', 5),
];

const input = {
  metadata,
  modelQuery: '',
  recommendedOnly: false,
  freeOnly: false,
  newOnly: false,
  selectedRouteTags: new Set<string>(),
  selectedSourceIds: new Set<string>(),
  value: '',
  defaultModel: 'openrouter/mistralai/codestral-2508',
  defaultUnavailable: false,
};

describe('OpenCode model ordering', () => {
  it('puts free before new and leaves Tested models in the ordinary freshness order', () => {
    expect(selectVisibleOpenCodeModelOptions(input).map(({ option }) => option.value)).toEqual([
      '',
      'openrouter/example/free-2:free',
      'openrouter/example/free-1:free',
      'openrouter/example/new-2',
      'openrouter/example/unverified-3000',
      'openrouter/mistralai/codestral-2508',
    ]);
  });

  it('keeps the free/new intersection and explicit recommendation filtering intact', () => {
    expect(
      selectVisibleOpenCodeModelOptions({
        ...input,
        freeOnly: true,
        newOnly: true,
        value: 'openrouter/example/free-2:free',
      }).map(({ option }) => option.value)
    ).toEqual(['openrouter/example/free-2:free']);

    expect(
      selectVisibleOpenCodeModelOptions({
        ...input,
        metadata: metadata.map((model) => ({
          ...model,
          isRecommended: model.option.value === 'openrouter/mistralai/codestral-2508',
        })),
        recommendedOnly: true,
        value: 'openrouter/mistralai/codestral-2508',
      }).map(({ option }) => option.value)
    ).toEqual(['', 'openrouter/mistralai/codestral-2508']);
  });
});
