import 'dotenv-expand/config'

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { BuildProgressListener } from './builder/builder.js'
import { AfilmoryBuilder } from './builder/index.js'
import { loadBuilderConfig } from './config/index.js'
import { shutdownExiftool } from './image/exif.js'
import { logger, setLogListener } from './logger/index.js'
import { hasCpuWorkerScript, resolveCpuPlan } from './worker/cpu-pool.js'

type BuilderTUI = import('./cli/tui.js').BuilderTUI

async function main() {
  // 解析命令行参数
  const args = new Set(process.argv.slice(2))
  const rawArgs = process.argv.slice(2)
  const isForceMode = args.has('--force')
  const isForceManifest = args.has('--force-manifest')
  const isForceThumbnails = args.has('--force-thumbnails')
  const disableUi = args.has('--no-ui')
  const dryRun = args.has('--dry-run')
  const keyRegex = rawArgs
    .find(arg => arg.startsWith('--key-regex='))
    ?.slice('--key-regex='.length)
    .trim()

  // 显示帮助信息（无需加载或校验存储配置）
  if (args.has('--help') || args.has('-h')) {
    logger.main.info(`
照片库构建工具 (新版本 - 使用适配器模式)

用法：tsx src/cli.ts [选项]

选项：
  --force              强制重新处理所有照片
  --force-manifest     强制重新生成 manifest
  --force-thumbnails   强制重新生成缩略图
  --dry-run            跑完整流程但只打印结果：不写 manifest / 缩略图，也不执行插件钩子（插件照常加载）
  --key-regex=REGEX    仅处理 key 匹配指定正则的照片
  --config             显示当前配置信息
  --help, -h           显示帮助信息
  --no-ui              使用传统日志输出（禁用 TUI）

示例：
  tsx src/cli.ts                           # 增量更新
  tsx src/cli.ts --force                   # 全量更新
  tsx src/cli.ts --force-thumbnails        # 强制重新生成缩略图
  tsx src/cli.ts --dry-run --key-regex='DSC_6447|DSC_7132'
  tsx src/cli.ts --config                  # 显示配置信息

配置：
  在 builder.config.ts 的 system.processing 中可配置：
    cpuConcurrency / sharpConcurrency / cpuWorkerCount / networkConcurrency
`)
    return
  }

  const builderConfig = await loadBuilderConfig({
    cwd: join(fileURLToPath(import.meta.url), '../../../..'),
  })
  const cliBuilder = new AfilmoryBuilder(builderConfig)
  process.title = 'photo-gallery-builder-main'

  // 显示配置信息
  if (args.has('--config')) {
    const config = cliBuilder.getConfig()
    const userConfig = config.user
    const storage = userConfig?.storage
    if (!storage) {
      logger.main.error('未配置存储提供商，请先在配置文件中设置 storage 字段')
      return
    }
    logger.main.info('🔧 当前配置：')
    logger.main.info(`   存储提供商：${storage.provider}`)

    switch (storage.provider) {
      case 's3':
      case 'oss':
      case 'cos': {
        logger.main.info(`   存储桶：${storage.bucket}`)
        logger.main.info(`   区域：${storage.region || '未设置'}`)
        logger.main.info(`   端点：${storage.endpoint || '默认'}`)
        logger.main.info(`   自定义域名：${storage.customDomain || '未设置'}`)
        logger.main.info(`   前缀：${storage.prefix || '无'}`)
        break
      }
      case 'github': {
        logger.main.info(`   仓库所有者：${storage.owner}`)
        logger.main.info(`   仓库名称：${storage.repo}`)
        logger.main.info(`   分支：${storage.branch || 'main'}`)
        logger.main.info(`   路径：${storage.path || '无'}`)
        logger.main.info(`   使用原始 URL：${storage.useRawUrl || '否'}`)
        break
      }
    }
    const { processing } = config.system
    logger.main.info(`   CPU 并发槽：${processing.cpuConcurrency}`)
    logger.main.info(`   Sharp 内部线程：${processing.sharpConcurrency}`)
    logger.main.info(`   CPU 子进程数：${processing.cpuWorkerCount}`)
    logger.main.info(`   网络并发上限：${processing.networkConcurrency}`)
    logger.main.info(`   Live Photo 检测：${processing.enableLivePhotoDetection ? '启用' : '禁用'}`)
    logger.main.info(`   照片后缀摘要长度：${processing.digestSuffixLength}`)
    logger.main.info('')
    if (!userConfig) {
      logger.main.warn('未配置用户级存储设置')
      return
    }
    return
  }

  // 确定运行模式
  let runMode = '增量更新'
  if (isForceMode) {
    runMode = '全量更新'
  }
  else if (isForceManifest && isForceThumbnails) {
    runMode = '强制刷新 manifest 和缩略图'
  }
  else if (isForceManifest) {
    runMode = '强制刷新 manifest'
  }
  else if (isForceThumbnails) {
    runMode = '强制刷新缩略图'
  }

  const config = cliBuilder.getConfig()
  const { processing } = config.system
  const initialPlan = resolveCpuPlan(
    {
      cpuConcurrency: processing.cpuConcurrency,
      sharpConcurrency: processing.sharpConcurrency,
      cpuWorkerCount: processing.cpuWorkerCount,
      taskCount:
        typeof processing.cpuConcurrency === 'number' && processing.cpuConcurrency > 0
          ? processing.cpuConcurrency
          : os.cpus().length,
    },
    hasCpuWorkerScript(),
  )

  const useTui = process.stdout.isTTY && !disableUi
  let tui: BuilderTUI | null = null
  let progressListener: BuildProgressListener | undefined

  if (useTui) {
    const { BuilderTUI } = await import('./cli/tui.js')
    tui = new BuilderTUI()
    tui.attach()
    tui.setRunMetadata({
      runMode,
      concurrency: initialPlan.cpuSlots,
      processingMode: initialPlan.mode,
    })
    progressListener = tui.createProgressListener()
    setLogListener(message => tui?.handleLog(message), { forwardToConsole: false })
  }

  logger.main.info(`🚀 运行模式：${runMode}`)
  logger.main.info(
    `⚡ 资源池配置：CPU=${processing.cpuConcurrency} (sharp=${processing.sharpConcurrency}, workers=${processing.cpuWorkerCount}), 网络=${processing.networkConcurrency}`,
  )
  logger.main.info(`🏗️ 使用构建器：AfilmoryBuilder (资源池分离模式)`)
  if (dryRun) {
    logger.main.info('🧪 Dry-run 已启用')
  }
  if (keyRegex) {
    logger.main.info(`🔎 Key 正则筛选：${keyRegex}`)
  }

  environmentCheck()

  const abortController = new AbortController()
  let interruptSignal: NodeJS.Signals | null = null
  const handleTerminationSignal = (sig: NodeJS.Signals) => {
    if (interruptSignal) {
      setLogListener(null, { forwardToConsole: true })
      tui?.detach()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    }
    interruptSignal = sig
    abortController.abort(new Error(`收到退出信号 ${sig}`))
    logger.main.warn(`收到 ${sig}，正在等待当前任务安全收尾…（再次按下可强制退出）`)
  }
  const onSigint = () => handleTerminationSignal('SIGINT')
  const onSigterm = () => handleTerminationSignal('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // 启动构建过程
  try {
    const result = await cliBuilder.buildManifest({
      isForceMode,
      isForceManifest,
      isForceThumbnails,
      dryRun,
      keyRegex,
      progressListener,
      signal: abortController.signal,
    })

    if (!interruptSignal) {
      tui?.markSuccess(result)
    }
  }
  catch (error) {
    if (!interruptSignal) {
      tui?.markError(error)
      throw error
    }
  }
  finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (useTui) {
      setLogListener(null, { forwardToConsole: true })
      tui?.detach()
    }
    await shutdownExiftool()
  }

  if (interruptSignal) {
    process.exit(interruptSignal === 'SIGINT' ? 130 : 143)
  }

  process.exit(0)
}

