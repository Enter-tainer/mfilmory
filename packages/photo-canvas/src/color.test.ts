import assert from 'node:assert/strict'

import { rgbaToThumbHash } from 'thumbhash'
import { it } from 'vitest'

import { colorOfThumbHash, hueDistance, rgbToOklch } from './color'

const solid = (r: number, g: number, b: number) => {
  const rgba = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba.set([r, g, b, 255], i)
  }
  return rgbaToThumbHash(16, 16, rgba)
}

const close = (actual: number, expected: number, tolerance: number) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`)

it('rgbToOklch reads pure red at the red hue angle with full chroma', () => {
  const red = rgbToOklch(1, 0, 0)
  close(red.h, 29.2, 1)
  close(red.c, 0.2577, 0.005)
  close(red.l, 0.628, 0.005)
})

it('rgbToOklch gives grey no chroma and keeps perceived lightness', () => {
  close(rgbToOklch(0.5, 0.5, 0.5).c, 0, 0.0005)
  close(rgbToOklch(0.5, 0.5, 0.5).l, 0.598, 0.01)
})

it('rgbToOklch keeps dark yellow lighter than bright blue', () => {
  assert.ok(rgbToOklch(0.8, 0.8, 0).l > rgbToOklch(0, 0, 0.9).l)
})

it('a blue thumbhash reads as a blue hue', () => {
  const color = colorOfThumbHash(solid(20, 40, 230))!
  assert.ok(hueDistance(color.h, 264) < 12, `hue ${color.h}`)
  assert.ok(color.c > 0.15)
})

it('a photo without a thumbhash has no colour', () => {
  assert.equal(colorOfThumbHash(null), null)
})

it('hue distance wraps around the colour wheel', () => {
  assert.equal(hueDistance(350, 10), 20)
})
