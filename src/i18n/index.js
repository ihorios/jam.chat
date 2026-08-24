import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import uk from './uk.json';

/**
 * Interface languages.
 *
 * ISO 639-1 codes, matching users.language on the server — `uk` is Ukrainian.
 * (`ua` is the country code for Ukraine and is what browsers put in the region
 * half of `uk-UA`, so using it as the language would fight every detector.)
 *
 * `nativeName` is deliberately in the language itself: somebody who has landed
 * on a page they cannot read needs to recognise their own language in the
 * switcher, not read its English name.
 */
export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'uk', nativeName: 'Українська' },
];

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code);
export const DEFAULT_LANGUAGE = 'en';

/** Where a signed-out visitor's choice is remembered between visits. */
export const LANGUAGE_STORAGE_KEY = 'jamchat.language';

/** The supported language closest to a tag, mirroring the server's rule. */
export function normaliseLanguage(value) {
  const base = String(value || '').trim().toLowerCase().split('-')[0];
  return LANGUAGE_CODES.includes(base) ? base : DEFAULT_LANGUAGE;
}

i18n
  // Picks a language from localStorage first, then the browser. A signed-in
  // user's stored preference overrides both — see AuthContext, which applies
  // it once the session is known.
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      uk: { translation: uk },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGE_CODES,
    // Without this, `uk-UA` is looked up as its own language and misses every
    // key in uk.json.
    load: 'languageOnly',
    // Keys are dotted paths ('login.signIn'); ':' would otherwise be read as a
    // namespace separator and '.' as a nesting separator, which is what we want
    // for '.' but means a key may never contain a colon.
    interpolation: { escapeValue: false }, // React escapes for us
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
  });

export default i18n;
