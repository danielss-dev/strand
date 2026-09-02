import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { marked } = require('./docs/marked.min.js');
const root = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.join(root, 'docs');
const outRoot = path.join(root, 'dist');
const origin = 'https://strandgit.com';

const manifest = JSON.parse(await readFile(path.join(docsRoot, 'manifest.json'), 'utf8'));
const pages = manifest.pages;
const slugs = new Set();

if (!Array.isArray(pages) || pages.length === 0) {
  throw new Error('docs/manifest.json must contain at least one page');
}

for (const page of pages) {
  if (!page.file || !page.title || !page.description) {
    throw new Error(`Incomplete documentation metadata: ${JSON.stringify(page)}`);
  }
  if (!/^[a-z0-9-]+$/.test(page.file)) {
    throw new Error(`Invalid documentation slug: ${page.file}`);
  }
  if (slugs.has(page.file)) {
    throw new Error(`Duplicate documentation slug: ${page.file}`);
  }
  slugs.add(page.file);
}

if (!slugs.has('index')) {
  throw new Error('The documentation manifest must contain the index page');
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

for (const file of ['index.html', 'style.css', 'script.js', 'favicon.svg', 'favicon.png', 'og-image.svg', 'og-image.png', 'demo-poster.webp']) {
  await cp(path.join(root, file), path.join(outRoot, file));
}
await cp(path.join(root, 'fonts'), path.join(outRoot, 'fonts'), { recursive: true });

// The live demo (`pnpm demo:build` at the repo root → website/demo) is an
// optional input: the static site still builds without it, the hero just
// keeps its poster.
const demoRoot = path.join(root, 'demo');
const hasDemo = await stat(path.join(demoRoot, 'index.html')).then((s) => s.isFile(), () => false);
if (hasDemo) await cp(demoRoot, path.join(outRoot, 'demo'), { recursive: true });

await mkdir(path.join(outRoot, 'docs'), { recursive: true });
await cp(path.join(docsRoot, 'docs.css'), path.join(outRoot, 'docs', 'docs.css'));

const pageUrl = (slug) => slug === 'index' ? '/docs/' : `/docs/${slug}/`;
const absolutePageUrl = (slug) => `${origin}${pageUrl(slug)}`;

for (let index = 0; index < pages.length; index += 1) {
  const page = pages[index];
  const markdownPath = path.join(docsRoot, `${page.file}.md`);
  let markdown;
  try {
    markdown = await readFile(markdownPath, 'utf8');
  } catch {
    throw new Error(`Missing documentation source: docs/${page.file}.md`);
  }

  markdown = rewriteMarkdownLinks(markdown, page.file);
  const rendered = renderArticle(markdown);
  const html = renderDocument(page, rendered, index);
  const outputDir = page.file === 'index'
    ? path.join(outRoot, 'docs')
    : path.join(outRoot, 'docs', page.file);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'index.html'), html, 'utf8');
}

