/* Strand landing — reveals, accent switcher, the interactive app mock
 * (Local Changes / Review / All Commits views, collapsible tree), and the
 * ⌘K palette repurposed to drive this page. No dependencies; degrades to a
 * static page without JS. */
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
        navById[e.target.id].classList.add('active');
      }
    },
    { rootMargin: '-25% 0px -65% 0px' }
  );
  Object.keys(navById).forEach((id) => spy.observe(document.getElementById(id)));

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

  /* ══ App mock ══ */
  const mock = $('#mock');
  if (!mock) return;
  const rows = $$('.q-row', mock);
  const diffs = $$('.mockdiff', mock);
  const tree = $('#mock-tree');
  const dPath = $('#d-path');
  const dAdd = $('#d-add');
  const dDel = $('#d-del');
  const barFill = $('#bar-fill');
  const barText = $('#bar-text');
  const markBtn = $('#mark-btn');
  const discardLink = $('#discard-link');
  let cur = rows.findIndex((r) => r.classList.contains('sel'));
  if (cur < 0) cur = 0;
  let hovering = false;
  let lastNav = 0; // space is only hijacked right after j/k or while hovering

  mock.addEventListener('pointerenter', () => (hovering = true));
  mock.addEventListener('pointerleave', () => (hovering = false));

  // keep a row visible inside its scroll container without ever scrolling the page
  function keepVisible(box, row) {
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }

  function render() {
    const row = rows[cur];
    rows.forEach((r, i) => r.classList.toggle('sel', i === cur));
    if (row.offsetParent !== null) keepVisible(tree, row);
    const key = row.dataset.d;
    let shown;
    diffs.forEach((d) => {
      const on = d.dataset.d === key;
      d.classList.toggle('on', on);
      if (on) shown = d;
    });
    dPath.textContent = row.dataset.path;
    if (shown) {
      dAdd.textContent = shown.dataset.add;
      dDel.textContent = shown.dataset.del;
    }
    const done = rows.filter((r) => r.classList.contains('done')).length;
    barFill.style.width = `${Math.round((done / rows.length) * 100)}%`;
    barText.textContent = `${done}/${rows.length} reviewed`;
    discardLink.textContent = `Discard unreviewed (${rows.length - done})`;
    markBtn.classList.toggle('on', row.classList.contains('done'));
    markBtn.lastChild.textContent = row.classList.contains('done') ? 'Reviewed' : 'Mark reviewed';
    $('#d-scroll').scrollTop = 0;
  }

  // j/k walks only the rows whose folders are expanded
  const visRows = () => rows.filter((r) => r.offsetParent !== null);
  function move(delta) {
    const vis = visRows();
    if (!vis.length) return;
    let vi = vis.indexOf(rows[cur]);
    vi = vi < 0 ? 0 : Math.min(vis.length - 1, Math.max(0, vi + delta));
    cur = rows.indexOf(vis[vi]);
    lastNav = Date.now();
    render();
  }

  function toggleReviewed() {
    const row = rows[cur];
    const done = row.classList.toggle('done');
    let ok = $('.q-ok', row);
    if (done && !ok) {
      ok = document.createElement('span');
      ok.className = 'q-ok';
      ok.textContent = '✓';
      row.insertBefore(ok, $('.st', row)); // ✓ sits left of the status letter
    } else if (!done && ok) {
      ok.remove();
    }
    render();
  }

  function flash(key) {
    $$(`[data-k="${key}"]`).forEach((k) => {
      k.classList.add('hit');
      setTimeout(() => k.classList.remove('hit'), 170);
    });
  }

  rows.forEach((row, i) => {
    row.addEventListener('click', () => {
      cur = i;
      lastNav = Date.now();
      render();
    });
    row.addEventListener('dblclick', () => {
      cur = i;
      toggleReviewed();
    });
  });

  markBtn.addEventListener('click', () => {
    toggleReviewed();
    lastNav = Date.now();
  });

  /* folders collapse like the app's Pierre tree */
  $$('.q-dir', mock).forEach((dir) => {
    dir.addEventListener('click', () => {
      const closed = dir.classList.toggle('closed');
      const kids = dir.nextElementSibling;
      if (kids && kids.classList.contains('q-kids')) kids.classList.toggle('closed', closed);
    });
  });

  /* ── View switching: Local Changes / Review / All Commits ── */
  const VIEWS = {
    local: ['Local Changes', '· 8 files with changes'],
    review: ['Review', '· 8 unstaged files'],
    commits: ['All Commits', '· feature/auth-retry'],
  };
  const crumbLeaf = $('#crumb-leaf');
  const crumbNote = $('#crumb-note');
  function setView(v) {
    mock.dataset.view = v;
    $$('.side-row[data-view]', mock).forEach((r) => r.classList.toggle('active', r.dataset.view === v));
    crumbLeaf.textContent = VIEWS[v][0];
    crumbNote.textContent = VIEWS[v][1];
  }
  $$('.side-row[data-view]', mock).forEach((r) => r.addEventListener('click', () => setView(r.dataset.view)));

  /* commit graph rows: click or j/k selects */
  const commitsBox = $('.commits', mock);
  const cRows = $$('.c-row', mock);
  cRows.forEach((r) => {
    r.addEventListener('click', () => {
      cRows.forEach((x) => x.classList.remove('sel'));
      r.classList.add('sel');
    });
  });
  function moveCommit(delta) {
    let i = cRows.findIndex((r) => r.classList.contains('sel'));
    i = i < 0 ? 0 : Math.min(cRows.length - 1, Math.max(0, i + delta));
    cRows.forEach((x, j) => x.classList.toggle('sel', j === i));
    keepVisible(commitsBox, cRows[i]);
    lastNav = Date.now();
  }

  /* commit form: mock a commit */
  const commitBtn = $('.btn-commit', mock);
  const subjInput = $('.cb-top .subject', mock);
  if (commitBtn) {
    commitBtn.addEventListener('click', () => {
      if (!subjInput.value.trim()) return;
      subjInput.value = '';
      $('.desc-row .subject', mock).value = '';
      const label = commitBtn.childNodes[0];
      label.textContent = 'Committed ✓';
      setTimeout(() => (label.textContent = 'Commit'), 1400);
    });
  }

  /* ══ Command palette (the app's ⌘K, driving this page) ══ */
  const veil = $('#palette-veil');
  const pInput = $('#palette-q');
  const pList = $('#palette-list');
  const goTo = (sel) => $(sel).scrollIntoView();
  const showDemo = (v) => {
    setView(v);
    mock.scrollIntoView({ block: 'center' });
  };
  const openExt = (url) => window.open(url, '_blank', 'noopener');
  const ICONS = {
    goto: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    demo: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  };
  const ITEMS = [
    { g: 'Go to', icon: 'goto', label: 'Workflow — built around the agent loop', kw: 'loop watch baseline feedback', run: () => goTo('#loop') },
    { g: 'Go to', icon: 'goto', label: 'Performance — fast is the feature', kw: 'speed benchmarks numbers', run: () => goTo('#speed') },
    { g: 'Go to', icon: 'goto', label: 'Keyboard — hands on home row', kw: 'shortcuts keys', run: () => goTo('#keyboard') },
    { g: 'Go to', icon: 'goto', label: 'Pricing — free for people', kw: 'license commercial agpl buy', run: () => goTo('#pricing') },
    { g: 'Go to', icon: 'down', label: 'Download Strand', kw: 'install dmg msi mac windows', run: () => goTo('#download') },
    { g: 'Demo', icon: 'demo', label: 'Show: Local Changes', kw: 'staging stage view demo', run: () => showDemo('local') },
    { g: 'Demo', icon: 'demo', label: 'Show: Review', kw: 'queue view demo', run: () => showDemo('review') },
    { g: 'Demo', icon: 'demo', label: 'Show: All Commits', kw: 'graph log history view demo', run: () => showDemo('commits') },
    { g: 'Links', icon: 'link', label: 'View source on GitHub', meta: 'github.com ↗', kw: 'repo code source', run: () => openExt('https://github.com/danielss-dev/strand') },
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
  const pill = $('#open-palette');
  pill.addEventListener('click', openPalette);
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPalette();
    }
  });

  /* ── One keyboard router: palette first, then the mock ── */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      veil.hidden ? openPalette() : closePalette();
      return;
    }
    if (!veil.hidden) {
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
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
    const inCommits = mock.dataset.view === 'commits';
    if (e.key === 'j') {
      inCommits ? moveCommit(1) : move(1);
      flash('j');
    } else if (e.key === 'k') {
      inCommits ? moveCommit(-1) : move(-1);
      flash('k');
    } else if (e.key === ' ' && !inCommits && (hovering || Date.now() - lastNav < 5000)) {
      e.preventDefault(); // don't page-scroll while "in" the mock
      toggleReviewed();
      flash('space');
      lastNav = Date.now();
    }
  });

  render();
})();
