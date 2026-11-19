import { readFileSync } from 'node:fs'
import process from 'node:process'

import { thumbHashToAverageRGBA } from 'thumbhash'
import type { Plugin } from 'vite'

import type { SiteConfig } from '../../../../site.config'
import { MANIFEST_PATH } from './__internal__/constants'

const PRERENDER_PHOTO_COUNT = 36
const ROOT_OPEN = '<div id="root">'
const SSG_SLOT = '<div id="ssg-slot"></div>'

interface RawPhoto {
  id?: unknown
  title?: unknown
  thumbnailUrl?: unknown
  aspectRatio?: unknown
  thumbHash?: unknown
  lastModified?: unknown
  exif?: { DateTimeOriginal?: unknown } | null
}

type PrerenderPhotoTuple = [
  id: string,
  src: string,
  aspectRatio: number,
  title: string,
  avgHex: string,
]

interface PrerenderPayload {
  b: string
  p: PrerenderPhotoTuple[]
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')

const escapeInlineJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')

function resolveSocialUrl(
  value: string,
  { baseUrl, stripAt }: { baseUrl: string, stripAt?: boolean },
): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  const normalized = stripAt ? trimmed.replace(/^@/, '') : trimmed
  return normalized ? `${baseUrl}${normalized}` : undefined
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

function decodeThumbHashHex(thumbHash: unknown): string {
  try {
    let bytes: Uint8Array | ArrayLike<number> | null = null
    if (typeof thumbHash === 'string' && thumbHash.length >= 2) {
      const pairs = thumbHash.match(/.{1,2}/g)
      if (!pairs) {
        return ''
      }
      bytes = Uint8Array.from(pairs.map(b => Number.parseInt(b, 16)))
    }
    else if (Array.isArray(thumbHash) && thumbHash.length > 0) {
      bytes = thumbHash as number[]
    }
    if (!bytes) {
      return ''
    }
    const { r, g, b } = thumbHashToAverageRGBA(bytes)
    const hex = (n: number) => clampByte(n).toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  catch {
    return ''
  }
}

function longestCommonDirPrefix(urls: string[]): string {
  if (urls.length === 0) {
    return ''
  }
  let prefix = urls[0]
  for (let i = 1; i < urls.length; i++) {
    const url = urls[i]
    let len = Math.min(prefix.length, url.length)
    for (let j = 0; j < len; j++) {
      if (prefix[j] !== url[j]) {
        len = j
        break
      }
    }
    prefix = prefix.slice(0, len)
    if (!prefix) {
      return ''
    }
  }
  const lastSlash = prefix.lastIndexOf('/')
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : ''
}

function readTopPhotos(): { totalCount: number, payload: PrerenderPayload } {
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as { data?: RawPhoto[] }
    const photos = Array.isArray(raw.data) ? raw.data : []
    const dateKey = (photo: RawPhoto) => {
      const original = photo.exif?.DateTimeOriginal
      if (typeof original === 'string' && original.length > 0) {
        return original
      }
      return typeof photo.lastModified === 'string' ? photo.lastModified : ''
    }

    const valid = photos
      .filter((p): p is RawPhoto & { id: string, thumbnailUrl: string, aspectRatio: number } =>
        typeof p.id === 'string'
        && p.id.length > 0
        && typeof p.thumbnailUrl === 'string'
        && p.thumbnailUrl.length > 0
        && typeof p.aspectRatio === 'number'
        && Number.isFinite(p.aspectRatio)
        && p.aspectRatio > 0)
      .map(photo => ({ photo, key: dateKey(photo) }))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, PRERENDER_PHOTO_COUNT)
      .map(({ photo }) => photo)

    const base = longestCommonDirPrefix(valid.map(p => p.thumbnailUrl))
    const tuples: PrerenderPhotoTuple[] = valid.map(p => [
      p.id,
      base && p.thumbnailUrl.startsWith(base) ? p.thumbnailUrl.slice(base.length) : p.thumbnailUrl,
      p.aspectRatio,
      typeof p.title === 'string' ? p.title : p.id,
      decodeThumbHashHex(p.thumbHash),
    ])

    return {
      totalCount: photos.length,
      payload: { b: base, p: tuples },
    }
  }
  catch (error) {
    console.warn('[prerender-gallery] failed to read manifest, keeping splash fallback:', error)
    return { totalCount: 0, payload: { b: '', p: [] } }
  }
}

