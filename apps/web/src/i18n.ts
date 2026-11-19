import type { BackendModule, ResourceKey } from 'i18next'
import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { atom } from 'jotai'
import { initReactI18next } from 'react-i18next'

import { currentSupportedLanguages, defaultNS, ns } from './@types/constants'
import { jotaiStore } from './lib/jotai'

const localeLoaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  'en': () => import('@locales/app/en.json'),
  'jp': () => import('@locales/app/jp.json'),
  'ko': () => import('@locales/app/ko.json'),
  'zh-CN': () => import('@locales/app/zh-CN.json'),
  'zh-HK': () => import('@locales/app/zh-HK.json'),
  'zh-TW': () => import('@locales/app/zh-TW.json'),
}

const localeBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    if (namespace !== defaultNS) {
      callback(null, {})
      return
    }
    const loader = Object.hasOwn(localeLoaders, language) ? localeLoaders[language] : undefined
    if (!loader) {
      callback(null, {})
      return
    }
    loader()
      .then((mod) => {
        callback(null, mod.default as ResourceKey)
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), null)
      })
  },
}

const i18n = i18next.createInstance()
export const i18nReady = i18n
  .use(localeBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: {
      default: ['en'],
    },
    supportedLngs: currentSupportedLanguages,
    ns,
    defaultNS,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
    },
    returnNull: false,
  })

export { i18n }

export const i18nAtom = atom(i18n)

export const getI18n = () => {
  return jotaiStore.get(i18nAtom)
}
