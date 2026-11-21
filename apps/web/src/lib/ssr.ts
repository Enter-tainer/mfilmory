import { useSyncExternalStore } from 'react'

export const SSR_DEFAULT_LNG = 'zh-CN'

export const isServer = typeof window === 'undefined'

const emptySubscribe = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

export function useIsClient(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot)
}
