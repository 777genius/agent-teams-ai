/** Scoped to the message cache so team metadata failures keep their own surface. */
export const MessageHistoryNotice = ({
  error,
}: {
  error?: string | null;
}): React.JSX.Element | null => {
  if (!error) return null;
  const message = error.startsWith('TEAM_HISTORY_UNAVAILABLE:')
    ? 'Could not load message history. Previously loaded messages are still available.'
    : error;
  return (
    <p role="status" className="px-3 py-1 text-xs text-amber-400">
      {message}
    </p>
  );
};