// 运行主函数
main().catch((error) => {
  logger.main.error('构建失败：', error)
  throw error
})

function environmentCheck() {
  try {
    execSync('perl -v', { stdio: 'ignore' })

    logger.main.info('Perl 已安装')
    return
  }
  catch {}

  // Windows 上 Git for Windows / Strawberry Perl 自带的 perl 通常不在 PATH 里。
  const perlCandidates = [
    'C:\\Program Files\\Git\\usr\\bin\\perl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\perl.exe',
    'C:\\Strawberry\\perl\\bin\\perl.exe',
    'C:\\Perl64\\bin\\perl.exe',
  ]
  for (const candidate of perlCandidates) {
    if (!existsSync(candidate)) {
      continue
    }
    process.env.PATH = `${dirname(candidate)}${delimiter}${process.env.PATH ?? ''}`
    logger.main.info(`Perl 未在 PATH 中，已使用：${candidate}`)
    return
  }

  // exiftool-vendored 自带不依赖系统 Perl 的 exiftool 二进制，只有少数外部工具
  // 才真的需要 perl。这里降级为警告，避免 Windows 上直接中断整个构建。
  logger.main.warn('未检测到 Perl（exiftool-vendored 不依赖它），继续构建。若照片处理失败，请安装 Perl 并加入 PATH。')
}
