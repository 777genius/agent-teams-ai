import { Ban, Paperclip } from 'lucide-react';

interface DropZoneOverlayProps {
  active: boolean;
  /** Show a "rejected" variant when files can't be sent to this recipient. */
  rejected?: boolean;
  /** Custom rejection message. Defaults to generic restriction text. */
  rejectionReason?: string;
}

export const DropZoneOverlay = ({
  active,
  rejected,
  rejectionReason,
}: DropZoneOverlayProps): React.JSX.Element | null => {
  if (!active) return null;

  if (rejected) {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed backdrop-blur-[1px]"
        style={{
          borderColor: '#ef4444',
          backgroundColor: 'color-mix(in srgb, #ef4444 10%, transparent)',
        }}
      >
        <div className="flex flex-col items-center gap-1.5 text-red-400">
          <Ban size={24} />
          <span className="text-xs font-medium">
            {rejectionReason ?? 'Files can only be sent to the team lead'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed backdrop-blur-[1px]"
      style={{
        borderColor: 'var(--color-accent, #6366f1)',
        backgroundColor: 'color-mix(in srgb, var(--color-accent, #6366f1) 10%, transparent)',
      }}
    >
      <div
        className="flex flex-col items-center gap-1.5"
        style={{ color: 'var(--color-accent, #6366f1)' }}
      >
        <Paperclip size={24} />
        <span className="text-xs font-medium">Drop files here</span>
      </div>
    </div>
  );
};
