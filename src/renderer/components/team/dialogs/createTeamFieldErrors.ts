export interface CreateTeamFieldErrors {
  teamName?: string;
  members?: string;
  cwd?: string;
}

export function clearCreateTeamNameFieldError(errors: CreateTeamFieldErrors): {
  errors: CreateTeamFieldErrors;
  localError: string | null;
} {
  if (!errors.teamName) return { errors, localError: null };
  const remainingErrors = { ...errors };
  delete remainingErrors.teamName;
  const remainingMessages = Object.values(remainingErrors).filter(Boolean);
  return {
    errors: remainingErrors,
    localError: remainingMessages.length > 0 ? remainingMessages.join(' · ') : null,
  };
}