await writeFile(
  path.join(outRoot, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
  'utf8',
);

const sitemapUrls = [`${origin}/`, ...pages.map((page) => absolutePageUrl(page.file))];
await writeFile(
  path.join(outRoot, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')}\n</urlset>\n`,
  'utf8',
);

console.log(`Built Strand website with ${pages.length} static documentation pages${hasDemo ? ' and the live demo' : ' (no live demo — run `pnpm demo:build` first)'}.`);

function rewriteMarkdownLinks(markdown, sourceSlug) {
  return markdown.replace(/\]\(([a-z0-9-]+)\.md(#[^)]+)?\)/g, (match, target, hash = '') => {
    if (!slugs.has(target)) {
      throw new Error(`Broken documentation link in ${sourceSlug}.md: ${target}.md`);
    }
    return `](${pageUrl(target)}${hash})`;
  });
}

function renderArticle(markdown) {
  let article = marked.parse(markdown, { gfm: true, breaks: false });
  const usedIds = new Set();
  const toc = [];

  article = article.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    const label = decodeEntities(stripTags(inner)).trim();
    let id = slugify(label);
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    toc.push({ id, label, level: Number(level) });
    return `<h${level} id="${escapeAttribute(id)}">${inner}<a class="hlink" href="#${escapeAttribute(id)}" aria-label="Link to ${escapeAttribute(label)}">#</a></h${level}>`;
  });

  article = article.replace(/<table>/g, '<div class="table-scroll"><table>');
  article = article.replace(/<\/table>/g, '</table></div>');
  article = article.replace(/<a href="(https?:\/\/[^\"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');
  return { article, toc };
}

function renderDocument(page, rendered, index) {
  const canonical = absolutePageUrl(page.file);
  const title = page.file === 'index'
    ? 'Strand Git Client User Guide'
    : `${page.title} — Strand Git Client Docs`;
  const currentUrl = pageUrl(page.file);
  const nav = pages.map((entry) => {
    const current = entry.file === page.file;
    const label = entry.file === 'index' ? 'Overview' : entry.title;
    return `<a href="${pageUrl(entry.file)}"${current ? ' class="on" aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  }).join('\n          ');
  const toc = rendered.toc.length > 1
    ? `<aside class="docs-toc" aria-label="On this page">
      <p class="docs-side-label">On this page</p>
      <nav>${rendered.toc.map((entry) => `<a href="#${escapeAttribute(entry.id)}"${entry.level === 3 ? ' class="lv3"' : ''}>${escapeHtml(entry.label)}</a>`).join('')}</nav>
    </aside>`
    : '<aside class="docs-toc" aria-label="On this page" hidden></aside>';
  const pager = renderPager(index);
  const legacyRedirect = page.file === 'index' ? renderLegacyRedirect() : '';

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(page.description)}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:title" content="${escapeAttribute(title)}" />
  <meta property="og:description" content="${escapeAttribute(page.description)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="Strand Git" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:image" content="${origin}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Strand — a fast, cross-platform Git client" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeAttribute(title)}" />
  <meta name="twitter:description" content="${escapeAttribute(page.description)}" />
  <meta name="twitter:image" content="${origin}/og-image.png" />
  <meta name="theme-color" content="#171511" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.png" type="image/png" />
  <link rel="preload" href="/fonts/jetbrains-mono-600-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/fonts/geist-400-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/style.css" />
  <link rel="stylesheet" href="/docs/docs.css" />
  ${legacyRedirect}
</head>
<body id="top">
  <header class="nav">
    <div class="wrap nav-row">
      <a class="brand" href="/">
        <img class="brand-mark" src="/favicon.svg" alt="" />
        <span>strand</span>
      </a>
      <nav class="nav-links" aria-label="Site">
        <a href="/docs/" class="active">Docs</a>
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="https://github.com/danielss-dev/strand" target="_blank" rel="noopener">GitHub<span class="ext">↗</span></a>
      </nav>
      <a class="btn btn-accent btn-sm" href="/#download">Download</a>
    </div>
  </header>

  <main class="docs-main wrap" data-doc-url="${currentUrl}">
    <details class="docs-nav-m">
      <summary>Guide contents</summary>
      <nav aria-label="Guide pages (mobile)">${nav}</nav>
    </details>

    <aside class="docs-side">
      <p class="docs-side-label">User guide</p>
      <nav aria-label="Guide pages">
          ${nav}
      </nav>
      <div class="docs-side-foot">
        <a href="https://github.com/danielss-dev/strand/releases" target="_blank" rel="noopener">Release notes ↗</a>
        <a href="https://github.com/danielss-dev/strand/issues" target="_blank" rel="noopener">Report an issue ↗</a>
      </div>
    </aside>

    <article class="docs-article">
${indent(rendered.article.trim(), 6)}
${indent(pager, 6)}
    </article>

    ${toc}
  </main>

  <footer class="footer">
    <div class="wrap footer-fine">
      <span>© 2026 Daniel Schwarz</span>
      <span class="mono">strand docs · edit on <a href="https://github.com/danielss-dev/strand/tree/main/website/docs" target="_blank" rel="noopener">GitHub</a></span>
    </div>
  </footer>
</body>
</html>
`;
}

function renderPager(index) {
  const links = [];
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (previous) links.push(pagerLink(previous, 'Previous', 'pager-prev'));
  if (next) links.push(pagerLink(next, 'Next', 'pager-next'));
  return links.length ? `<div class="docs-pager">${links.join('')}</div>` : '';
}

function pagerLink(page, direction, className) {
  const title = page.file === 'index' ? 'Strand User Guide' : page.title;
  return `<a class="${className}" href="${pageUrl(page.file)}"><span class="pager-dir">${direction}</span><span class="pager-title">${escapeHtml(title)}</span></a>`;
}

function renderLegacyRedirect() {
  const routes = JSON.stringify([...slugs].filter((slug) => slug !== 'index'));
  return `<script>
    (function () {
      var page = new URLSearchParams(location.search).get('page');
      var routes = ${routes};
      if (page && routes.indexOf(page) !== -1) location.replace('/docs/' + page + '/' + location.hash);
    })();
  </script>`;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, '');
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeXml(value) {
  return escapeHtml(value);
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => prefix + line).join('\n');
}
