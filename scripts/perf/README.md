# scripts/perf — 首屏性能的测量与回归脚本

这些脚本是性能 PR（`perf/*` 分支）的验收依据。它们**只读**：不写存储、不改仓库，
输出落在 gitignore 的 `.perf/` 下。

> ⚠️ **永远不要为了跑这些脚本而执行 `pnpm build`**
> 根 `pnpm build` 会先跑 `precheck()` → `@afilmory/builder cli`，也就是整条照片流水线：
> 从 S3 全量下载原图、重新生成缩略图/占位图/OG 图，然后**上传回存储桶**。
> 纯前端改动做 A/B 只需要 `pnpm --filter @afilmory/web exec vite build`（不碰存储）。

## 一次性准备

```bash
# 1. 各构建一份（在各自的 worktree 里；不要在同一个目录里来回切分支）
pnpm --filter @afilmory/web exec vite build

# 2. 起两个静态服务器（模拟 Cloudflare Pages：未知路径回 index.html、正确 MIME、正确缓存头）
node scripts/perf/spa-server.mjs <baseDist目录> 4811 &
node scripts/perf/spa-server.mjs <optDist目录>  4812 &
```

## 三个验收维度

### 1. 字节账 —— `critical-bytes.mjs`

```bash
node scripts/perf/critical-bytes.mjs <dist目录> "标签"
```

列出 HTML / CSS / 入口 JS（含 modulepreload）/ manifest / 字体各自的原始字节与 brotli-11 字节，
以及首屏 `preload as=image` 与 `preconnect` 的数量。

**它回答**：关键路径代码字节变了多少。
**它不回答**：线上快了多少（那是 RUM/受控 A/B 的事）；也不含同屏的缩略图（约 700 KB，
走 R2 且不随代码变化）。

### 2. manifest 完整性 —— `assert-manifest-fields.mjs`

```bash
node scripts/perf/assert-manifest-fields.mjs apps/web/src/data/photos-manifest.json <dist目录>
```

把**源** manifest 和**实际下发给浏览器**的那份逐照片、逐字段、逐 exif 子字段比对，
只允许 `ALLOWED_MISSING`（当前是 `digest` / `ogImageUrl`）里的字段缺失。

**它回答**：数据有没有被裁掉。
**它不回答**：渲染路径有没有坏 —— 那是下面第 3 条。

### 3. 渲染路径 —— `probe-manifest-fields.mjs`（最重要）
```bash
node scripts/perf/probe-manifest-fields.mjs 4812 opt
```

走真实交互，断言 DOM 里真的出现了这些值：

| 路径 | 读者 | 断言 |
|---|---|---|
| 列表视图 | `ListView.tsx` 的 `photo.location.locationName` | 位置行有地址文本 |
| 深链 viewer 的 EXIF 面板 | `ExifPanel.tsx` 的 `photo.location` / `exif.GPSAltitude` | GPS 段落有地址与海拔 |
| Cmd-K 搜索 | `CommandPalette.tsx` 的 `photo.location` | 按城市名能搜到照片 |

**为什么必须单独做这一条**：网格页的 `document.body.textContent` 里**不含 location**
（hover 卡只显示标题/尺寸/大小/焦距/光圈/快门/ISO）。只比网格文本，砍掉 `location`
照样「全绿」—— 第一版 PR 就是这么漏的。

用 `make-broken-dist.mjs` 可以造一份「故意砍掉 location + 16 个 exif 字段」的产物，
用来验证这个探针**真的有牙**（它必须失败）：

```bash
node scripts/perf/make-broken-dist.mjs <正常dist> /tmp/broken-dist
node scripts/perf/spa-server.mjs /tmp/broken-dist 4831 &
node scripts/perf/probe-manifest-fields.mjs 4831 BROKEN   # 期望 exit 1
```

## 全路由矩阵（可选，慢一点）

```bash
pwsh -NoProfile -File scripts/perf/verify-routes.ps1 -OutDir .perf/routes
node scripts/perf/diff-routes.mjs .perf/routes
```

跑 `/`、`/?cameras=…`、`/photos/:id`、`/map`、`/manifest` 五条路由 × 两套构建，
每条路由用**独立浏览器 session**（否则 HTTP 缓存会把差异抹平），
用 `--init-script console-capture.js` 在页面脚本之前接管 console / `error` /
`unhandledrejection` / 资源加载失败，快照拍在稳定态（无 pending 图片 + 文本签名连续 3 次不变）。

