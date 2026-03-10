import { Ban, ImagePlus } from 'lucide-react';

interface DropZoneOverlayProps {
  active: boolean;
  /** Show a "rejected" variant when images can't be sent to this recipient. */
  rejected?: boolean;
}

export const DropZoneOverlay = ({
  active,
  rejected,
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
          <span className="text-xs font-medium">Images can only be sent to the team lead</span>
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
        <ImagePlus size={24} />
        <span className="text-xs font-medium">Drop images here</span>
      </div>
    </div>
  );
};
