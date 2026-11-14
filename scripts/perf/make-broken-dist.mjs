// 造一个「被破坏的产物」用来验证功能探针**真的有牙**：
// 把 dist 复制一份，再从 manifest 里砍掉 `location` 和第一版 PR 砍掉的那 16 个 exif 字段
// （精确复刻第一版拆分方案的错误），然后功能探针必须**失败**。
//
// 如果探针在破坏版上也全绿，那它就证明不了任何事。
//
// 用法: node scripts/perf/make-broken-dist.mjs <srcDist> <dstDist>
import fs from 'node:fs'
import path from 'node:path'

const src = process.argv[2]
const dst = process.argv[3]
if (!src || !dst) {
  console.error('usage: node scripts/perf/make-broken-dist.mjs <srcDist> <dstDist>')
  process.exit(64)
}

fs.rmSync(dst, { recursive: true, force: true })
fs.cpSync(src, dst, { recursive: true })

const manifestFiles = fs.readdirSync(dst).filter(f => /^photos-manifest.*\.json$/.test(f))
if (manifestFiles.length !== 1) {
  console.error(`期望 dst 里只有 1 份 manifest，实际 ${manifestFiles.length}`)
  process.exit(1)
}
const manifestPath = path.join(dst, manifestFiles[0])
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

// 第一版 `EXIF_FIELDS_FOR_INDEX` 白名单之外被砍掉的字段（这里只取几个关键的用来验证）
const DROPPED_EXIF = [
  'GPSAltitude', 'ExposureCompensation', 'ShutterSpeedValue', 'ExposureProgram',
  'BrightnessValue', 'Flash', 'ColorSpace', 'ExposureMode', 'MeteringMode',
  'WhiteBalance', 'SensingMethod', 'ScaleFactor35efl', 'LightValue', 'Software',
  'OffsetTime', 'tz',
]

let droppedLocation = 0
let droppedExifFields = 0
for (const photo of manifest.data) {
  if (photo.location) {
    delete photo.location
    droppedLocation++
  }
  if (photo.exif) {
    for (const key of DROPPED_EXIF) {
      if (key in photo.exif) {
        delete photo.exif[key]
        droppedExifFields++
      }
    }
  }
  // toneAnalysis / keywords / regions / s3Key 第一版也挪去了 detail
  delete photo.toneAnalysis
  delete photo.keywords
  delete photo.regions
  delete photo.s3Key
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

// 注意：HTML 里的 __MANIFEST_URL__ 是带内容 hash 的文件名，改内容不影响文件名匹配，
// 因为这里直接覆盖同名文件。
console.log(`已生成破坏版：${dst}`)
console.log(`  manifest: ${manifestFiles[0]}`)
console.log(`  砍掉 location 的照片: ${droppedLocation}`)
console.log(`  砍掉 exif 子字段次数: ${droppedExifFields}`)
console.log('  另外还删了 toneAnalysis / keywords / regions / s3Key（第一版也都挪走了）')