`diff-routes.mjs` 的硬性判据只包含**基线自己跑 3 次也稳定**的指标 —— 这是先用同一份构建
跑 3 遍量出来的噪声底线，不是拍脑袋定的。**换了 viewport 就要重新量噪声底线**（默认
viewport 是 1258×566，脚本会设成 1440×900 并把实测值写进 `.viewport.txt`）。

## 其它专项脚本

| 脚本 | 用途 |
|---|---|
| `bytes-accounting.mjs` | 关键路径字节账，**兼容 CSS 内联与外链**（`critical-bytes.mjs` 只算外链，一旦有 PR 把 CSS 内联，用那个会算错）。支持一次比两个 dist。 |
| `check-preload-reuse.mjs` | 逐路由核对 HTML 里 `preload as=image` 的那几张有没有被 `<img>` 真正复用。实测 `/` 与 `/photos/:id` 是 4/4，`/?cameras=…` 与 `/map` 是 0/4（那两张页面首屏不是默认排序的网格）。 |
| `compare-overscan.mjs` | 同一份代码在一组 `overscanBy` 取值下的首屏挂载数 / 缩略图请求数（1440×900 与 390×844）。 |
| `check-scroll-gaps.mjs` + `scroll-gap-probe.js` | 快速跳转滚动后「恢复覆盖」的耗时。**注意**：写成「跳转后同步立刻采样」是错的 —— 那测的是跳转前的 DOM，任何 overscanBy 都会得到 0% 覆盖。 |
| `check-daisyui-utilities.mjs` | 按「类名位置」精确扫 daisyui 的组件/工具类有没有被真正使用（`Array.prototype.join` 之类的同名 API 不算）。 |
| `check-plugins-typecheck.mjs` | 临时把 `apps/web/plugins` 纳入 type-check 跑一遍 —— `tsconfig.json` 默认不含它，插件里的类型错误只有 CI/构建才可能发现。 |
| `check-block-comments.mjs` | 扫「块注释里出现 `*/`」的情况。典型踩法：在 `/** … */` 里写 glob 如 `plugins/**/*`，其中的 `*/` 会提前闭合注释，后面一串中文被当代码解析，报一堆 TS1005/TS1109。 |
| `make-broken-dist.mjs` | 造一份「故意砍掉 location + 16 个 exif 字段」的产物，验证 `probe-manifest-fields.mjs` 真的有牙（它必须失败）。 |

## 已知的测量陷阱（都踩过）

1. **`agent-browser` 默认 viewport 是 1258×566**。`viewport` 不是子命令（正确写法是
   `set viewport <w> <h>`），写错会被 `2>$null` 静默吞掉，于是「以为在 1440×900 下测」其实一直在
   默认尺寸下测。
2. **带 `--init-script` 的 `open` 会重启浏览器**，把之前设的 viewport 重置。所以 viewport 必须
   在 `open` **之后**设，并回读 `innerWidth/innerHeight` 确认。
3. **`screenshot` 的签名是 `screenshot [selector] [path]`**，只传路径会被当成选择器，截图
   静默落到临时目录并用默认 viewport 拍。要传空串占位。
4. **`Math.random()` 会让布局本身不稳定**：`apps/web/src/modules/gallery/Masonic.tsx` 在
   `shrunk` 时会用 `Math.random() + positionIndex` 重建 positioner，所以网格的渲染顺序/DOM
   顺序在两次运行之间可能不同。判据只能落在「集合重合度」「marker 数」「GPS 位置数」这类
   与顺序无关的量上。
5. **`/manifest` 是调试页**，会一次性加载 369 张远程缩略图；实测同一份构建连跑三次，
   两侧都会随机出现 0 / 1 / 27 张瞬时失败（HEAD 那些 URL 都是 200，是并发被限流）。
   所以这一页的「破图 / 资源加载失败」只作提示。

## 依赖

需要 `agent-browser`（浏览器自动化 CLI）与 Node 18+。Windows 上 `agent-browser` 是 `.CMD`
包装器，脚本里已经处理好（`eval` 走 `--stdin` 避免 shell 转义问题）。
