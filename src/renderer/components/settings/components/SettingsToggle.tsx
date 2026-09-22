/**
 * SettingsToggle - Toggle switch component for boolean settings.
 * Linear-style design with white thumb and focus ring.
 */

interface SettingsToggleProps {
  readonly enabled: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}

export const SettingsToggle = ({
  enabled,
  onChange,
  disabled = false,
}: SettingsToggleProps): React.JSX.Element => {
  const handleClick = (): void => {
    if (!disabled) {
      onChange(!enabled);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={handleClick}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-[#141416]"
      style={{
        backgroundColor: enabled ? '#6366f1' : '#3f3f46',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        className="pointer-events-none inline-block size-4 rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
        style={{
          transform: enabled ? 'translateX(1rem)' : 'translateX(0)',
        }}
      />
    </button>
  );
};
