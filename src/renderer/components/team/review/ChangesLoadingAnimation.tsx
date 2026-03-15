import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileCode, FileDiff, FileText, GitBranch, GitCommit, Search } from 'lucide-react';

/* ── Fake diff lines for the mini-terminal ─────────────────────────── */
const diffLines = [
  { type: '+', text: 'export function resolveHunk(ctx)' },
  { type: '-', text: 'const legacy = parseDiff(raw)' },
  { type: ' ', text: '  const chunks = split(input)' },
  { type: '+', text: '  return mergeResults(a, b)' },
  { type: '-', text: '  if (old) return fallback()' },
  { type: '+', text: 'interface DiffRange { start: number }' },
  { type: ' ', text: '  for (const h of hunks) {' },
  { type: '+', text: '    yield computeDelta(h)' },
  { type: '-', text: '    emit("change", raw)' },
  { type: ' ', text: '  const meta = getFileInfo(p)' },
  { type: '+', text: '  await writePatched(output)' },
  { type: '-', text: '  delete cache[staleKey]' },
  { type: '+', text: 'type HunkMeta = { offset: number }' },
  { type: ' ', text: '  return ctx.finalize()' },
  { type: '+', text: '  const diff = computeLineDiff(a, b)' },
  { type: '-', text: '  throw new Error("parse failed")' },
];

/* ── Phases ─────────────────────────────────────────────────────────── */
const phases = [
  { icon: Search, label: 'Scanning repository…', accent: 'rgba(147,197,253,0.7)' },
  { icon: FileDiff, label: 'Computing diffs…', accent: 'rgba(253,186,116,0.7)' },
  { icon: GitBranch, label: 'Resolving branches…', accent: 'rgba(167,139,250,0.7)' },
  { icon: FileCode, label: 'Analyzing hunks…', accent: 'rgba(110,231,183,0.7)' },
];

/* ── Orbiting icons ─────────────────────────────────────────────────── */
const orbitItems = [
  { Icon: FileText, angle: 0, r: 76, size: 13, speed: 18 },
  { Icon: FileDiff, angle: 60, r: 76, size: 14, speed: 18 },
  { Icon: FileCode, angle: 120, r: 76, size: 13, speed: 18 },
  { Icon: GitCommit, angle: 180, r: 76, size: 12, speed: 18 },
  { Icon: GitBranch, angle: 240, r: 76, size: 13, speed: 18 },
  { Icon: Check, angle: 300, r: 76, size: 12, speed: 18 },
];

/* ── Spark particles ────────────────────────────────────────────────── */
const SPARK_COUNT = 12;

const useSparks = () => {
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number; size: number }[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 50;
      setSparks((prev) => {
        const next = [
          ...prev.slice(-(SPARK_COUNT - 1)),
          {
            id: nextId.current++,
            x: Math.cos(angle) * dist,
            y: Math.sin(angle) * dist,
            size: 1.5 + Math.random() * 2,
          },
        ];
        return next;
      });
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return sparks;
};

/* ── Fake file counter ──────────────────────────────────────────────── */
const useFileCounter = () => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const interval = setInterval(
      () => {
        setCount((prev) => {
          const step = Math.floor(Math.random() * 3) + 1;
          return prev + step;
        });
      },
      600 + Math.random() * 400
    );
    return () => clearInterval(interval);
  }, []);
  return count;
};

