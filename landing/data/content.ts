import en from '~/content/en.json';
import ru from '~/content/ru.json';
import zh from '~/content/zh.json';
import es from '~/content/es.json';
import hi from '~/content/hi.json';
import ar from '~/content/ar.json';
import pt from '~/content/pt.json';
import fr from '~/content/fr.json';
import ja from '~/content/ja.json';
import ko from '~/content/ko.json';
import de from '~/content/de.json';
import bn from '~/content/bn.json';
import ur from '~/content/ur.json';
import id from '~/content/id.json';
import it from '~/content/it.json';
import tr from '~/content/tr.json';
import vi from '~/content/vi.json';
import pl from '~/content/pl.json';
import fa from '~/content/fa.json';
import th from '~/content/th.json';
import uk from '~/content/uk.json';
import nl from '~/content/nl.json';
import ta from '~/content/ta.json';
import te from '~/content/te.json';
import mr from '~/content/mr.json';
import fil from '~/content/fil.json';
import ms from '~/content/ms.json';
import sw from '~/content/sw.json';
import ro from '~/content/ro.json';
import type { LandingContent, LocalizedContent } from '~/types/content';
import type { LocaleCode } from '~/data/i18n';

export const contentByLocale: LocalizedContent = {
  en,
  ru,
  zh,
  es,
  hi,
  ar,
  pt,
  fr,
  ja,
  ko,
  de,
  bn,
  ur,
  id,
  it,
  tr,
  vi,
  pl,
  fa,
  th,
  uk,
  nl,
  ta,
  te,
  mr,
  fil,
  ms,
  sw,
  ro,
};

export const getContent = (locale: LocaleCode): LandingContent => {
  return contentByLocale[locale] ?? contentByLocale.en;
};
