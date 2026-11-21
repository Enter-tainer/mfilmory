// The wasm binary is re-exported by the package itself (`./zeroperl.wasm` in its
// exports map). Importing it straight from the dependency avoids the committed
// symlink this fork used to carry, which does not survive a Windows checkout.
import zeroperlWasmUrl from '@6over3/zeroperl-ts/zeroperl.wasm?url'

const fetchZeroperlWasm = (..._args: unknown[]) => fetch(zeroperlWasmUrl)

class ExifToolManagerStatic {
  private isLoaded = false
  private loadPromise: Promise<void> | null = null
  private exifTool: typeof import('@uswriting/exiftool') | null = null

  async load() {
    if (this.isLoaded) {
      return
    }
    if (!this.loadPromise) {
      this.loadPromise = import('@uswriting/exiftool')
        .then((exiftool) => {
          this.exifTool = exiftool
          this.isLoaded = true
        })
        .finally(() => {
          this.loadPromise = null
        })
    }
    await this.loadPromise
  }

  async parse(buffer: Blob, filename?: string) {
    if (!this.exifTool) {
      await this.load()
    }

    if (!this.exifTool) {
      throw new Error('ExifTool not loaded')
    }
    const metadata = await this.exifTool.parseMetadata(new File([buffer], `/afilmory/${filename}`), {
      fetch: fetchZeroperlWasm,
    })

    if (!metadata.success) {
      throw new Error(metadata.error)
    }

    return metadata.data
  }
}
export const ExifToolManager = new ExifToolManagerStatic()
