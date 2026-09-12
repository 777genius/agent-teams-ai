import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';

import {
  createEmptyHostedRosterLane,
  createEmptyHostedRosterMember,
  effortLevelsForHostedProvider,
  type HostedInitialRosterDraft,
  type HostedRosterLaneDraft,
  type HostedRosterMemberDraft,
} from '../view-models/hostedInitialRoster';

import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface HostedInitialRosterEditorProps {
  readonly value: HostedInitialRosterDraft;
  readonly onChange?: (value: HostedInitialRosterDraft) => void;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly errors?: readonly string[];
}

const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'anthropic' as const, label: 'Claude / Anthropic' }),
  Object.freeze({ id: 'codex' as const, label: 'Codex' }),
  Object.freeze({ id: 'gemini' as const, label: 'Gemini' }),
  Object.freeze({ id: 'opencode' as const, label: 'OpenCode' }),
]);

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return Object.freeze(
    values.map((current, currentIndex) => (currentIndex === index ? value : current))
  );
}

function move<T>(values: readonly T[], index: number, offset: -1 | 1): readonly T[] {
  const target = index + offset;
  if (target < 0 || target >= values.length) return values;
  const next = [...values];
  [next[index], next[target]] = [next[target], next[index]];
  return Object.freeze(next);
}

function removeAt<T>(values: readonly T[], index: number): readonly T[] {
  return Object.freeze(values.filter((_value, currentIndex) => currentIndex !== index));
}

function providerLabel(provider: TeamProviderId): string {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
}

function optionalEffort(value: string): EffortLevel | '' {
  return value === '__default__' ? '' : (value as EffortLevel);
}

