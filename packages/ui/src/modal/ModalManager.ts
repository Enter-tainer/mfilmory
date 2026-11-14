import { atom } from 'jotai'

import { modalStore } from './store'
import type { ModalComponent, ModalItem, ModalPresentConfig } from './types'

export const modalItemsAtom = atom<ModalItem[]>([])

const modalCloseRegistry = new Map<string, () => void>()

export const Modal = {
  present<P = unknown>(Component: ModalComponent<P>, props?: P, config?: ModalPresentConfig): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const items = modalStore.get(modalItemsAtom)
    const { dismissOnOutsideClick, ...modalContent } = config ?? {}

    modalStore.set(modalItemsAtom, [
      ...items,
      {
        id,
        component: Component as ModalComponent<any>,
        props,
        modalContent,
        dismissOnOutsideClick,
      },
    ])
    return id
  },

  dismiss(id: string): void {
    const closer = modalCloseRegistry.get(id)
    if (closer) {
      closer()
      return
    }
    // Fallback: remove immediately if closer not registered yet
    const items = modalStore.get(modalItemsAtom)
    modalStore.set(
      modalItemsAtom,
      items.filter((m) => m.id !== id),
    )
  },

  /** Internal: used by container to manage close hooks */
  __registerCloser(id: string, fn: () => void) {
    modalCloseRegistry.set(id, fn)
  },
  __unregisterCloser(id: string) {
    modalCloseRegistry.delete(id)
  },

  /**
   * 是否有全局弹窗正在显示。
   *
   * 给「不归 Radix 管、自己挂 document/window 监听」的快捷键用：viewer 的
   * ArrowLeft/Right/Escape 就属于这种，弹窗打开时必须让位，否则按 Esc 会连
   * 弹窗和 viewer 一起关掉、按方向键会把背景里的照片换掉。
   */
  isOpen(): boolean {
    return modalStore.get(modalItemsAtom).length > 0
  },
}

export { type ModalItem } from './types'
