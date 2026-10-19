/** VitePress configuration for the locally projected documentation site. */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DefaultTheme, HeadConfig, PageData, SiteConfig } from 'vitepress'
import type { ViteDevServer } from 'vite'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { collections, landingLink, orderedPages, routeLink, sectionSpec, type DocsPage, type DocsSidebar } from '../docs.ts'
import { docsSourceFiles, emitRawMarkdownPages, llmsTxt, projectDocs, rawMarkdownRoute } from '../../scripts/project-doc-site.ts'
import { codeBlockKind, decorateFenceHtml, normalizeCommand } from './code-blocks.ts'

projectDocs()

function sidebar(collection: NonNullable<DocsPage['sidebar']>): DefaultTheme.SidebarItem[] {
  // `orderedPages` already sorts by section placement, so insertion order
  // carries the group order and each group keeps its pages in sequence.
  const groups = new Map<string, DocsPage[]>()
  for (const page of orderedPages(collection)) {
    const entries = groups.get(page.section) ?? []
    entries.push(page)
    groups.set(page.section, entries)
  }
  return [...groups.entries()].map(([text, entries]) => {
    const { collapsed } = sectionSpec(text)
    return {
      text,
      // A present `collapsed` is what makes the default theme render the
      // group as collapsible at all, so an open group must omit the key.
      ...(collapsed === undefined ? {} : { collapsed }),
      items: entries.map(page => ({ text: page.label, link: routeLink(page.route) })),
    }
  })
}

/** One module link shared between the navigation bar and the guide sidebar. */
interface GuideModuleLink {
  /** Label shown in the navigation bar and the guide sidebar. */
  label: string
  /** Sidebar collection the link opens. */
  collection: DocsSidebar
}

/**
 * Guide-module facts, giving every module label and collection one home shared
 * by the navigation bar and the guide sidebar.
 */
const guideModules = {
  guide: collections[0],
  develop: { label: 'Development', collection: collections[1] },
  reference: { label: 'Reference', collection: collections[2] },
} satisfies {
  /** Guide sidebar collection. */
  guide: DocsSidebar
  /** Development module link. */
  develop: GuideModuleLink
  /** Reference module link. */
  reference: GuideModuleLink
}

/**
 * Guide sidebar with direct links into the first development and reference pages.
 *
 * @returns Guide groups followed by top-level links to the other documentation modules.
 */
function guideSidebar(): DefaultTheme.SidebarItem[] {
  const { guide, develop, reference } = guideModules
  return [
    ...sidebar(guide),
    ...[develop, reference].map(({ label, collection }) => ({
      text: label,
      link: landingLink(collection),
    })),
  ]
}

/**
 * Navigation-bar items for the modules the guide sidebar links into, reading
 * their labels and collections from the shared record.
 *
 * @returns The module items for the navigation bar.
 */
function moduleNav(): DefaultTheme.NavItem[] {
  const { develop, reference } = guideModules
  return [
    { text: develop.label, link: landingLink(develop.collection), activeMatch: '^/develop/' },
    { text: reference.label, link: landingLink(reference.collection), activeMatch: '^/reference/' },
  ]
}

function watchCanonicalDocs(server: ViteDevServer): void {
  const sources = docsSourceFiles()
  server.watcher.add(sources)
  server.watcher.on('change', (changed) => {
    if (!sources.includes(changed)) return
    projectDocs()
  })
}

/**
 * Serve the raw-Markdown twin of each route and llms.txt during development,
 * matching what `buildEnd` emits into the static build. Pages project from
 * their canonical sources per request, so an edit shows without a rebuild.
 */
function serveRawMarkdown(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    if (req.url === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next()
      return
    }
    // The dev client imports page modules at these same `.md` URLs, and a
    // module script must reach Vite's transform. Browsers declare the purpose:
    // `script` for module imports, `document` for address-bar navigation.
    // Header-less clients (curl, agents) read the raw twin. In-page fetch()
    // (`empty`) also passes to Vite — a deliberate dev-only divergence that
    // keeps Vite's own requests unbroken, while production static hosting
    // answers such a fetch with the raw file.
    const fetchDest = req.headers['sec-fetch-dest']
    if (fetchDest !== undefined && fetchDest !== 'document') {
      next()
      return
    }
    const pathname = req.url.split(/[?#]/, 1)[0] ?? ''
    const sitePath = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, '')
    if (sitePath === 'llms.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(llmsTxt({ base, ...siteIdentity }))
      return
    }
    const content = sitePath.endsWith('.md') ? rawMarkdownRoute(sitePath) : undefined
    if (content === undefined) {
      next()
      return
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.end(content)
  })
}