export const HostedInitialRosterEditor = ({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  errors = [],
}: HostedInitialRosterEditorProps): React.JSX.Element => {
  const locked = disabled || readOnly;
  const memberCount = value.lanes.reduce((total, lane) => total + lane.members.length, 0);
  const emit = (lanes: readonly HostedRosterLaneDraft[]): void =>
    onChange?.(Object.freeze({ lanes: Object.freeze(lanes) }));
  const updateLane = (laneIndex: number, lane: HostedRosterLaneDraft): void =>
    emit(replaceAt(value.lanes, laneIndex, Object.freeze(lane)));
  const updateMember = (
    laneIndex: number,
    memberIndex: number,
    member: HostedRosterMemberDraft
  ): void => {
    const lane = value.lanes[laneIndex];
    if (!lane) return;
    updateLane(laneIndex, {
      ...lane,
      members: replaceAt(lane.members, memberIndex, Object.freeze(member)),
    });
  };

  return (
    <section aria-labelledby="hosted-initial-roster-heading" className="space-y-3">
      <div>
        <h3 id="hosted-initial-roster-heading" className="text-sm font-semibold">
          Initial roster
        </h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Lane and member order is preserved. Runtime selections are validated before save;
          availability is checked separately before launch.
        </p>
      </div>

      {value.lanes.map((lane, laneIndex) => {
        const lanePrefix = `hosted-roster-${lane.id}`;
        return (
          <fieldset
            key={lane.id}
            className="space-y-3 rounded-md border border-[var(--color-border)] p-3"
          >
            <legend className="px-1 text-sm font-medium">
              Lane {laneIndex + 1}: {providerLabel(lane.provider)}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${lanePrefix}-runtime`}>Runtime / provider</Label>
                <Select
                  value={lane.provider}
                  disabled={locked}
                  onValueChange={(provider) =>
                    updateLane(laneIndex, {
                      ...lane,
                      provider: provider as TeamProviderId,
                    })
                  }
                >
                  <SelectTrigger
                    id={`${lanePrefix}-runtime`}
                    aria-label={`Lane ${laneIndex + 1} runtime`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {lane.provider === 'opencode' ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${lanePrefix}-model`}>OpenCode provider-qualified model</Label>
                  <Input
                    id={`${lanePrefix}-model`}
                    aria-label={`Lane ${laneIndex + 1} OpenCode model`}
                    value={lane.selectedModel}
                    maxLength={256}
                    disabled={disabled}
                    readOnly={readOnly}
                    placeholder="provider/model"
                    onChange={(event) =>
                      updateLane(laneIndex, { ...lane, selectedModel: event.target.value })
                    }
                  />
                </div>
              ) : null}
              {lane.provider === 'opencode' ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${lanePrefix}-effort`}>Lane effort (optional)</Label>
                  <Select
                    value={lane.effort || '__default__'}
                    disabled={locked}
                    onValueChange={(effort) =>
                      updateLane(laneIndex, { ...lane, effort: optionalEffort(effort) })
                    }
                  >
                    <SelectTrigger
                      id={`${lanePrefix}-effort`}
                      aria-label={`Lane ${laneIndex + 1} effort`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Not specified</SelectItem>
                      {effortLevelsForHostedProvider(lane.provider).map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            <div className="space-y-3">
              {lane.members.map((member, memberIndex) => {
                const memberPrefix = `${lanePrefix}-${member.id}`;
                return (
                  <fieldset
                    key={member.id}
                    className="space-y-2 rounded border border-[var(--color-border)] p-3"
                  >
                    <legend className="px-1 text-xs font-medium">Member {memberIndex + 1}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${memberPrefix}-name`}>Member name</Label>
                        <Input
                          id={`${memberPrefix}-name`}
                          aria-label={`Lane ${laneIndex + 1} member ${memberIndex + 1} name`}
                          value={member.name}
                          maxLength={64}
                          disabled={disabled}
                          readOnly={readOnly}
                          onChange={(event) =>
                            updateMember(laneIndex, memberIndex, {
                              ...member,
                              name: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${memberPrefix}-model`}>
                          {lane.provider === 'opencode'
                            ? 'Provider-qualified model (optional override)'
                            : 'Model'}
                        </Label>
                        <Input
                          id={`${memberPrefix}-model`}
                          aria-label={`Lane ${laneIndex + 1} member ${memberIndex + 1} model`}
                          value={member.model}
                          maxLength={256}
                          disabled={disabled}
                          readOnly={readOnly}
                          onChange={(event) =>
                            updateMember(laneIndex, memberIndex, {
                              ...member,
                              model: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor={`${memberPrefix}-prompt`}>Instructions</Label>
                        <Textarea
                          id={`${memberPrefix}-prompt`}
                          aria-label={`Lane ${laneIndex + 1} member ${memberIndex + 1} instructions`}
                          value={member.prompt}
                          maxLength={64 * 1024}
                          disabled={disabled}
                          readOnly={readOnly}
                          onChange={(event) =>
                            updateMember(laneIndex, memberIndex, {
                              ...member,
                              prompt: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${memberPrefix}-effort`}>Effort (optional)</Label>
                        <Select
                          value={member.effort || '__default__'}
                          disabled={locked}
                          onValueChange={(effort) =>
                            updateMember(laneIndex, memberIndex, {
                              ...member,
                              effort: optionalEffort(effort),
                            })
                          }
                        >
                          <SelectTrigger
                            id={`${memberPrefix}-effort`}
                            aria-label={`Lane ${laneIndex + 1} member ${memberIndex + 1} effort`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__default__">Not specified</SelectItem>
                            {effortLevelsForHostedProvider(lane.provider).map((effort) => (
                              <SelectItem key={effort} value={effort}>
                                {effort}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {readOnly ? null : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Move member ${memberIndex + 1} up in lane ${laneIndex + 1}`}
                          disabled={disabled || memberIndex === 0}
                          onClick={() =>
                            updateLane(laneIndex, {
                              ...lane,
                              members: move(lane.members, memberIndex, -1),
                            })
                          }
                        >
                          Move member up
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Move member ${memberIndex + 1} down in lane ${laneIndex + 1}`}
                          disabled={disabled || memberIndex === lane.members.length - 1}
                          onClick={() =>
                            updateLane(laneIndex, {
                              ...lane,
                              members: move(lane.members, memberIndex, 1),
                            })
                          }
                        >
                          Move member down
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Remove member ${memberIndex + 1} from lane ${laneIndex + 1}`}
                          disabled={disabled}
                          onClick={() =>
                            updateLane(laneIndex, {
                              ...lane,
                              members: removeAt(lane.members, memberIndex),
                            })
                          }
                        >
                          Remove member
                        </Button>
                      </div>
                    )}
                  </fieldset>
                );
              })}
            </div>

            {readOnly ? null : (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Add member to lane ${laneIndex + 1}`}
                  disabled={disabled || memberCount >= 32}
                  onClick={() =>
                    updateLane(laneIndex, {
                      ...lane,
                      members: Object.freeze([...lane.members, createEmptyHostedRosterMember()]),
                    })
                  }
                >
                  Add member
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Move lane ${laneIndex + 1} up`}
                  disabled={disabled || laneIndex === 0}
                  onClick={() => emit(move(value.lanes, laneIndex, -1))}
                >
                  Move lane up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Move lane ${laneIndex + 1} down`}
                  disabled={disabled || laneIndex === value.lanes.length - 1}
                  onClick={() => emit(move(value.lanes, laneIndex, 1))}
                >
                  Move lane down
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Remove lane ${laneIndex + 1}`}
                  disabled={disabled}
                  onClick={() => emit(removeAt(value.lanes, laneIndex))}
                >
                  Remove lane
                </Button>
              </div>
            )}
          </fieldset>
        );
      })}

      {readOnly ? null : (
        <div className="flex flex-wrap gap-2" aria-label="Add runtime lane">
          {PROVIDERS.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || value.lanes.length >= 32 || memberCount >= 32}
              onClick={() => emit([...value.lanes, createEmptyHostedRosterLane(provider.id)])}
            >
              Add {provider.label} lane
            </Button>
          ))}
        </div>
      )}

      {errors.length > 0 ? (
        <div role="alert" className="space-y-1 text-sm">
          <p>The initial roster is incomplete:</p>
          <ul className="list-disc pl-5">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};
