import { thumbHashToRGBA } from 'thumbhash'

export interface PhotoColor {
  h: number
  c: number
  l: number
}

export const NEUTRAL_CHROMA = 0.02

const srgbToLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

export const rgbToOklch = (r: number, g: number, b: number): PhotoColor => {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const lms = Math.cbrt(0.412_221_47 * lr + 0.536_332_536 * lg + 0.051_445_993 * lb)
  const mms = Math.cbrt(0.211_903_5 * lr + 0.680_699_545 * lg + 0.107_396_957 * lb)
  const sms = Math.cbrt(0.088_302_462 * lr + 0.281_718_838 * lg + 0.629_978_7 * lb)
  const lightness = 0.210_454_255 * lms + 0.793_617_785 * mms - 0.004_072_047 * sms
  const a = 1.977_998_495 * lms - 2.428_592_205 * mms + 0.450_593_71 * sms
  const bb = 0.025_904_037 * lms + 0.782_771_766 * mms - 0.808_675_766 * sms
  return {
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
    c: Math.hypot(a, bb),
    l: lightness,
  }
}

export const colorOfThumbHash = (hash: Uint8Array | null): PhotoColor | null => {
  if (!hash || hash.length < 5) {
    return null
  }
  try {
    const { rgba } = thumbHashToRGBA(hash)
    const pixels = rgba.length / 4
    let x = 0
    let y = 0
    let lightness = 0
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const pixel = rgbToOklch(rgba[offset] / 255, rgba[offset + 1] / 255, rgba[offset + 2] / 255)
      const angle = (pixel.h * Math.PI) / 180
      x += Math.cos(angle) * pixel.c
      y += Math.sin(angle) * pixel.c
      lightness += pixel.l
    }
    return {
      h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
      c: Math.hypot(x, y) / pixels,
      l: lightness / pixels,
    }
  }
  catch {
    return null
  }
}

export const hueDistance = (a: number, b: number) => {
  const distance = Math.abs(a - b) % 360
  return Math.min(distance, 360 - distance)
}

export const isNeutral = (color: PhotoColor | null) => !color || color.c < NEUTRAL_CHROMA

export const createColorCache = () => {
  const cache = new Map<string, PhotoColor | null>()
  return {
    colorsOf: (photos: { id: string, thumbHash: Uint8Array | null }[]) =>
      photos.map((photo) => {
        let color = cache.get(photo.id)
        if (color === undefined) {
          color = colorOfThumbHash(photo.thumbHash)
          cache.set(photo.id, color)
        }
        return color
      }),
  }
}
