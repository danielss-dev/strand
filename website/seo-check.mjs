import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.join(root, 'dist');
const origin = 'https://strandgit.com';
const failures = [];
const htmlFiles = await findFiles(outRoot, (file) => file.endsWith('.html'));
const titles = new Map();
const descriptions = new Map();

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const route = fileToRoute(file);
  const expectedCanonical = `${origin}${route}`;
  const title = singleMatch(html, /<title>([\s\S]*?)<\/title>/i, file, 'title');
  const description = singleMatch(html, /<meta name="description" content="([^"]+)"\s*\/>/i, file, 'description');
  const canonical = singleMatch(html, /<link rel="canonical" href="([^"]+)"\s*\/>/i, file, 'canonical');
  const h1Count = (html.match(/<h1(?:\s|>)/gi) || []).length;

  if (h1Count !== 1) failures.push(`${route} must contain exactly one h1 (found ${h1Count})`);
  if (canonical && canonical !== expectedCanonical) failures.push(`${route} canonical is ${canonical}, expected ${expectedCanonical}`);
  recordUnique(titles, title, route, 'title');
  recordUnique(descriptions, description, route, 'description');

  for (const json of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(json[1]); } catch (error) { failures.push(`${route} has invalid JSON-LD: ${error.message}`); }
  }

  for (const link of html.matchAll(/<a\s[^>]*href="([^"]+)"/gi)) {
    await checkLink(link[1], route);
  }
}

const sitemap = await readFile(path.join(outRoot, 'sitemap.xml'), 'utf8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
if (sitemapUrls.length !== htmlFiles.length) {
  failures.push(`sitemap contains ${sitemapUrls.length} URLs for ${htmlFiles.length} HTML pages`);
}
for (const url of sitemapUrls) {
  if (!url.startsWith(`${origin}/`) || /[?]|\.md(?:$|#)/.test(url)) failures.push(`invalid sitemap URL: ${url}`);
  const parsed = new URL(url);
  const file = routeToFile(parsed.pathname);
  if (!(await exists(file))) failures.push(`sitemap URL has no output file: ${url}`);
}

const robots = await readFile(path.join(outRoot, 'robots.txt'), 'utf8');
if (!robots.includes('User-agent: *') || !robots.includes('Allow: /')) failures.push('robots.txt must allow public crawling');
if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) failures.push('robots.txt must name the canonical sitemap URL');
if (/https?:\/\/(?!strandgit\.com)/.test(robots)) failures.push('robots.txt references a non-canonical origin');

const home = await readFile(path.join(outRoot, 'index.html'), 'utf8');
if (!home.includes('"@type": "SoftwareApplication"')) failures.push('homepage is missing SoftwareApplication JSON-LD');

if (failures.length) {
  console.error(`SEO checks failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`SEO checks passed for ${htmlFiles.length} canonical HTML pages.`);

async function checkLink(href, sourceRoute) {
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
  let url;
  try { url = new URL(href, `${origin}${sourceRoute}`); } catch { failures.push(`${sourceRoute} has invalid link: ${href}`); return; }
  if (url.origin !== origin) return;
  if (url.searchParams.has('page') || url.pathname.endsWith('.md')) failures.push(`${sourceRoute} contains a legacy documentation link: ${href}`);
  const file = routeToFile(url.pathname);
  if (!(await exists(file))) failures.push(`${sourceRoute} links to missing output: ${href}`);
}

function fileToRoute(file) {
  const relative = path.relative(outRoot, file).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`;
  return `/${relative}`;
}

function routeToFile(route) {
  const decoded = decodeURIComponent(route);
  if (decoded === '/') return path.join(outRoot, 'index.html');
  if (decoded.endsWith('/')) return path.join(outRoot, decoded, 'index.html');
  const direct = path.join(outRoot, decoded);
  return path.extname(decoded) ? direct : path.join(direct, 'index.html');
}

async function findFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findFiles(fullPath, predicate));
    else if (predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

function singleMatch(html, regex, file, label) {
  const matches = [...html.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
  if (matches.length !== 1) {
    failures.push(`${path.relative(outRoot, file)} must contain exactly one ${label} (found ${matches.length})`);
    return '';
  }
  return matches[0][1];
}

function recordUnique(map, value, route, label) {
  if (!value) return;
  if (map.has(value)) failures.push(`${route} duplicates ${label} from ${map.get(value)}`);
  else map.set(value, route);
}

async function exists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}