function escapeVueInterpolation(html: string): string {
  return html.replaceAll('{{', '&#123;&#123;').replaceAll('}}', '&#125;&#125;')
}

/** Site base path, carrying the leading and trailing slashes VitePress requires. */
const base = process.env.DOCS_BASE ?? '/'

/** Site identity shared by the VitePress configuration and the llms.txt index. */
const siteUrl = 'https://guide.hydra.maihongphong.engineer/'

const siteIdentity = {
  title: 'Hydra harness',
  description: 'Open-source agent workspace for Web UI, desktop, CLI, browser tools, durable sessions, and Cordis plugins.',
}

/**
 * The product wordmark, inlined so its `currentColor` fills follow the active
 * theme. An `<img>` would freeze the mark at the colors the file declares.
 */
const wordmark = readFileSync(resolve(import.meta.dirname, '../public/wordmark.svg'), 'utf8')
  .trim()
  .replace('<svg ', '<svg class="hydra-wordmark" ')
  .replace('href="hydra.png"', `href="${base}hydra.png"`)
  .replace('href="hydra-hover.webp"', `href="${base}hydra-hover.webp"`)

/**
 * Styles the default theme does not provide, carried inline because the site
 * runs the stock theme with no theme directory of its own.
 *
 * The navigation-bar lockup pairs with `siteTitle`. The scrollbar rules replace
 * the sidebar's platform bar, which reserves 15px of a 265px column and draws a
 * track the rest of the navigation has no border for; `scrollbarScript` supplies
 * the marker that reveals the thumb. Chrome drops `::-webkit-scrollbar` once
 * `scrollbar-width` is set to anything but `auto`, so the standard properties
 * stay behind a query only Firefox answers.
 */
