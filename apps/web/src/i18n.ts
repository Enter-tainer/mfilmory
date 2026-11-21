import type { BackendModule, ResourceKey } from 'i18next'
import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { atom } from 'jotai'
import { initReactI18next } from 'react-i18next'

import { currentSupportedLanguages, defaultNS, ns } from './@types/constants'
import { jotaiStore } from './lib/jotai'
import { SSR_DEFAULT_LNG } from './lib/ssr'

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

function matchSupportedLanguage(raw: string | null | undefined): string | null {
  if (!raw) {
    return null
  }
  const trimmed = raw.trim()
  if (currentSupportedLanguages.includes(trimmed)) {
    return trimmed
  }
  const lower = trimmed.toLowerCase()
  const exactCi = currentSupportedLanguages.find(lng => lng.toLowerCase() === lower)
  if (exactCi) {
    return exactCi
  }
  if (lower === 'ja' || lower.startsWith('ja-')) {
    return 'jp'
  }
  if (lower.startsWith('zh-hk')) {
    return 'zh-HK'
  }
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hant')) {
    return 'zh-TW'
  }
  if (lower.startsWith('zh')) {
    return 'zh-CN'
  }
  if (lower.startsWith('ko')) {
    return 'ko'
  }
  if (lower.startsWith('en')) {
    return 'en'
  }
  return null
}

export function detectPreferredLanguage(): string {
  if (typeof window === 'undefined') {
    return SSR_DEFAULT_LNG
  }
  const params = new URLSearchParams(window.location.search)
  const fromQuery = matchSupportedLanguage(params.get('lng'))
  if (fromQuery) {
    return fromQuery
  }

  try {
    const fromStorage = matchSupportedLanguage(window.localStorage.getItem('i18nextLng'))
    if (fromStorage) {
      return fromStorage
    }
  }
  catch {
    // ignore storage restrictions
  }

  if (typeof navigator !== 'undefined') {
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language]
    for (const candidate of candidates) {
      const matched = matchSupportedLanguage(candidate)
      if (matched) {
        return matched
      }
    }
  }

  return SSR_DEFAULT_LNG
}

const i18n = i18next.createInstance()
let initPromise: Promise<unknown> | null = null

export function initClientI18n(options?: { ssrLng?: string }): Promise<unknown> {
  if (initPromise) {
    return initPromise
  }

  const instance = i18n.use(localeBackend)
  if (!options?.ssrLng && typeof window !== 'undefined') {
    instance.use(LanguageDetector)
  }

  initPromise = instance.use(initReactI18next).init({
    ...(options?.ssrLng ? { lng: options.ssrLng } : {}),
    fallbackLng: {
      default: ['en'],
    },
    supportedLngs: currentSupportedLanguages,
    ns,
    defaultNS,
    interpolation: {
      escapeValue: false,
    },
    ...(options?.ssrLng
      ? {}
      : {
          detection: {
            order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
            caches: ['localStorage'],
          },
        }),
    returnNull: false,
  })

  return initPromise
}

export { i18n }

export const i18nAtom = atom(i18n)

export const getI18n = () => {
  return jotaiStore.get(i18nAtom)
}
