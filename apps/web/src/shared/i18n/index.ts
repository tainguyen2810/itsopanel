import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { readStorage, writeStorage } from '@/shared/lib/storage';
import type { Locale } from './format';
import enCommon from './locales/en/common.json';
import enDesign from './locales/en/design.json';
import enPages from './locales/en/pages.json';
import enShell from './locales/en/shell.json';
import enStatus from './locales/en/status.json';
import viCommon from './locales/vi/common.json';
import viDesign from './locales/vi/design.json';
import viPages from './locales/vi/pages.json';
import viShell from './locales/vi/shell.json';
import viStatus from './locales/vi/status.json';

/** Namespace theo module. Thêm module mới: tạo locales/{vi,en}/<ns>.json và khai báo ở đây. */
export const resources = {
  vi: { common: viCommon, shell: viShell, design: viDesign, status: viStatus, pages: viPages },
  en: { common: enCommon, shell: enShell, design: enDesign, status: enStatus, pages: enPages },
} as const;

export const LANGUAGES: readonly Locale[] = ['vi', 'en'];
export const LANG_STORAGE_KEY = 'itso.lang';

export function initialLanguage(): Locale {
  return readStorage(LANG_STORAGE_KEY) === 'en' ? 'en' : 'vi';
}

/** Tạo instance i18next độc lập (mỗi entry/test một instance). */
export function createI18n(lng: Locale = initialLanguage()): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'vi',
    supportedLngs: LANGUAGES,
    ns: ['common', 'shell', 'design', 'status', 'pages'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React tự escape
    returnNull: false,
    initAsync: false,
  });
  instance.on('languageChanged', (l) => {
    writeStorage(LANG_STORAGE_KEY, l);
    document.documentElement.lang = l;
  });
  return instance;
}

export function currentLocale(i: I18n): Locale {
  return i.resolvedLanguage === 'en' ? 'en' : 'vi';
}
