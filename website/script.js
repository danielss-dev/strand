/* Strand landing — reveals, accent switcher, the live demo embed (the real
 * app from ui/, built for the browser), and the ⌘K palette repurposed to
 * drive this page. No dependencies; degrades to a static page without JS. */
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  /* ── Scroll reveals ── */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  $$('[data-reveal]').forEach((el) => io.observe(el));

  /* ── Accent (mirrors the app's [data-accent] hue rotation) ── */
  function setAccent(h) {
    document.documentElement.style.setProperty('--accent-h', h);
    $$('.dot').forEach((d) => d.setAttribute('aria-pressed', String(d.dataset.h === h)));
  }
  $$('.dot').forEach((dot) => dot.addEventListener('click', () => setAccent(dot.dataset.h)));

  /* ── Downloads → latest release ── */
  /* Asset names embed the version (Strand_1.5.1_universal.dmg), so resolve
   * them through the API; on any failure the hrefs keep pointing at the
   * releases page and the static version text stands. */
  const PLATFORM_NAMES = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  const dlBtns = $$('[data-artifact]');
  const platformHint = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  const platform = platformHint.includes('mac')
    ? 'macos'
    : platformHint.includes('win')
      ? 'windows'
      : platformHint.includes('linux')
        ? 'linux'
        : null;
  if (platform) {
    $(`[data-platform="${platform}"]`)?.classList.add('is-preferred');
    const primary = $('#dl-primary');
    if (primary) primary.textContent = `Download for ${PLATFORM_NAMES[platform]}`;
    const rail = $('#dl-rail');
    if (rail) rail.textContent = `Get it for ${PLATFORM_NAMES[platform]}`;
  }
  if (dlBtns.length) {
    fetch('https://api.github.com/repos/danielss-dev/strand/releases/latest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rel) => {
        for (const btn of dlBtns) {
          const asset = (rel.assets || []).find((a) => a.name.endsWith(btn.dataset.artifact));
          if (asset) btn.href = asset.browser_download_url;
        }
        if (rel.tag_name) {
          $$('#hero-version, #dl-version').forEach((el) => (el.textContent = rel.tag_name));
        }
        if (rel.published_at) {
          const when = new Date(rel.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const released = $('#dl-released');
          if (released) released.textContent = `${rel.tag_name || 'latest'} · ${when}`;
        }
      })
      .catch(() => {});
  }

  /* ── Nav scrollspy ── */
  const navById = {};
  $$('.nav-links a[href^="#"]').forEach((a) => {
    const sec = $(a.getAttribute('href'));
    if (sec) navById[sec.id] = a;
  });
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        Object.values(navById).forEach((a) => a.classList.remove('active'));
        navById[e.target.id]?.classList.add('active');
      }
    },
    { rootMargin: '-25% 0px -65% 0px' }
  );
  // Observe every section so the highlight clears on sections without a nav entry.
  $$('main section[id]').forEach((sec) => spy.observe(sec));

  /* ── Stat count-up on reveal ── */
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cio = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cio.unobserve(e.target);
        const end = +e.target.dataset.count;
        if (reduceMotion) continue; // markup already holds the final number
        const t0 = performance.now();
        const tick = (t) => {
          const p = Math.min(1, (t - t0) / 900);
          e.target.textContent = Math.round(end * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    },
    { threshold: 0.4 }
  );
  $$('.stat-num [data-count]').forEach((n) => cio.observe(n));

  /* ══ Live demo — the real app (ui/ built with --mode demo) in an iframe ══
   * It's a full bundle, so it mounts on demand behind a poster. Same origin,
   * so we can watch React's first commit instead of guessing at a delay. */
  const frame = $('#demo-frame');
  const stage = $('#demo-stage');
  const restartBtn = $('#demo-restart');
  let iframe = null;

  function mountDemo(view) {
    iframe?.remove();
    frame.dataset.state = 'loading';
    restartBtn.hidden = false;
    iframe = document.createElement('iframe');
    iframe.className = 'demo-iframe';
    iframe.title = 'Strand live demo';
    iframe.src = view ? `demo/?view=${encodeURIComponent(view)}` : 'demo/';
    const mounted = iframe;
    iframe.addEventListener('load', () => {
      const t0 = performance.now();
      const poll = () => {
        if (mounted !== iframe) return;
        const root = mounted.contentDocument?.getElementById('root');
        if (root?.childElementCount || performance.now() - t0 > 8000) {
          frame.dataset.state = 'ready';
          mounted.focus();
        } else requestAnimationFrame(poll);
      };
      poll();
    });
    stage.appendChild(iframe);
  }
  const narrow = matchMedia('(max-width: 720px)');
  function showDemo(view) {
    if (narrow.matches) {
      window.open(`demo/?view=${encodeURIComponent(view)}`, '_blank', 'noopener');
      return;
    }
    frame.scrollIntoView({ block: 'center' });
    if (!iframe) mountDemo(view);
    else iframe.contentWindow?.postMessage({ type: 'strand-demo:view', view }, location.origin);
  }
  $('#demo-launch').addEventListener('click', () => mountDemo());
  restartBtn.addEventListener('click', () => mountDemo());
  $$('[data-show-demo]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showDemo(a.dataset.showDemo);
    });
  });

  /* ══ Command palette (the app's ⌘K, driving this page) ══ */
  const veil = $('#palette-veil');
  const pInput = $('#palette-q');
  const pList = $('#palette-list');
  const goTo = (sel) => $(sel).scrollIntoView();
  const openExt = (url) => window.open(url, '_blank', 'noopener');
  const ICONS = {
    goto: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    demo: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  };
  const ITEMS = [
    { g: 'Go to', icon: 'goto', label: 'Review — agent changes as whole files', kw: 'baseline feedback notes queue', run: () => goTo('#review') },
    { g: 'Go to', icon: 'goto', label: 'Worktrees — one per agent', kw: 'compare merge clean up worktreeinclude', run: () => goTo('#worktrees') },
    { g: 'Go to', icon: 'goto', label: 'Git client — pull requests and everyday Git', kw: 'features github azure rebase stash graph', run: () => goTo('#features') },
    { g: 'Go to', icon: 'goto', label: 'Workbench — files, terminals, plugins', kw: 'panes templates customize heroi quick notes experimental', run: () => goTo('#workbench') },
    { g: 'Go to', icon: 'goto', label: 'AI — drafts, never silent edits', kw: 'codex claude commit message', run: () => goTo('#ai') },
    { g: 'Go to', icon: 'goto', label: 'Keyboard — first, never only', kw: 'shortcuts keys rebindable', run: () => goTo('#keyboard') },
    { g: 'Go to', icon: 'goto', label: 'Performance — fast is the feature', kw: 'speed benchmarks numbers', run: () => goTo('#speed') },
    { g: 'Go to', icon: 'goto', label: 'Pricing — free for people', kw: 'license commercial agpl buy', run: () => goTo('#pricing') },
    { g: 'Go to', icon: 'down', label: 'Download Strand', kw: 'install dmg msi appimage mac windows linux', run: () => goTo('#download') },
    { g: 'Go to', icon: 'goto', label: 'Docs — the user guide', kw: 'documentation manual help guide getting started', run: () => { location.href = 'docs/'; } },
    { g: 'Demo', icon: 'demo', label: 'Show: Workbench', meta: '⌘1', kw: 'files terminal editor panes view demo', run: () => showDemo('work') },
    { g: 'Demo', icon: 'demo', label: 'Show: Local Changes', meta: '⌘2', kw: 'staging stage commit view demo', run: () => showDemo('local') },
    { g: 'Demo', icon: 'demo', label: 'Show: All Commits', meta: '⌘3', kw: 'graph log history reflog view demo', run: () => showDemo('commits') },
    { g: 'Demo', icon: 'demo', label: 'Show: Review', meta: '⌘5', kw: 'queue baseline view demo', run: () => showDemo('review') },
    { g: 'Demo', icon: 'demo', label: 'Show: Worktrees', meta: '⌘6', kw: 'dashboard agents compare view demo', run: () => showDemo('worktrees') },
    { g: 'Demo', icon: 'demo', label: 'Show: Pull Requests', kw: 'github azure pr review view demo', run: () => showDemo('pull-requests') },
    { g: 'Links', icon: 'link', label: 'View source on GitHub', meta: 'github.com ↗', kw: 'repo code source', run: () => openExt('https://github.com/danielss-dev/strand') },
    { g: 'Links', icon: 'link', label: 'Release notes', meta: 'github.com ↗', kw: 'changelog version releases', run: () => openExt('https://github.com/danielss-dev/strand/releases') },
    { g: 'Links', icon: 'link', label: 'Follow @danielss_dev on X', meta: 'x.com ↗', kw: 'twitter social', run: () => openExt('https://x.com/danielss_dev') },
    ...[['Amber', '55'], ['Rose', '18'], ['Magenta', '330'], ['Violet', '290'], ['Blue', '250'], ['Cyan', '210'], ['Teal', '178'], ['Green', '150']]
      .map(([name, h]) => ({ g: 'Accent', dot: h, label: `Accent: ${name}`, kw: 'theme color hue', run: () => setAccent(h) })),
  ];
  let pActive = 0;
  let pShown = [];

  function fuzzy(q, text) {
    const t = text.toLowerCase();
    q = q.toLowerCase();
    const i = t.indexOf(q);
    if (i >= 0) return [[i, i + q.length]];
    let j = 0;
    const r = [];
    for (const ch of q) {
      if (ch === ' ') continue;
      j = t.indexOf(ch, j);
      if (j < 0) return null;
      r.push([j, j + 1]);
      j++;
    }
    return r;
  }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function mark(label, ranges) {
    if (!ranges) return esc(label);
    let out = '';
    let last = 0;
    for (const [a, b] of ranges) {
      out += esc(label.slice(last, a)) + '<b class="hl">' + esc(label.slice(a, b)) + '</b>';
      last = b;
    }
    return out + esc(label.slice(last));
  }
  function renderPalette() {
    const q = pInput.value.trim();
    pShown = [];
    let html = '';
    let group = null;
    for (const it of ITEMS) {
      let ranges = null;
      if (q) {
        ranges = fuzzy(q, it.label);
        if (!ranges && !(it.kw && fuzzy(q, it.kw))) continue;
      }
      if (it.g !== group) {
        group = it.g;
        html += `<div class="palette-sect">${group}</div>`;
      }
      const idx = pShown.length;
      pShown.push(it);
      const ico = it.dot
        ? `<span class="ico"><span class="adot" style="--h:${it.dot}"></span></span>`
        : `<span class="ico">${ICONS[it.icon]}</span>`;
      html += `<div class="palette-item${idx === pActive ? ' active' : ''}" role="option" aria-selected="${idx === pActive}" data-i="${idx}">${ico}<span class="label">${mark(it.label, ranges)}</span>${it.meta ? `<span class="meta">${esc(it.meta)}</span>` : ''}</div>`;
    }
    pList.innerHTML = html || '<div class="palette-empty">No matching commands.</div>';
    const act = $('.palette-item.active', pList);
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function openPalette() {
    veil.hidden = false;
    document.body.style.overflow = 'hidden';
    pInput.value = '';
    pActive = 0;
    renderPalette();
    pInput.focus();
  }
  function closePalette() {
    veil.hidden = true;
    document.body.style.overflow = '';
    pInput.blur();
  }
  function runItem(it) {
    closePalette();
    it.run();
  }
  pInput.addEventListener('input', () => {
    pActive = 0;
    renderPalette();
  });
  pList.addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item');
    if (item) runItem(pShown[+item.dataset.i]);
  });
  pList.addEventListener('pointermove', (e) => {
    const item = e.target.closest('.palette-item');
    if (item && +item.dataset.i !== pActive) {
      pActive = +item.dataset.i;
      $$('.palette-item', pList).forEach((el) => el.classList.toggle('active', +el.dataset.i === pActive));
    }
  });
  veil.addEventListener('click', (e) => {
    if (e.target === veil) closePalette();
  });
  $('#open-palette').addEventListener('click', openPalette);

  /* Keys inside the iframe never reach here, so ⌘K on the page opens this
   * palette while ⌘K in the demo opens the app's own. */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      veil.hidden ? openPalette() : closePalette();
      return;
    }
    if (veil.hidden) return;
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      pActive = Math.min(pShown.length - 1, pActive + 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pActive = Math.max(0, pActive - 1);
      renderPalette();
    } else if (e.key === 'Enter' && pShown[pActive]) {
      e.preventDefault();
      runItem(pShown[pActive]);
    }
  });
})();
