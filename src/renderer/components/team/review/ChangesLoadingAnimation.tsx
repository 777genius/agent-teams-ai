import { useEffect, useState } from 'react';
import { FileCode, FileDiff, FileText, GitBranch, GitCommit, RefreshCw } from 'lucide-react';

const orbitIcons = [
  { Icon: FileText, orbitRadius: 52, speed: 12, startAngle: 0, size: 15 },
  { Icon: FileDiff, orbitRadius: 52, speed: 12, startAngle: 72, size: 14 },
  { Icon: FileCode, orbitRadius: 52, speed: 12, startAngle: 144, size: 15 },
  { Icon: GitCommit, orbitRadius: 52, speed: 12, startAngle: 216, size: 13 },
  { Icon: GitBranch, orbitRadius: 52, speed: 12, startAngle: 288, size: 14 },
];

const particles = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  delay: i * 0.6,
  duration: 3 + (i % 3) * 0.8,
  startAngle: i * 45,
  radius: 34 + (i % 3) * 14,
}));

const messages = ['Analyzing files…', 'Computing diffs…', 'Loading changes…', 'Resolving hunks…'];

export const ChangesLoadingAnimation = (): React.JSX.Element => {
  const [msgIndex, setMsgIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsFading(true);
      setTimeout(() => {
        setMsgIndex((prev) => (prev + 1) % messages.length);
        setIsFading(false);
      }, 300);
    }, 2400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex w-full flex-col items-center justify-center gap-5">
      {/* Main animation container */}
      <div className="relative flex size-36 items-center justify-center">
        {/* Outer rotating ring */}
        <svg className="changes-orbit-ring absolute size-36" viewBox="0 0 144 144">
          <circle
            cx="72"
            cy="72"
            r="52"
            fill="none"
            stroke="var(--color-border-emphasis)"
            strokeWidth="1"
            strokeDasharray="6 8"
            opacity="0.5"
          />
        </svg>

        {/* Inner rotating ring (counter) */}
        <svg className="changes-orbit-ring-reverse absolute size-28" viewBox="0 0 112 112">
          <circle
            cx="56"
            cy="56"
            r="34"
            fill="none"
            stroke="var(--color-border-emphasis)"
            strokeWidth="0.5"
            strokeDasharray="3 6"
            opacity="0.3"
          />
        </svg>

        {/* Particles on inner orbit */}
        {particles.map((p) => (
          <div
            key={p.id}
            className="absolute left-1/2 top-1/2 size-1 rounded-full bg-[var(--color-text-muted)]"
            style={
              {
                animation: `changesParticle ${p.duration}s linear infinite ${p.delay}s`,
                '--particle-radius': `${p.radius}px`,
                '--particle-start': `${p.startAngle}deg`,
                opacity: 0,
              } as React.CSSProperties
            }
          />
        ))}

        {/* Orbiting icons */}
        {orbitIcons.map(({ Icon, orbitRadius, speed, startAngle, size }, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2"
            style={
              {
                animation: `changesOrbit ${speed}s linear infinite`,
                '--orbit-radius': `${orbitRadius}px`,
                '--start-angle': `${startAngle}deg`,
              } as React.CSSProperties
            }
          >
            <div
              className="changes-orbit-icon-inner text-[var(--color-text-muted)]"
              style={
                {
                  animation: `changesOrbitCounter ${speed}s linear infinite`,
                  '--start-angle': `${startAngle}deg`,
                } as React.CSSProperties
              }
            >
              <Icon size={size} strokeWidth={1.5} />
            </div>
          </div>
        ))}

        {/* Glow pulse behind center */}
        <div className="changes-glow-pulse absolute size-14 rounded-2xl bg-[var(--color-text-muted)] opacity-[0.06]" />
        <div
          className="absolute size-16 rounded-2xl bg-[var(--color-text-muted)] opacity-[0.03]"
          style={{ animation: 'changesGlowPulse 3s ease-in-out infinite 0.5s' }}
        />

        {/* Center icon block */}
        <div className="changes-center-morph relative z-10 flex size-11 items-center justify-center rounded-xl border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)]">
          <RefreshCw size={20} className="changes-center-spin text-[var(--color-text-secondary)]" />
        </div>

        {/* Scanning beam */}
        <div className="absolute inset-0 overflow-hidden rounded-full">
          <div className="changes-scan-beam absolute left-0 top-1/2 h-px w-full bg-gradient-to-r from-transparent via-[var(--color-text-muted)] to-transparent opacity-20" />
        </div>
      </div>

      {/* Segmented progress */}
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-0.5 w-8 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
          >
            <div
              className="h-full rounded-full bg-[var(--color-text-muted)]"
              style={{
                animation: `changesSegment 2.5s ease-in-out infinite ${i * 0.3}s`,
              }}
            />
          </div>
        ))}
      </div>

      {/* Rotating message */}
      <p
        className="h-4 text-xs font-medium tracking-wide text-[var(--color-text-muted)] transition-opacity duration-300"
        style={{ opacity: isFading ? 0 : 0.8 }}
      >
        {messages[msgIndex]}
      </p>

      <style>{`
        .changes-orbit-ring {
          animation: changesRingSpin 20s linear infinite;
        }
        .changes-orbit-ring-reverse {
          animation: changesRingSpin 15s linear infinite reverse;
        }
        .changes-glow-pulse {
          animation: changesGlowPulse 3s ease-in-out infinite;
        }
        .changes-center-morph {
          animation: changesCenterMorph 4s ease-in-out infinite;
        }
        .changes-center-spin {
          animation: changesCenterSpin 3s linear infinite;
        }
        .changes-scan-beam {
          animation: changesScan 3s ease-in-out infinite;
        }
        .changes-orbit-icon-inner {
          opacity: 0.45;
          transition: opacity 0.3s;
        }

        @keyframes changesRingSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes changesOrbit {
          from {
            transform: translate(-50%, -50%) rotate(var(--start-angle)) translateX(var(--orbit-radius)) rotate(calc(-1 * var(--start-angle)));
          }
          to {
            transform: translate(-50%, -50%) rotate(calc(var(--start-angle) + 360deg)) translateX(var(--orbit-radius)) rotate(calc(-1 * var(--start-angle) - 360deg));
          }
        }

        @keyframes changesOrbitCounter {
          from { transform: rotate(var(--start-angle)); }
          to { transform: rotate(calc(var(--start-angle) + 360deg)); }
        }

        @keyframes changesParticle {
          0% {
            transform: translate(-50%, -50%) rotate(var(--particle-start)) translateX(var(--particle-radius));
            opacity: 0;
          }
          15% { opacity: 0.6; }
          85% { opacity: 0.6; }
          100% {
            transform: translate(-50%, -50%) rotate(calc(var(--particle-start) + 360deg)) translateX(var(--particle-radius));
            opacity: 0;
          }
        }

        @keyframes changesGlowPulse {
          0%, 100% { transform: scale(1); opacity: 0.06; }
          50% { transform: scale(1.2); opacity: 0.1; }
        }

        @keyframes changesCenterMorph {
          0%, 100% { transform: scale(1); border-radius: 12px; }
          25% { transform: scale(1.05); border-radius: 14px; }
          50% { transform: scale(1); border-radius: 16px; }
          75% { transform: scale(1.05); border-radius: 12px; }
        }

        @keyframes changesCenterSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes changesScan {
          0% { transform: translateY(-70px) rotate(0deg); opacity: 0; }
          10% { opacity: 0.2; }
          50% { transform: translateY(0px) rotate(3deg); opacity: 0.3; }
          90% { opacity: 0.2; }
          100% { transform: translateY(70px) rotate(-3deg); opacity: 0; }
        }

        @keyframes changesSegment {
          0%, 100% { width: 0%; opacity: 0.3; }
          40% { width: 100%; opacity: 1; }
          60% { width: 100%; opacity: 1; }
          80% { width: 0%; opacity: 0.3; }
        }
      `}</style>
    </div>
  );
};
