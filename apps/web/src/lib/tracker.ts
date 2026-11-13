import { injectConfig } from '~/config'
import { getClient } from '~/lib/client'

export const trackView = (photoId: string) => {
  if (!injectConfig.useApi) {
    return
  }

  void getClient()
    .then(client => client.actView({ refKey: photoId }))
    .catch((error) => {
      // 埋点失败不该影响任何用户路径
      console.warn('[track] actView failed', error)
    })
}
