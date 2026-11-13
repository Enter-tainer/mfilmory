import type { CameraInfo, LensInfo, PhotoManifestItem } from '@afilmory/builder'

/** 首屏下发的精简 manifest（结构见 @afilmory/typing 的 AfilmoryManifest） */
export interface PhotoManifestPayload {
  data?: PhotoManifestItem[]
  cameras?: CameraInfo[]
  lenses?: LensInfo[]
}

/** detail 文件：id → 需要时才补上的字段 */
type PhotoDetailMap = Record<string, Partial<PhotoManifestItem>>

export interface InitOptions {
  /** `photos-manifest.detail.<hash>.json` 的地址；缺省表示数据已经是完整的（dev / 内联模式） */
  detailUrl?: string
}

type DetailListener = () => void

class PhotoLoader {
  private photos: PhotoManifestItem[] = []
  private photoMap: Record<string, PhotoManifestItem> = {}
  private cameras: CameraInfo[] = []
  private lenses: LensInfo[] = []
  private initialized = false

  private detailUrl: string | undefined
  private detailPromise: Promise<void> | null = null
  private detailLoaded = false
  private detailListeners = new Set<DetailListener>()

  constructor() {
    this.getAllTags = this.getAllTags.bind(this)
    this.getAllCameras = this.getAllCameras.bind(this)
    this.getAllLenses = this.getAllLenses.bind(this)
    this.getPhotos = this.getPhotos.bind(this)
    this.getPhoto = this.getPhoto.bind(this)
    this.init = this.init.bind(this)
    this.loadDetails = this.loadDetails.bind(this)
    this.subscribeDetails = this.subscribeDetails.bind(this)
  }

  /**
   * 由启动流程显式注入 manifest。
   *
   * 首屏只要网格/筛选/排序/地图标记需要的字段；完整的 exif、location、toneAnalysis 等
   * 放在 detail 文件里，等真的要开大图时再取（见 `loadDetails`）。
   */
  init(manifest: PhotoManifestPayload | null | undefined, options: InitOptions = {}) {
    this.photos = manifest?.data ?? []
    this.cameras = manifest?.cameras ?? []
    this.lenses = manifest?.lenses ?? []
    this.detailUrl = options.detailUrl
    this.detailLoaded = !options.detailUrl
    this.detailPromise = null
    this.reindex()
    this.initialized = true
  }

  private reindex() {
    this.photoMap = {}
    for (const photo of this.photos) {
      this.photoMap[photo.id] = photo
    }
  }

  isInitialized() {
    return this.initialized
  }

  /** 完整字段是否已到（没有 detail 文件时恒为 true） */
  isDetailLoaded() {
    return this.detailLoaded
  }

  /** 订阅「detail 已合并」事件；返回取消订阅函数 */
  subscribeDetails(listener: DetailListener) {
    if (this.detailLoaded) {
      return () => {}
    }
    this.detailListeners.add(listener)
    return () => {
      this.detailListeners.delete(listener)
    }
  }

  /**
   * 拉取并合并 detail（幂等）。
   *
   * 合并方式是**替换对象**而不是就地改字段：`usePhotos` / `useMemo` 之类的记忆化依赖对象引用，
   * 就地修改不会触发重算，ExifPanel 会一直显示「缺字段」。
   */
  async loadDetails(): Promise<void> {
    if (this.detailLoaded) {
      return
    }
    if (this.detailPromise) {
      return this.detailPromise
    }

    this.detailPromise = (async () => {
      try {
        const url = this.detailUrl!
        const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const detail = (await response.json()) as PhotoDetailMap
        // 注意 exif 必须单独合并：detail 里存的是「首屏那份没带的字段」，
        // 直接 {...photo, ...patch} 会把整个 exif 换成残缺的那半份。
        this.photos = this.photos.map((photo) => {
          const patch = detail[photo.id]
          if (!patch) {
            return photo
          }
          const merged = { ...photo, ...patch }
          if (patch.exif) {
            merged.exif = { ...photo.exif, ...patch.exif }
          }
          return merged
        })
        this.reindex()
        this.detailLoaded = true
        for (const listener of this.detailListeners) {
          listener()
        }
        this.detailListeners.clear()
      }
      catch (error) {
        // 失败不该阻断任何用户路径：网格/大图预览都还能用，只是 EXIF 面板会缺字段。
        // 重置 promise，下次进入 viewer 时可以重试。
        console.error('[manifest] failed to load photo details:', error)
        this.detailPromise = null
      }
    })()

    return this.detailPromise
  }

  getPhotos() {
    return this.photos
  }

  getPhoto(id: string) {
    return this.photoMap[id]
  }

  getAllTags() {
    const tagSet = new Set<string>()
    this.photos.forEach((photo) => {
      for (const tag of photo.tags) {
        tagSet.add(tag)
      }
    })
    return Array.from(tagSet).sort()
  }

  getAllCameras() {
    return this.cameras
  }

  getAllLenses() {
    return this.lenses
  }
}
export const photoLoader = new PhotoLoader()
