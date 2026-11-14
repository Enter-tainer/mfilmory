# 功能回归矩阵：同一组路由，分别在两个 dist（基线 / 待验证分支）上跑一遍并对比。
#
# 设计要点（每一条都是踩过的坑）：
#
# 1. 每个 (构建, 路由) 用**独立 agent-browser session** —— 否则 HTTP 缓存和已建立的连接
#    会把差异抹平：`/assets/*` 是 immutable 一年，基线跑过的资源在新构建上直接从缓存命中，
#    于是"删掉一个文件"这类回归完全测不出来。
#
# 2. 用 `--init-script console-capture.js` 在任何页面脚本之前接管 console /
#    uncaught / unhandledrejection / 资源加载失败。**不要**靠 `agent-browser console`：
#    它的缓冲语义不可靠（实测同一页面两次运行抓到的条数不同），拿它判「有没有新增 error」
#    会漏。
#
# 3. 快照必须拍在**稳定态**：网格/地图是渐进渲染的，两个构建到达时序不同，同一时刻挂载的
#    元素数不同 —— 不等到稳定态，比的是时序噪声。用 page-stable.js 轮询到「无 pending 图片
#    + 文本签名连续 3 次不变」。
#
# 4. viewport 用 `agent-browser set viewport <w> <h>`（**不是** `--viewport`，也不是
#    `agent-browser viewport` —— 那两个都不是有效命令，会被当成子命令报错。旧版脚本里
#    写成 `agent-browser ... viewport 1440 900` 并把 stderr 丢进 2>$null，
#    于是永远在默认 1258x566 下测、且没人发现）。
#
# 产出：<outDir>/<label>--<slug>.json / .png / .stable.txt / .open.txt
#
# 用法（先在别处起两个静态服务器服务两份 dist）:
#   node scripts/perf/spa-server.mjs <baseDist>  4811
#   node scripts/perf/spa-server.mjs <optDist>   4812
#   pwsh -NoProfile -File scripts/perf/verify-routes.ps1 -OutDir .perf/routes
#   node scripts/perf/diff-routes.mjs .perf/routes

param(
  [string]$OutDir = '.perf/routes',
  [int]$BasePort = 4811,
  [int]$OptPort = 4812,
  [int]$ViewportW = 1440,
  [int]$ViewportH = 900,
  [string]$Only = ''
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Split-Path -Parent $MyInvocation.MyCommand.Path) }

$probe = Get-Content -Raw (Join-Path $scriptDir 'page-probe.js')
$stable = Get-Content -Raw (Join-Path $scriptDir 'page-stable.js')
$initScript = Join-Path $scriptDir 'console-capture.js'

$out = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path (Get-Location).Path $OutDir }
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out -Force | Out-Null }

$routes = @(
  @{ slug = 'gallery'; path = '/' },
  @{ slug = 'filter-camera'; path = '/?cameras=SONY%20ILCE-7RM5' },
  @{ slug = 'deeplink'; path = '/photos/20261104-LKXG5370' },
  @{ slug = 'map'; path = '/map' },
  @{ slug = 'manifest-page'; path = '/manifest' }
)

$builds = @(
  @{ label = 'base'; port = $BasePort },
  @{ label = 'opt'; port = $OptPort }
)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$stableFailures = 0

foreach ($b in $builds) {
  foreach ($r in $routes) {
    if ($Only -and "$($b.label):$($r.slug)" -notlike $Only) { continue }
    $prefix = "$($b.label)--$($r.slug)"
    $session = "perf-routes-$base-$prefix"
    $url = "http://127.0.0.1:$($b.port)$($r.path)"

    & agent-browser --session $session close 2>$null | Out-Null

    # --init-script 必须在首次导航之前注册。注意：带 `--init-script` 的 open 会**重启浏览器**，
    # 把之前 set 的 viewport 重置回默认 1258x566 —— 所以 viewport 必须在 open **之后**设。
    $openOut = & agent-browser --session $session --init-script $initScript open $url 2>&1 | Out-String
    $openOut | Set-Content -Path (Join-Path $out "$prefix.open.txt") -Encoding utf8
    & agent-browser --session $session set viewport $ViewportW $ViewportH 2>&1 | Out-Null

    # 确认 viewport 真的生效了（不然又是「以为在 1440 下测、其实 1258」）
    $sizeOut = & agent-browser --session $session eval 'JSON.stringify({ w: innerWidth, h: innerHeight })' 2>&1 | Out-String
    $sizeOut | Set-Content -Path (Join-Path $out "$prefix.viewport.txt") -Encoding utf8

    & agent-browser --session $session wait --load load --timeout 20000 2>&1 | Out-Null
    $stableOut = & agent-browser --session $session wait --fn $stable --timeout 25000 2>&1 | Out-String
    $stableOk = $LASTEXITCODE -eq 0
    $stableOut | Set-Content -Path (Join-Path $out "$prefix.stable.txt") -Encoding utf8
    if (-not $stableOk) { $stableFailures++ }

    $probeOut = & agent-browser --session $session eval $probe 2>&1 | Out-String
    $probeOut | Set-Content -Path (Join-Path $out "$prefix.json") -Encoding utf8

    # 注意签名是 `screenshot [selector] [path]` —— 第一个位置参数是**选择器**，
    # 只传路径会被当成 selector（然后静默存到 tmp、用默认 viewport 拍）。传空串占位。
    & agent-browser --session $session screenshot '' (Join-Path $out "$prefix.png") 2>&1 | Out-Null

    & agent-browser --session $session close 2>$null | Out-Null
    $flag = if ($stableOk) { 'stable' } else { 'NOT-STABLE' }
    Write-Host "[$([int]$sw.Elapsed.TotalSeconds)s] $prefix done ($flag)"
  }
}

Write-Host "全部完成，用时 $([int]$sw.Elapsed.TotalSeconds)s，输出在 $out"
if ($stableFailures -gt 0) {
  Write-Host "⚠️  $stableFailures 个路由没有在稳定态拍下来（.stable.txt 里有原因）—— 对比结果的噪声会更大" -ForegroundColor Yellow
}
