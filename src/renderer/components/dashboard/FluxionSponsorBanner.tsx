import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import fluxionHeaderField from '@renderer/assets/fluxion/header-field.webp';
import fluxionLogoMark from '@renderer/assets/fluxion/logo-mark.png';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useDynamicFlag } from '@renderer/utils/dynamicFlags';
import { ArrowUpRight, Handshake, Mail, Plus } from 'lucide-react';

import type { JSX } from 'react';

const FLUXION_SPONSOR_URL =
  'https://fluxionai.world/register?source=github&campaign=github-agent-teams&promo=AGENTTEAMS';
const SPONSOR_EMAIL = 'quantjumppro@gmail.com';

const FluxionBrand = (): JSX.Element => (
  <div className="flex shrink-0 items-center gap-2">
    <span className="flex size-8 items-center justify-center rounded-lg border border-[#dfe4ff] bg-white shadow-sm dark:border-white/15">
      <img src={fluxionLogoMark} alt="" className="size-6" draggable={false} />
    </span>
    <div className="min-w-0">
      <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[#171d32] dark:text-white">
        Fluxion AI
      </div>
      <div className="text-[8px] font-medium uppercase tracking-[0.16em] text-[#5368f3] dark:text-white/55">
        AI API Gateway
      </div>
    </div>
  </div>
);

const SponsorRibbon = (): JSX.Element => (
  <span className="absolute left-[-24px] top-[10px] z-20 w-[88px] -rotate-45 bg-[#5368f3] py-px text-center text-[5.5px] font-bold uppercase tracking-[0.16em] text-white">
    Sponsor
  </span>
);

const openFluxion = (): void => {
  void api.openExternal(FLUXION_SPONSOR_URL);
};

const FluxionBanner = (): JSX.Element => (
  <div
    role="link"
    tabIndex={0}
    onClick={openFluxion}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFluxion();
      }
    }}
    className="relative isolate min-h-[58px] cursor-pointer overflow-hidden rounded-lg border border-[#dfe4ff] bg-[#f8f9fe] px-3 py-2 dark:border-[#6f7ff5]/30 dark:bg-[#101426]"
  >
    <SponsorRibbon />
    <img
      src={fluxionHeaderField}
      alt=""
      className="absolute inset-0 -z-20 size-full object-cover opacity-20 mix-blend-multiply dark:opacity-25 dark:mix-blend-screen"
      draggable={false}
    />
    <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#f8f9fe] via-[#f8f9fe]/95 to-white/55 dark:hidden" />
    <div className="absolute inset-0 -z-10 hidden bg-[radial-gradient(circle_at_73%_15%,rgba(102,123,255,0.3),transparent_38%),linear-gradient(90deg,rgba(11,15,31,0.98),rgba(18,24,53,0.78))] dark:block" />

    <div className="flex min-h-[40px] items-center gap-3 pl-[5px]">
      <FluxionBrand />
      <div className="min-w-0 flex-1 border-l border-[#dfe4ff] pl-4 dark:border-white/10">
        <p className="truncate text-[11px] font-medium text-[#28304a] dark:text-white">
          One gateway to the world&apos;s leading AI models
        </p>
        <p className="mt-0.5 truncate text-[9px] text-[#717990] dark:text-white/50">
          Compare routes, pricing, usage and billing in one place.{' '}
          <span className="font-semibold text-[#5368f3] dark:text-[#9aa7ff]">$3 signup credit</span>
        </p>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openFluxion();
        }}
        className="flex shrink-0 items-center gap-1 rounded-md bg-[#5368f3] px-2.5 py-1.5 text-[9px] font-semibold text-white transition-transform hover:-translate-y-px dark:bg-white dark:text-[#171d32]"
      >
        Explore
        <ArrowUpRight className="size-3" />
      </button>
    </div>
  </div>
);

const PartnershipBanner = ({ onOpen }: { onOpen: () => void }): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const becomeSponsor = t('cliStatus.actions.becomeSponsor');

  return (
    <div className="flex min-h-[58px] w-[330px] shrink-0 items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-white/[0.018] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-[var(--color-text-muted)]">
          <Handshake className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-medium text-[var(--color-text-secondary)]">
            {becomeSponsor}
          </p>
          <p className="text-[9px] leading-3 text-[var(--color-text-muted)]">
            {t('cliStatus.sponsorship.description')}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        title={becomeSponsor}
        aria-label={becomeSponsor}
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--color-text)]"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
};

export const FluxionSponsorBanner = (): JSX.Element | null => {
  const [sponsorDialogOpen, setSponsorDialogOpen] = useState(false);
  const showSponsorFluxion = useDynamicFlag('showSponsorFluxion');
  const { t } = useAppTranslation('dashboard');

  if (!showSponsorFluxion) return null;

  return (
    <section className="mt-3">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <FluxionBanner />
        </div>
        <PartnershipBanner onOpen={() => setSponsorDialogOpen(true)} />
      </div>

      <Dialog open={sponsorDialogOpen} onOpenChange={setSponsorDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cliStatus.actions.becomeSponsor')}</DialogTitle>
            <DialogDescription className="pt-1 leading-6">
              {t('cliStatus.sponsorship.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <button
            type="button"
            onClick={() => void api.openExternal(`mailto:${SPONSOR_EMAIL}`)}
            className="flex items-center justify-center gap-2 rounded-md bg-[#5368f3] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#4659dc]"
          >
            <Mail className="size-4" />
            {SPONSOR_EMAIL}
          </button>
        </DialogContent>
      </Dialog>
    </section>
  );
};
