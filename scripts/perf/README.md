# scripts/perf（本 PR 只加一个脚本）

完整说明见另一个 PR 引入的 `scripts/perf/README.md`；这里只放主 CSS 内联的产物断言。

## `check-inline-css.mjs` —— 内联 CSS 的**差分**断言

```bash
# 1) 正常构建（内联）
pnpm --filter @afilmory/web exec vite build

# 2) 参照构建（不内联）
INLINE_MAIN_CSS=0 pnpm --filter @afilmory/web exec vite build --outDir /tmp/ref-dist

# 3) 断言
node scripts/perf/check-inline-css.mjs apps/web/dist /tmp/ref-dist
```

它会检查：

1. 主 CSS 已从 `dist/assets/` 消失（不是复制了一份）；
2. HTML 里没有残留指向主 CSS 的 `<link>`；
3. **没有任何 chunk 或 asset 还引用被删掉的 CSS 文件名** —— 这是 `__vite__mapDeps` 那条
   「懒加载路由去请求一个不存在的文件」路径的防线。Cloudflare Pages 对缺失资源返回
   `200 text/html` 而不是 404，所以这种问题**不会报错、只会白下载整份 SPA shell**；
4. **内联进 HTML 的那段 CSS 与参照产物里那份 CSS 逐字节一致** —— 证明
   `vite.config.ts` 的 `minifyCSS: false` 生效、clean-css 没有把内联内容再压一遍。

第 4 条为什么必须是差分、不能写死 token 计数：写死 `@scope` 计数会在另一个 PR 合法地把
那段 CSS 从产物里去掉时误报（实测发生过 —— 把 DaisyUI 的 `join` utility 移出 `include:`
白名单后 `@scope` 自然就没了，而产物是对的）。

只传一个参数时退化成 1-3 条结构检查，并会明确提示「跳过了内容差分」。