interface ReviewBadgeProps {
  status?: 'pending' | 'error';
}

export const ReviewBadge = ({ status = 'pending' }: ReviewBadgeProps): React.JSX.Element => {
  const isError = status === 'error';

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
        isError ? 'bg-red-500/15 text-red-300' : 'bg-yellow-500/15 text-yellow-300'
      }`}
    >
      {isError ? 'Review: Error' : 'Review: Pending'}
    </span>
  );
};
