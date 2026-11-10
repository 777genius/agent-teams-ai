import { useAppTranslation } from '@features/localization/renderer';

export function OrgMapLegendHud(): React.JSX.Element {
  const { t } = useAppTranslation('team');

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-white/[0.07] bg-[rgba(8,12,24,0.76)] px-2.5 py-1.5 text-[9px] text-[var(--color-text-muted)] shadow-lg shadow-black/20 backdrop-blur-md">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-sm border border-sky-300/60 bg-sky-400/10" />
        {t('organizations.graph.legend.organization')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-sm border border-slate-400/45 bg-slate-400/5" />
        {t('organizations.graph.legend.group')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 bg-slate-400/70" />
        {t('organizations.graph.legend.hierarchy')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 bg-violet-400/80" />
        {t('organizations.graph.legend.connection')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        {t('organizations.graph.legend.online')}
      </span>
    </div>
  );
}
