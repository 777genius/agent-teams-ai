type DownloadEventParams = {
  os: string;
  arch: string;
  version?: string | null;
  source: string;
};

export const useAnalytics = () => {
  const trackNavClick = (_target: string) => {};
  const trackLanguageSwitch = (_from: string, _to: string) => {};
  const trackThemeToggle = (_theme: "light" | "dark") => {};
  const trackDownloadClick = (_params: DownloadEventParams) => {};
  const trackSectionView = (_sectionId: string) => {};
  const trackFaqExpand = (_faqId: string, _question: string) => {};

  return {
    trackNavClick,
    trackLanguageSwitch,
    trackThemeToggle,
    trackDownloadClick,
    trackSectionView,
    trackFaqExpand,
  };
};