const siteStyle = `
:root {
  --hydra-azure: #009afc;
  --hydra-blue: #0060e0;
  --hydra-navy: #00123f;
  --hydra-ice: #c7e8ff;
  --hydra-white: #fdfdfd;
}
.hydra-lockup { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.hydra-wordmark { display: block; height: 22px; width: auto; color: var(--vp-c-text-1); }
@media (hover: hover) {
  .hydra-wordmark:hover .hydra-still { visibility: hidden; }
  .hydra-wordmark:hover .hydra-motion { display: inline; }
}
.hydra-tag {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  color: var(--vp-c-brand-1);
}

.VPPage {
  max-width: 1152px;
  margin: 0 auto;
  padding: 16px 24px 72px;
  color: var(--vp-c-text-1);
}
.VPPage h2 {
  margin: 48px 0 16px;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.VPPage h3 {
  margin: 32px 0 12px;
  font-size: 1.2rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.VPPage p, .VPPage ul, .VPPage ol {
  font-size: 1rem;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
.VPPage p { margin: 16px 0; }
.VPPage ul, .VPPage ol { padding-left: 24px; margin: 16px 0; }
.VPPage li { margin: 6px 0; }
.VPPage table {
  width: 100%;
  margin: 24px 0;
  border-collapse: collapse;
  font-size: 0.95rem;
}
.VPPage th, .VPPage td {
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}
.VPPage th {
  background-color: var(--vp-c-bg-soft);
  font-weight: 600;
}
.VPPage a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.VPPage a.hydra-home-button,
.VPPage a.hydra-feature-card {
  text-decoration: none;
}
@media (max-width: 768px) {
  .VPPage { padding: 12px 16px 48px; }
  .VPPage table { display: block; overflow-x: auto; }
}
.VPPage [class*='language-'] {
  position: relative;
  margin: 16px 0;
  background-color: var(--vp-code-block-bg);
  overflow-x: auto;
  border-radius: 8px;
}
.VPPage [class*='language-'] pre {
  position: relative;
  z-index: 1;
  margin: 0;
  padding: 20px 0;
  background: transparent;
  overflow-x: auto;
}
.VPPage [class*='language-'] code {
  display: block;
  padding: 0 24px;
  width: fit-content;
  min-width: 100%;
  line-height: var(--vp-code-line-height);
  font-size: var(--vp-code-font-size);
  color: var(--vp-code-block-color);
}
.VPPage [class*='language-'] > button.copy {
  direction: ltr;
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3;
  border: 1px solid var(--vp-code-copy-code-border-color);
  border-radius: 4px;
  width: 40px;
  height: 40px;
  background-color: var(--vp-code-copy-code-bg);
  opacity: 0;
  cursor: pointer;
  background-image: var(--vp-icon-copy);
  background-position: 50%;
  background-size: 20px;
  background-repeat: no-repeat;
  transition: border-color 0.25s, background-color 0.25s, opacity 0.25s;
}
.VPPage [class*='language-']:hover > button.copy,
.VPPage [class*='language-'] > button.copy:focus {
  opacity: 1;
}
.VPPage [class*='language-'] > span.lang {
  position: absolute;
  top: 2px;
  right: 8px;
  z-index: 2;
  font-size: 12px;
  font-weight: 500;
  user-select: none;
  color: var(--vp-code-lang-color);
  transition: color 0.4s, opacity 0.4s;
}
.VPPage [class*='language-']:hover > button.copy + span.lang,
.VPPage [class*='language-'] > button.copy:focus + span.lang {
  opacity: 0;
}

.hydra-home-hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 24px;
  overflow: hidden;
  margin: 8px 0 44px;
  padding: clamp(28px, 6vw, 56px);
  border: 1px solid rgba(0, 154, 252, 0.55);
  border-radius: 12px;
  background:
    radial-gradient(circle at 84% 20%, rgba(0, 154, 252, 0.42), transparent 32%),
    linear-gradient(135deg, #00123f 0%, #07335c 56%, #006ead 100%);
  box-shadow: 0 20px 60px rgba(0, 18, 63, 0.28);
  color: #ffffff;
}
.hydra-home-hero::before {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(rgba(199, 232, 255, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(199, 232, 255, 0.08) 1px, transparent 1px);
  background-size: 16px 16px;
  content: '';
  mask-image: linear-gradient(135deg, black, transparent 75%);
  pointer-events: none;
}
.hydra-home-copy, .hydra-home-mark { position: relative; z-index: 1; }
.hydra-home-hero .hydra-home-eyebrow {
  margin: 0 0 12px !important;
  color: #63c7ff !important;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.hydra-section-kicker {
  margin: 0 0 10px;
  color: var(--vp-c-brand-1);
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.hydra-home-hero h1 {
  max-width: 650px;
  margin: 0;
  color: #ffffff !important;
  font-size: clamp(2.2rem, 6vw, 4.6rem);
  font-weight: 800;
  letter-spacing: -0.045em;
  line-height: 1.04;
}
.hydra-home-hero .hydra-home-lede {
  max-width: 620px;
  margin: 20px 0 0 !important;
  color: #e2f1fd !important;
  font-size: 1.12rem;
  line-height: 1.65;
}
.hydra-home-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
.hydra-home-hero a.hydra-home-button {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: 8px 18px;
  border: 1px solid rgba(255, 255, 255, 0.45) !important;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.15) !important;
  color: #ffffff !important;
  font-size: 0.9rem;
  font-weight: 700;
  text-decoration: none !important;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
  backdrop-filter: blur(8px);
}
.hydra-home-hero a.hydra-home-button:hover {
  border-color: #ffffff !important;
  background: rgba(255, 255, 255, 0.28) !important;
  color: #ffffff !important;
  transform: translateY(-2px);
}
.hydra-home-hero a.hydra-home-button-primary {
  border-color: #38bdf8 !important;
  background: #009afc !important;
  color: #ffffff !important;
  font-weight: 800;
}
.hydra-home-hero a.hydra-home-button-primary:hover {
  background: #0284c7 !important;
  color: #ffffff !important;
}
.hydra-home-hero .hydra-home-install {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 26px 0 0 !important;
  color: #bae6fd !important;
  font-size: 0.88rem;
  font-weight: 600;
}
.hydra-home-hero .hydra-home-install span {
  color: #bae6fd !important;
}
.hydra-home-hero .hydra-home-install code {
  border: 1px solid rgba(99, 199, 255, 0.5) !important;
  border-radius: 6px;
  background: rgba(0, 18, 63, 0.75) !important;
  color: #ffffff !important;
  padding: 4px 10px;
  font-size: 0.88rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.hydra-home-mark {
  display: grid;
  place-items: center;
  min-height: 220px;
}
.hydra-home-mark img {
  width: min(100%, 240px);
  height: auto;
  filter: drop-shadow(0 0 32px rgba(0, 154, 252, 0.85));
  transition: transform 180ms steps(2);
}
.hydra-home-hero:hover .hydra-home-mark img { transform: translateY(-4px) scale(1.03); }
.hydra-home-wiki { margin: 0 0 44px; }
.hydra-section-heading { max-width: 700px; margin-bottom: 20px; }
.hydra-section-heading h2 {
  margin: 0 !important;
  padding-top: 0 !important;
  border-top: none !important;
  color: var(--vp-c-text-1) !important;
  font-size: clamp(1.7rem, 4vw, 2.5rem);
  letter-spacing: -0.03em;
}
.hydra-section-heading p:last-child { margin: 10px 0 0 !important; color: var(--vp-c-text-2) !important; }
.hydra-feature-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.hydra-feature-card {
  display: flex;
  min-height: 170px;
  flex-direction: column;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}
.hydra-feature-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 10px 24px rgba(0, 96, 224, 0.12);
  transform: translateY(-2px);
}
.hydra-feature-number {
  color: var(--vp-c-brand-1);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}
.hydra-feature-card h3 {
  margin: 12px 0 6px !important;
  padding-top: 0 !important;
  border-top: none !important;
  color: var(--vp-c-text-1) !important;
  font-size: 1.15rem;
}
.hydra-feature-card p {
  margin: 0 !important;
  color: var(--vp-c-text-2) !important;
  font-size: 0.92rem;
  line-height: 1.55;
}
.hydra-feature-link {
  margin-top: auto;
  padding-top: 16px;
  color: var(--vp-c-brand-1);
  font-size: 0.82rem;
  font-weight: 750;
}
@media (max-width: 960px) { .hydra-feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) {
  .hydra-home-hero { grid-template-columns: 1fr; }
  .hydra-home-mark { justify-items: start; min-height: 0; }
  .hydra-home-mark img { width: 160px; }
  .hydra-feature-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .hydra-home-button, .hydra-home-mark img, .hydra-feature-card { transition: none; }
  .hydra-home-hero:hover .hydra-home-mark img, .hydra-home-button:hover, .hydra-feature-card:hover { transform: none; }
}

.VPSidebar::-webkit-scrollbar { width: 6px; }
.VPSidebar::-webkit-scrollbar-track { background: transparent; }
.VPSidebar::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 3px;
  transition: background-color 0.3s;
}
.VPSidebar[data-scrolling]::-webkit-scrollbar-thumb { background-color: var(--vp-c-text-3); }
@supports not selector(::-webkit-scrollbar) {
  .VPSidebar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .VPSidebar[data-scrolling] { scrollbar-color: var(--vp-c-text-3) transparent; }
}

:is(.vp-doc, .VPPage) .hydra-command-block,
:is(.vp-doc, .VPPage) .hydra-output-block {
  position: relative;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 8px 22px rgba(0, 18, 63, 0.08);
}
:is(.vp-doc, .VPPage) .hydra-command-block {
  border-color: rgba(0, 154, 252, 0.45);
  background: var(--vp-c-bg-soft);
}
:is(.vp-doc, .VPPage) .hydra-command-block::before,
:is(.vp-doc, .VPPage) .hydra-output-block::before {
  position: absolute;
  top: 12px;
  left: 16px;
  z-index: 1;
  color: var(--vp-c-text-2);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  line-height: 1;
}
:is(.vp-doc, .VPPage) .hydra-command-block::before { content: 'COMMAND'; color: var(--vp-c-brand-1); }
:is(.vp-doc, .VPPage) .hydra-output-block::before { content: 'TERMINAL OUTPUT'; }
:is(.vp-doc, .VPPage) .hydra-command-block > pre { padding-top: 44px; }
:is(.vp-doc, .VPPage) .hydra-output-block > pre { padding-top: 40px; }
:is(.vp-doc, .VPPage) .hydra-command-block > span.lang,
:is(.vp-doc, .VPPage) .hydra-output-block > span.lang { display: none; }
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 3;
  width: auto;
  min-width: 74px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  background-color: var(--vp-c-bg);
  background-image: none;
  color: var(--vp-c-text-1);
  opacity: 1;
  cursor: pointer;
}
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy::after { content: 'Copy'; }
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy.copied::before,
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy:hover.copied::before {
  display: none !important;
  content: none !important;
}
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy.copied::after { content: 'Copied'; }
:is(.vp-doc, .VPPage) .hydra-command-block > button.copy.copied {
  border-color: var(--vp-c-brand-1);
  background-image: none !important;
  color: var(--vp-c-brand-1);
}
:is(.vp-doc, .VPPage) .hydra-output-block > button.copy { display: none; }
@media (max-width: 639px) {
  :is(.vp-doc, .VPPage) .hydra-command-block,
  :is(.vp-doc, .VPPage) .hydra-output-block { border-radius: 8px; }
}
`

