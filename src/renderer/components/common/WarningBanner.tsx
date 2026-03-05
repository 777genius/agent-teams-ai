import { AlertTriangle } from 'lucide-react';

interface WarningBannerProps {
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}

export const WarningBanner = ({
  children,
  className = '',
  icon,
}: WarningBannerProps): React.JSX.Element => (
  <div
    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${className}`}
    style={{
      backgroundColor: 'var(--warning-bg)',
      borderColor: 'var(--warning-border)',
      color: 'var(--warning-text)',
    }}
  >
    {icon ?? <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);
