import type { CameraInfo, LensInfo, PhotoManifestItem } from '@afilmory/builder'

/** 启动时注入的 manifest（结构见 @afilmory/typing 的 AfilmoryManifest） */
export interface PhotoManifestPayload {
  data?: PhotoManifestItem[]
  cameras?: CameraInfo[]
  lenses?: LensInfo[]
}

class PhotoLoader {
  private photos: PhotoManifestItem[] = []
  private photoMap: Record<string, PhotoManifestItem> = {}
  private cameras: CameraInfo[] = []
  private lenses: LensInfo[] = []
  private initialized = false

  constructor() {
    this.getAllTags = this.getAllTags.bind(this)
    this.getAllCameras = this.getAllCameras.bind(this)
    this.getAllLenses = this.getAllLenses.bind(this)
    this.getPhotos = this.getPhotos.bind(this)
    this.getPhoto = this.getPhoto.bind(this)
    this.init = this.init.bind(this)
  }

  /**
   * 由启动流程显式注入 manifest。
   *
   * 以前这里在构造时直接读全局 `__MANIFEST__`，逼着构建期把整份 manifest 内联进 HTML
   * （769 KB，且 HTML 因此永远不能被边缘缓存）。现在 manifest 是一份单独的可缓存 JSON，
   * 由 `src/main.tsx` 在渲染前 fetch 并注入。
   */
  init(manifest: PhotoManifestPayload | null | undefined) {
    this.photos = manifest?.data ?? []
    this.cameras = manifest?.cameras ?? []
    this.lenses = manifest?.lenses ?? []
    this.photoMap = {}
    this.photos.forEach((photo) => {
      this.photoMap[photo.id] = photo
    })
    this.initialized = true
  }

  isInitialized() {
    return this.initialized
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
      photo.tags.forEach(tag => tagSet.add(tag))
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