/**
 * Mark the sidebar while it scrolls, so its scrollbar rests invisible.
 *
 * A sized `::-webkit-scrollbar` opts the element out of the platform's
 * self-hiding overlay bar, leaving one painted at all times; nothing in CSS
 * reports that an element is scrolling. The listener captures instead of
 * bubbling because scroll events do not bubble, and marks a `data-` attribute
 * rather than a class because Vue rewrites `class` wholesale when it patches
 * the element.
 */
const scrollbarScript = `
(() => {
  let idle
  addEventListener('scroll', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.classList.contains('VPSidebar')) return
    target.dataset.scrolling = ''
    clearTimeout(idle)
    idle = setTimeout(() => delete target.dataset.scrolling, 800)
  }, true)
})()
`

/**
 * Navigation-bar title: the product wordmark and the release-stage tag.
 * VitePress renders `siteTitle` as HTML.
 *
 * @param previewTag - Release-stage label.
 * @returns Markup placed beside the navigation-bar home link.
 */
function siteTitle(previewTag: string): string {
  return `<span class="hydra-lockup">${wordmark}<span class="hydra-tag">${previewTag}</span></span>`
}

export default withMermaid({
  title: siteIdentity.title,
  titleTemplate: ':title | Open-source agent workspace',
  description: siteIdentity.description,
  lang: 'en-US',
  base,
  sitemap: { hostname: siteUrl },
  /** Emit the raw-Markdown twin of every route plus llms.txt beside the rendered site. */
  buildEnd(siteConfig: SiteConfig) {
    emitRawMarkdownPages(siteConfig.outDir)
    writeFileSync(resolve(siteConfig.outDir, 'llms.txt'), llmsTxt({ base, ...siteIdentity }))
  },
  head: [
    // VitePress leaves head hrefs untouched, so the base belongs here explicitly.
    ['link', { rel: 'icon', type: 'image/png', href: `${base}hydra.png` }],
    ['meta', { name: 'theme-color', content: '#00123f' }],
    ['meta', { name: 'robots', content: 'index,follow' }],
    ['style', {}, siteStyle],
    ['script', {}, scrollbarScript],
  ],
  transformHead({ page, title, description }) {
    const home = page === '' || page === 'index' || page === 'index.md'
    const route = home ? '' : page.replace(/\.md$/, '').replace(/\/index$/, '')
    const canonical = new URL(route || '.', siteUrl).toString()
    const pageTitle = home ? 'Hydra harness | Open-source agent workspace' : `${title} | ${siteIdentity.title}`
    const image = new URL('hydra.png', siteUrl).toString()
    const tags: HeadConfig[] = [
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { name: 'description', content: description || siteIdentity.description }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: pageTitle }],
      ['meta', { property: 'og:description', content: description || siteIdentity.description }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:image', content: image }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: pageTitle }],
      ['meta', { name: 'twitter:description', content: description || siteIdentity.description }],
      ['meta', { name: 'twitter:image', content: image }],
    ]
    if (home) {
      tags.push(['script', { type: 'application/ld+json' }, JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Hydra harness',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows, macOS, Linux',
        description: siteIdentity.description,
        url: siteUrl,
        image,
        codeRepository: 'https://github.com/MaiHongPhong2010/Hydra-Harness',
        license: 'https://opensource.org/licenses/MIT',
      })])
    }
    return tags
  },
  cleanUrls: true,
  srcDir: '.generated',
  cacheDir: '.cache',
  outDir: '.dist',
  vite: {
    // `srcDir` puts the Vite root inside the disposable generated tree, whose
    // own `public/` no tracked asset can live in.
    publicDir: resolve(import.meta.dirname, '../public'),
    plugins: [
      {
        name: 'hydra-harness-doc-projector',
        configResolved(config) {
          // VitePress MPA skips the client pass that empties the final output directory.
          if (config.command === 'build' && config.build.ssr && config.build.ssrEmitAssets) {
            rmSync(resolve(import.meta.dirname, '../.dist'), { recursive: true, force: true })
          }
        },
        configureServer(server) {
          watchCanonicalDocs(server)
          serveRawMarkdown(server)
        },
      },
    ],
  },
  markdown: {
    config(md) {
      const renderText = md.renderer.rules.text
      const renderCode = md.renderer.rules.code_inline
      const renderFence = md.renderer.rules.fence
      if (renderText === undefined) throw new Error('VitePress Markdown renderer is missing the text rendering rule.')
      if (renderCode === undefined) throw new Error('VitePress Markdown renderer is missing the inline-code rendering rule.')
      if (renderFence === undefined) throw new Error('VitePress Markdown renderer is missing the fence rendering rule.')
      md.renderer.rules.text = (...args) => escapeVueInterpolation(renderText(...args))
      md.renderer.rules.code_inline = (...args) => escapeVueInterpolation(renderCode(...args))
      const renderedFences = new Map<string, string>()
      md.renderer.rules.fence = (...args) => {
        const [tokens, index] = args
        const token = tokens[index]
        if (token === undefined) throw new Error('VitePress code-fence renderer received no token.')
        // Mermaid output embeds the token position, and VitePress snippets resolve source files during rendering.
        if (['mermaid', 'mmd'].includes(token.info.trim().split(/\s+/, 1)[0] ?? '')) return renderFence(...args)
        if (Reflect.get(token, 'src') !== undefined) return renderFence(...args)
        const kind = codeBlockKind(token.info)
        if (kind !== undefined) {
          // Prompt removal happens before VitePress highlights the block and its built-in
          // Clipboard handler reads the resulting text, so the copied value stays raw.
          const key = JSON.stringify([token.content, token.info, token.markup, token.attrs, kind])
          const cached = renderedFences.get(key)
          if (cached !== undefined) return cached
          const originalContent = token.content
          try {
            if (kind === 'command') token.content = normalizeCommand(originalContent)
            const html = decorateFenceHtml(renderFence(...args), kind)
            if (process.env.NODE_ENV === 'production') renderedFences.set(key, html)
            return html
          } finally {
            token.content = originalContent
          }
        }
        // Keep the cache build-local; a dev renderer can survive many HMR updates.
        if (process.env.NODE_ENV !== 'production') return renderFence(...args)
        const key = JSON.stringify([token.content, token.info, token.markup, token.attrs])
        const cached = renderedFences.get(key)
        if (cached !== undefined) return cached
        const html = renderFence(...args)
        renderedFences.set(key, html)
        return html
      }
    },
  },
  mermaid: {},
  themeConfig: {
    siteTitle: siteTitle('Preview'),
    nav: [
      { text: 'Guide', link: landingLink(guideModules.guide), activeMatch: '^/guide/' },
      ...moduleNav(),
    ],
    sidebar: {
      '/guide/': guideSidebar(),
      '/develop/': sidebar('develop'),
      '/reference/': sidebar('reference'),
    },
    outline: { label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/MaiHongPhong2010/Hydra-Harness' },
    ],
    editLink: {
      pattern: ({ frontmatter }: PageData) => {
        const data: unknown = frontmatter
        const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
        if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
        return `https://github.com/MaiHongPhong2010/Hydra-Harness/edit/main/${editSource}`
      },
      text: 'Edit this page on GitHub',
    },
  } satisfies DefaultTheme.Config,
})
