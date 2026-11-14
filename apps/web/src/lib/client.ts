import type { Client } from '@afilmory/sdk'

/**
 * 后端 SDK（`@afilmory/sdk`）会把 **zod** 一起带进来（约 157 KB 未压缩），而且它在
 * 模块顶层就用 zod 定义了一套 DTO schema。
 *
 * 这个站点是纯静态部署（`config.useApi / useCloud` 都是 false），点赞/评论/trackView
 * 全部走 feature-detect 短路 —— 换句话说首屏永远用不到它。但以前这里是
 * `export const client = new Client(...)`，模块作用域求值把整包拖进了首屏 chunk。
 *
 * 改成「第一次真的要发请求时才 import」。
 */
let clientPromise: Promise<Client> | null = null

export const getClient = (): Promise<Client> => {
  clientPromise ??= import('@afilmory/sdk')
    .then(({ Client: SdkClient }) => new SdkClient(window.location.origin))
    .catch((error) => {
      // 失败的 promise 不能缓存：`@afilmory/sdk` 是带 hash 的不可变 chunk，
      // 只有网络瞬时故障/部署切换窗口会失败，把 rejection 永久钉在模块作用域里
      // 会让「重试」变成永远失败。清掉后下一次调用重新 import()。
      clientPromise = null
      throw error
    })
  return clientPromise
}
