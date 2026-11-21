import { atom } from 'jotai'

export const DEFAULT_SSR_VIEWPORT = {
  'sm': true,
  'md': true,
  'lg': true,
  'xl': true,
  '2xl': false,
  'h': 900,
  'w': 1440,
}

export const viewportAtom = atom(DEFAULT_SSR_VIEWPORT)
