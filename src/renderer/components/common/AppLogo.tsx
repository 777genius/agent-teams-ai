/**
 * AppLogo - Inline SVG of the app icon (three connected agent nodes).
 * Renders at the given size (default 20px) for use in headers/sidebars.
 */

interface AppLogoProps {
  size?: number;
  className?: string;
}

export const AppLogo = ({ size = 20, className }: AppLogoProps): React.JSX.Element => (
  <svg
    viewBox="0 0 56 56"
    width={size}
    height={size}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <rect width="56" height="56" rx="14" fill="#151620" />
    {/* Edges */}
    <line
      x1="19.5"
      y1="19"
      x2="36.5"
      y2="19"
      stroke="#818cf8"
      strokeWidth="1.8"
      strokeLinecap="round"
      opacity="0.4"
    />
    <line
      x1="36.5"
      y1="19"
      x2="28"
      y2="36.5"
      stroke="#a78bfa"
      strokeWidth="1.8"
      strokeLinecap="round"
      opacity="0.4"
    />
    <line
      x1="28"
      y1="36.5"
      x2="19.5"
      y2="19"
      stroke="#c084fc"
      strokeWidth="1.8"
      strokeLinecap="round"
      opacity="0.4"
    />
    {/* Nodes */}
    <circle cx="19.5" cy="19" r="5" fill="#818cf8" />
    <circle cx="36.5" cy="19" r="5" fill="#a78bfa" />
    <circle cx="28" cy="36.5" r="5.5" fill="#c084fc" />
    {/* Cores */}
    <circle cx="19.5" cy="19" r="2" fill="#e0e7ff" />
    <circle cx="36.5" cy="19" r="2" fill="#ede9fe" />
    <circle cx="28" cy="36.5" r="2.2" fill="#f3e8ff" />
  </svg>
);
