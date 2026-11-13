// 注意：这里**不能**静态 import 'maplibre-gl'。
// 之前这个文件在模块作用域里调用 setWorkerUrl()，导致任何引用它的模块（MiniMap →
// ~/modules/metadata barrel → 首屏 grid）都会把整个 maplibre-gl 拽进首屏 chunk，
// 顺带让所有 `import('maplibre-gl')` 都变成无效动态导入。
// 现在只导出 worker 的 URL，注册由真正创建地图的惰性 chunk 自己完成
// （见 components/ui/map/MapLibre.tsx 与 modules/metadata/MiniMap.tsx）。
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

export { mapLibreWorkerUrl }