function buildStaticHeader(siteConfig: SiteConfig, totalCount: number): string {
  const siteName = escapeHtml(siteConfig.name)
  const avatarSrc = siteConfig.author?.avatar ? escapeHtml(siteConfig.author.avatar) : ''
  const avatarAlt = escapeHtml(siteConfig.author?.name ?? siteConfig.name)
  const githubUrl = siteConfig.social?.github
    ? resolveSocialUrl(siteConfig.social.github, { baseUrl: 'https://github.com/' })
    : undefined
  const twitterUrl = siteConfig.social?.twitter
    ? resolveSocialUrl(siteConfig.social.twitter, { baseUrl: 'https://twitter.com/', stripAt: true })
    : undefined

  const avatarHtml = avatarSrc
    ? `<span class="relative flex size-7 shrink-0 overflow-hidden rounded-lg lg:size-8"><img src="${avatarSrc}" class="size-7 rounded-lg lg:size-8" alt="${avatarAlt}" width="96" height="96" decoding="async" fetchpriority="low"></span>`
    : `<div class="flex size-7 items-center justify-center rounded-lg bg-white/10 lg:size-8"><i class="i-mingcute-camera-2-line text-sm text-white/60 lg:text-base"></i></div>`

  const socialLinksHtml = [
    githubUrl
      ? `<a href="${escapeHtml(githubUrl)}" target="_blank" rel="noreferrer" class="inline-flex size-6 items-center justify-center rounded text-white/40 transition-colors duration-200 hover:text-white/80 lg:size-7" title="GitHub"><i class="i-mingcute-github-fill text-sm lg:text-base"></i></a>`
      : '',
    twitterUrl
      ? `<a href="${escapeHtml(twitterUrl)}" target="_blank" rel="noreferrer" class="inline-flex size-6 items-center justify-center rounded text-white/40 transition-colors duration-200 hover:text-white/80 lg:size-7" title="Twitter"><i class="i-mingcute-twitter-fill text-sm lg:text-base"></i></a>`
      : '',
    `<a href="/feed.xml" target="_blank" rel="noreferrer" class="inline-flex size-6 items-center justify-center rounded text-white/40 transition-colors duration-200 hover:text-white/80 lg:size-7" title="RSS"><i class="i-mingcute-rss-2-fill text-sm lg:text-base"></i></a>`,
  ]
    .filter(Boolean)
    .join('')

  return `<header class="fixed top-0 right-0 left-0 z-100"><div class="pointer-events-none absolute inset-x-0 z-[-1] h-15" style="background:linear-gradient(to bottom,var(--color-background,#1c1c1e) 0%,transparent 100%)"></div><div class="flex h-12 items-center justify-between gap-2 px-3 lg:h-12 lg:gap-3 lg:px-4"><div class="flex items-center gap-2">${avatarHtml}<div class="flex items-center gap-1.5"><h1 class="truncate text-sm font-semibold text-white lg:text-base">${siteName}</h1><span class="text-xs text-white/40 lg:text-sm">${totalCount}</span></div><div class="ml-1 hidden items-center gap-1 border-l border-white/10 pl-2 lg:flex">${socialLinksHtml}</div></div><div class="flex items-center gap-1.5 lg:gap-2"><div class="bg-material-medium/40 relative hidden h-7 items-center gap-0.5 rounded-lg p-0.5 lg:flex lg:h-8 lg:gap-1 lg:p-1"><button type="button" class="relative z-10 flex h-full items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors duration-200 lg:px-4 text-white" aria-label="Masonry"><span class="absolute inset-0 rounded-md bg-white/15 shadow-sm"></span><i class="i-mingcute-grid-line relative z-10 text-sm lg:text-base"></i></button><button type="button" class="relative z-10 flex h-full items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors duration-200 lg:px-4 text-white/60 hover:text-white/80" aria-label="List"><i class="i-mingcute-list-ordered-line relative z-10 text-sm lg:text-base"></i></button></div><div class="flex items-center gap-1 lg:gap-1.5"><div class="bg-material-medium/40 flex items-center gap-1 rounded-lg"><button type="button" data-ssg-action="cmdk" class="relative flex size-7 items-center justify-center rounded text-white/60 transition-all duration-200 hover:bg-white/10 hover:text-white lg:size-8" aria-label="Search"><i class="i-mingcute-search-line text-sm lg:text-base"></i></button><a href="/map" data-ssg-action="map" class="relative hidden size-7 items-center justify-center rounded text-white/60 transition-all duration-200 hover:bg-white/10 hover:text-white lg:flex lg:size-8" aria-label="Map"><i class="i-mingcute-map-pin-line text-sm lg:text-base"></i></a><button type="button" class="relative flex size-7 items-center justify-center rounded text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:size-8" aria-label="View"><i class="i-mingcute-layout-grid-line text-sm lg:text-base" aria-hidden="true"></i></button><button type="button" class="relative flex size-7 items-center justify-center rounded text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:size-8" aria-label="Language"><i class="i-mingcute-translate-2-line text-sm lg:text-base" aria-hidden="true"></i></button><button type="button" class="relative flex size-7 items-center justify-center rounded text-white/60 transition-colors duration-200 hover:bg-white/10 hover:text-white lg:hidden" aria-label="More options"><i class="i-mingcute-more-2-line text-lg" aria-hidden="true"></i></button></div></div></div></div></header>`
}