/* ── Component ──────────────────────────────────────────────────────── */
export const ChangesLoadingAnimation = (): React.JSX.Element => {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [phaseFading, setPhaseFading] = useState(false);
  const [visibleLines, setVisibleLines] = useState<number[]>([]);
  const linePointer = useRef(0);
  const sparks = useSparks();
  const fileCount = useFileCounter();

  /* Phase rotation */
  useEffect(() => {
    const interval = setInterval(() => {
      setPhaseFading(true);
      setTimeout(() => {
        setPhaseIdx((prev) => (prev + 1) % phases.length);
        setPhaseFading(false);
      }, 400);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  /* Diff lines streaming */
  const addLine = useCallback(() => {
    setVisibleLines((prev) => {
      const next = [...prev, linePointer.current % diffLines.length];
      linePointer.current++;
      return next.length > 5 ? next.slice(-5) : next;
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(addLine, 900);
    return () => clearInterval(interval);
  }, [addLine]);

  const phase = phases[phaseIdx];
  const PhaseIcon = phase.icon;

  return (
    <div className="flex w-full flex-col items-center justify-center gap-4">
      {/* ── Main scene ─────────────────────────────────────────── */}
      <div className="relative flex h-44 w-64 items-center justify-center">
        {/* Faint radial grid */}
        <svg className="pointer-events-none absolute inset-0 opacity-[0.04]" viewBox="0 0 256 176">
          {[40, 60, 80].map((r) => (
            <circle
              key={r}
              cx="128"
              cy="88"
              r={r}
              fill="none"
              stroke="var(--color-text)"
              strokeWidth="0.5"
            />
          ))}
          {[0, 45, 90, 135].map((deg) => (
            <line
              key={deg}
              x1="128"
              y1="88"
              x2={128 + Math.cos((deg * Math.PI) / 180) * 80}
              y2={88 + Math.sin((deg * Math.PI) / 180) * 80}
              stroke="var(--color-text)"
              strokeWidth="0.3"
            />
          ))}
        </svg>

        {/* Rotating dashed orbit ring */}
        <svg
          className="clda-orbit-ring pointer-events-none absolute h-40 w-40"
          viewBox="0 0 160 160"
        >
          <circle
            cx="80"
            cy="80"
            r="76"
            fill="none"
            stroke="var(--color-border-emphasis)"
            strokeWidth="0.8"
            strokeDasharray="4 7"
            opacity="0.4"
          />
        </svg>

        {/* Orbiting icons */}
        {orbitItems.map(({ Icon, angle, r, size, speed }, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2"
            style={
              {
                animation: `cldaOrbit ${speed}s linear infinite`,
                '--o-r': `${r}px`,
                '--o-a': `${angle}deg`,
              } as React.CSSProperties
            }
          >
            <div
              className="text-[var(--color-text-muted)] opacity-40"
              style={
                {
                  animation: `cldaOrbitCounter ${speed}s linear infinite`,
                  '--o-a': `${angle}deg`,
                } as React.CSSProperties
              }
            >
              <Icon size={size} strokeWidth={1.5} />
            </div>
          </div>
        ))}

        {/* Spark particles */}
        {sparks.map((s) => (
          <div
            key={s.id}
            className="clda-spark absolute left-1/2 top-1/2 rounded-full"
            style={
              {
                width: s.size,
                height: s.size,
                background: phase.accent,
                '--sx': `${s.x}px`,
                '--sy': `${s.y}px`,
              } as React.CSSProperties
            }
          />
        ))}

        {/* Glow behind center */}
        <div
          className="clda-glow absolute size-20 rounded-3xl"
          style={{ background: phase.accent, opacity: 0.05 }}
        />

        {/* ── Center card: mini diff terminal ──────────────────── */}
        <div className="clda-center-card relative z-10 flex w-44 flex-col overflow-hidden rounded-xl border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] shadow-2xl">
          {/* Title bar */}
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <div className="flex gap-1">
              <span className="block size-1.5 rounded-full bg-red-500/50" />
              <span className="block size-1.5 rounded-full bg-yellow-500/50" />
              <span className="block size-1.5 rounded-full bg-green-500/50" />
            </div>
            <span className="ml-1 text-[8px] font-medium tracking-wider text-[var(--color-text-muted)] opacity-60">
              DIFF
            </span>
          </div>

          {/* Diff lines */}
          <div className="flex flex-col gap-px px-2 py-1.5 font-mono text-[9px] leading-[14px]">
            {visibleLines.map((lineIdx, i) => {
              const line = diffLines[lineIdx];
              const isNew = i === visibleLines.length - 1;
              return (
                <div
                  key={`${lineIdx}-${i}`}
                  className={`flex gap-1.5 rounded-sm px-1 ${isNew ? 'clda-line-in' : ''} ${
                    line.type === '+'
                      ? 'bg-emerald-500/8 text-emerald-400/80'
                      : line.type === '-'
                        ? 'bg-red-500/8 text-red-400/80'
                        : 'text-[var(--color-text-muted)] opacity-50'
                  }`}
                >
                  <span className="w-2 shrink-0 select-none opacity-60">{line.type}</span>
                  <span className="truncate">{line.text}</span>
                </div>
              );
            })}
            {/* Blinking cursor line */}
            <div className="flex items-center gap-1.5 px-1 text-[var(--color-text-muted)] opacity-30">
              <span className="w-2 shrink-0">&nbsp;</span>
              <span className="clda-cursor inline-block h-2.5 w-px bg-[var(--color-text-secondary)]" />
            </div>
          </div>
        </div>

        {/* Scanning beam (horizontal) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
          <div
            className="clda-scan-h absolute left-0 h-px w-full"
            style={{
              background: `linear-gradient(to right, transparent, ${phase.accent}, transparent)`,
            }}
          />
        </div>
      </div>

      {/* ── Phase indicator ────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {phases.map((p, i) => (
          <div
            key={i}
            className={`flex size-6 items-center justify-center rounded-full border transition-all duration-500 ${
              i === phaseIdx
                ? 'scale-110 border-[var(--color-text-secondary)] bg-[var(--color-surface-raised)]'
                : i < phaseIdx
                  ? 'border-transparent bg-[var(--color-text-muted)] opacity-20'
                  : 'border-[var(--color-border)] opacity-20'
            }`}
          >
            <p.icon
              size={12}
              strokeWidth={1.5}
              className={
                i === phaseIdx ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
              }
            />
          </div>
        ))}
      </div>

      {/* ── Bottom text ────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-1">
        <p
          className="duration-400 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] transition-all"
          style={{
            opacity: phaseFading ? 0 : 1,
            transform: phaseFading ? 'translateY(4px)' : 'none',
          }}
        >
          <PhaseIcon size={12} className="mr-1.5 inline-block align-[-2px] opacity-60" />
          {phase.label}
        </p>
        <p className="text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-50">
          {fileCount} objects processed
        </p>
      </div>

      {/* ── Keyframes ──────────────────────────────────────────── */}
      <style>{`
        .clda-orbit-ring {
          animation: cldaRingSpin 25s linear infinite;
        }
        .clda-glow {
          animation: cldaGlow 3s ease-in-out infinite;
        }
        .clda-center-card {
          animation: cldaCardFloat 5s ease-in-out infinite;
        }
        .clda-cursor {
          animation: cldaBlink 1s step-end infinite;
        }

        .clda-spark {
          animation: cldaSparkLife 1.8s ease-out forwards;
        }

        .clda-scan-h {
          animation: cldaScanH 4s ease-in-out infinite;
        }

        .clda-line-in {
          animation: cldaLineIn 0.3s ease-out;
        }

        @keyframes cldaRingSpin {
          to { transform: rotate(360deg); }
        }

        @keyframes cldaOrbit {
          from {
            transform: translate(-50%,-50%) rotate(var(--o-a)) translateX(var(--o-r)) rotate(calc(-1 * var(--o-a)));
          }
          to {
            transform: translate(-50%,-50%) rotate(calc(var(--o-a) + 360deg)) translateX(var(--o-r)) rotate(calc(-1 * var(--o-a) - 360deg));
          }
        }

        @keyframes cldaOrbitCounter {
          from { transform: rotate(var(--o-a)); }
          to { transform: rotate(calc(var(--o-a) + 360deg)); }
        }

        @keyframes cldaGlow {
          0%, 100% { transform: scale(1); opacity: 0.05; }
          50% { transform: scale(1.3); opacity: 0.1; }
        }

        @keyframes cldaCardFloat {
          0%, 100% { transform: translateY(0px); }
          30% { transform: translateY(-3px); }
          70% { transform: translateY(2px); }
        }

        @keyframes cldaBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        @keyframes cldaSparkLife {
          0% {
            transform: translate(-50%,-50%) translate(0, 0) scale(1);
            opacity: 0.8;
          }
          100% {
            transform: translate(-50%,-50%) translate(var(--sx), var(--sy)) scale(0);
            opacity: 0;
          }
        }

        @keyframes cldaScanH {
          0%   { top: -2px; opacity: 0; }
          10%  { opacity: 0.5; }
          50%  { top: 100%; opacity: 0.3; }
          90%  { opacity: 0; }
          100% { top: 100%; opacity: 0; }
        }

        @keyframes cldaLineIn {
          from { opacity: 0; transform: translateX(-8px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
};
