/** Scoped to the message cache so team metadata failures keep their own surface. */
export const MessageHistoryNotice = ({
  error,
}: {
  error?: string | null;
}): React.JSX.Element | null => {
  if (!error) return null;
  return (
    <p role="status" className="px-3 py-1 text-xs text-amber-400">
      {error}
    </p>
  );
};