function buildSsgInitScript(payload: PrerenderPayload): string {
  const payloadJson = escapeInlineJson(payload)
  return `(function(){
var sh=document.getElementById('ssg-shell');
var st=document.getElementById('ssg-style');
function drop(){if(sh&&sh.parentNode)sh.parentNode.removeChild(sh);if(st&&st.parentNode)st.parentNode.removeChild(st);}
if(location.pathname!=='/'||location.search){drop();return;}
var grid=document.getElementById('ssg-grid');
if(!sh||!grid)return;
var D=${payloadJson};
var w=window.innerWidth,h=window.innerHeight,mob=w<1024,g=4;
var gridW=grid.offsetWidth||(mob?w-8:w);
var avail=w-(mob?8:32),minW=mob?150:250;
if(!mob){var mc=Math.floor((avail+g)/(minW+g));if(mc>8)minW=(avail-7*g)/8;}
var colCount=Math.floor((gridW+g)/(minW+g))||1;
var colW=Math.floor((gridW-g*(colCount-1))/colCount);
var ch=[],placed=[],i,k;
for(i=0;i<colCount;i++)ch.push(0);
for(i=0;i<D.p.length;i++){
  var row=D.p[i],minC=0;
  for(k=1;k<colCount;k++)if(ch[k]<ch[minC])minC=k;
  var top=ch[minC],left=minC*(colW+g),ih=colW/row[2];
  ch[minC]=top+Math.round(ih)+g;
  placed.push({i:i,id:row[0],src:row[1].indexOf('://')!==-1?row[1]:D.b+row[1],ih:ih,title:row[3],bg:row[4],left:left,top:top});
  var allFilled=1;
  for(k=0;k<colCount;k++)if(ch[k]<h){allFilled=0;break;}
  if(allFilled)break;
}
var lcpIdx=0,bestArea=-1,visBottom=h-52;
for(i=0;i<placed.length;i++){
  var it=placed[i],visH=Math.max(0,Math.min(it.top+it.ih,visBottom)-it.top);
  var area=colW*visH;
  if(area>bestArea){bestArea=area;lcpIdx=i;}
}
var frag=document.createDocumentFragment();
for(i=0;i<placed.length;i++){
  var t=placed[i];
  var a=document.createElement('a');
  a.href='/photos/'+encodeURIComponent(t.id);
  a.setAttribute('data-ssg-photo',t.id);
  a.className='bg-fill-quaternary relative overflow-hidden';
  a.style.cssText='position:absolute;left:'+t.left+'px;top:'+t.top+'px;width:'+colW+'px;height:'+t.ih+'px;display:block;cursor:pointer'+(t.bg?';background-color:'+t.bg:'');
  var img=document.createElement('img');
  img.src=t.src;
  img.alt=t.title;
  img.loading=(t.i<4||t.i===lcpIdx)?'eager':'lazy';
  img.decoding='async';
  if(t.i<4||t.i===lcpIdx)img.setAttribute('fetchpriority','high');
  img.className='absolute inset-0 h-full w-full object-cover';
  a.appendChild(img);
  frag.appendChild(a);
}
grid.appendChild(frag);
var maxH=0;for(k=0;k<colCount;k++)if(ch[k]>maxH)maxH=ch[k];
grid.style.height=maxH+'px';
sh.addEventListener('click',function(e){
  if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;
  var el=e.target&&e.target.closest?e.target.closest('[data-ssg-photo],[data-ssg-action]'):null;
  if(!el)return;
  e.preventDefault();
  var pid=el.getAttribute('data-ssg-photo');
  if(pid){window.__SSG_PENDING_ACTION__={type:'photo',id:pid};el.style.opacity='0.75';return;}
  var act=el.getAttribute('data-ssg-action');
  if(act==='cmdk'||act==='map'){window.__SSG_PENDING_ACTION__={type:act};}
});
})();`
}

