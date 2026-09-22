import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { FALLBACK_APP_LOCALE } from '../../contracts';

export interface LocaleFormatters {
  readonly date: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly time: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly dateTime: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions
  ) => string;
  readonly number: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly currency: (
    value: number,
    currency: string,
    options?: Intl.NumberFormatOptions
  ) => string;
}

export function useLocaleFormatters(): LocaleFormatters {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || FALLBACK_APP_LOCALE;

  return useMemo(
    () => ({
      date: (value, options) =>
        new Intl.DateTimeFormat(locale, options ?? { dateStyle: 'medium' }).format(
          normalizeDate(value)
        ),
      time: (value, options) =>
        new Intl.DateTimeFormat(locale, options ?? { hour: '2-digit', minute: '2-digit' }).format(
          normalizeDate(value)
        ),
      dateTime: (value, options) =>
        new Intl.DateTimeFormat(
          locale,
          options ?? { dateStyle: 'medium', timeStyle: 'short' }
        ).format(normalizeDate(value)),
      number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
      currency: (value, currency, options) =>
        new Intl.NumberFormat(locale, {
          currency,
          style: 'currency',
          ...options,
        }).format(value),
    }),
    [locale]
  );
}

function normalizeDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}