function buildNoscriptFallback(payload: PrerenderPayload): string {
  if (payload.p.length === 0) {
    return ''
  }
  const tiles = payload.p
    .slice(0, 12)
    .map(([id, relOrUrl, ar, title, bg]) => {
      const src = escapeHtml(relOrUrl.includes('://') ? relOrUrl : payload.b + relOrUrl)
      const bgStyle = bg ? `;background:${bg}` : ''
      return `<a href="/photos/${encodeURIComponent(id)}" style="display:block;overflow:hidden;aspect-ratio:${ar}${bgStyle}"><img src="${src}" alt="${escapeHtml(title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block"></a>`
    })
    .join('')
  return `<noscript><style>#ssg-shell{position:static!important;min-height:100vh}#ssg-scroll{height:auto!important;overflow:visible!important}</style><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px;padding:52px 4px 24px">${tiles}</div></noscript>`
}

export function prerenderGalleryPlugin(siteConfig: SiteConfig): Plugin {
  const enabled = process.env.PRERENDER_SHELL !== '0'
  let cached: { totalCount: number, payload: PrerenderPayload } | null = null

  return {
    name: 'afilmory:prerender-gallery',
    apply: 'build',

    buildStart() {
      if (!enabled) {
        return
      }
      cached = readTopPhotos()
    },

    transformIndexHtml(html) {
      if (!html.includes(SSG_SLOT)) {
        return html
      }

      if (!enabled) {
        return html.replace(SSG_SLOT, '')
      }

      const data = cached ?? (cached = readTopPhotos())
      if (data.payload.p.length === 0) {
        return html.replace(SSG_SLOT, '')
      }

      const rootStart = html.indexOf(ROOT_OPEN)
      const slotStart = html.indexOf(SSG_SLOT)
      if (rootStart === -1 || slotStart === -1 || slotStart < rootStart) {
        return html.replace(SSG_SLOT, '')
      }

      const headerHtml = buildStaticHeader(siteConfig, data.totalCount)
      const initScript = buildSsgInitScript(data.payload)
      const noscript = buildNoscriptFallback(data.payload)
      const shellHtml = `<style id="ssg-style">#ssg-scroll::-webkit-scrollbar{display:none}</style><div id="ssg-shell" style="position:fixed;inset:0;z-index:200;background:var(--color-background,#1c1c1e)">${headerHtml}<div id="ssg-scroll" class="h-svh w-full" style="overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none"><div class="p-1 lg:px-0 pb-20 lg:pb-24 mt-12"><div id="ssg-grid" style="position:relative;width:100%"></div></div></div></div><script id="ssg-init">${initScript}</script>${noscript}`

      return `${html.slice(0, rootStart)}<div id="root"></div>${shellHtml}${html.slice(slotStart + SSG_SLOT.length)}`
    },
  }
}
