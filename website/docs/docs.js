/* Strand docs viewer — fetches manifest.json + <page>.md, renders with the
   vendored marked.min.js. Static, no build step: adding a page = drop the
   .md in this folder and add a row to manifest.json. */
(function () {
  'use strict';

  var article = document.getElementById('docs-article');
  var tocWrap = document.getElementById('docs-toc');
  var tocList = document.getElementById('docs-toc-list');

  function slugify(text) {
    return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  }

  function fail(msg) {
    article.innerHTML = '<h1>Not found</h1><p>' + msg +
      ' <a href="./">Back to the guide index</a>.</p>';
  }

  fetch('manifest.json')
    .then(function (r) { return r.json(); })
    .then(function (manifest) {
      var pages = manifest.pages;
      var param = new URLSearchParams(location.search).get('page') || 'index';
      var slug = /^[a-z0-9-]+$/.test(param) ? param : 'index';
      var idx = pages.findIndex(function (p) { return p.file === slug; });
      if (idx === -1) { buildNav(pages, 'index'); fail('That page isn’t in the guide.'); return; }
      var page = pages[idx];

      buildNav(pages, slug);
      document.title = (slug === 'index' ? 'Strand Docs' : page.title + ' — Strand Docs');

      fetch(page.file + '.md')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (md) { render(md, pages, idx); })
        .catch(function () { fail('This page failed to load.'); });
    })
    .catch(function () { fail('The guide manifest failed to load.'); });

  function buildNav(pages, current) {
    ['docs-nav', 'docs-nav-mobile'].forEach(function (id) {
      var nav = document.getElementById(id);
      if (!nav) return;
      nav.innerHTML = '';
      pages.forEach(function (p) {
        var a = document.createElement('a');
        a.href = p.file === 'index' ? './' : '?page=' + p.file;
        a.textContent = p.file === 'index' ? 'Overview' : p.title;
        if (p.file === current) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
        nav.appendChild(a);
      });
    });
  }

  function render(md, pages, idx) {
    article.innerHTML = marked.parse(md, { gfm: true, breaks: false });

    /* Rewrite doc-to-doc links (foo.md, foo.md#bar) onto the viewer. */
    article.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      var m = href.match(/^([a-z0-9-]+)\.md(#.*)?$/);
      if (m) {
        a.setAttribute('href', (m[1] === 'index' ? './' : '?page=' + m[1]) + (m[2] || ''));
      } else if (/^https?:\/\//.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      }
    });

    /* Heading anchors + on-this-page rail. */
    var used = {};
    var entries = [];
    article.querySelectorAll('h2, h3').forEach(function (h) {
      var id = slugify(h.textContent);
      while (used[id]) id += '-x';
      used[id] = true;
      h.id = id;
      var link = document.createElement('a');
      link.className = 'hlink';
      link.href = '#' + id;
      link.textContent = '#';
      link.setAttribute('aria-label', 'Link to ' + h.textContent);
      h.appendChild(link);
      entries.push({ id: id, text: h.firstChild.textContent || h.textContent.replace(/#$/, ''), lv: h.tagName === 'H3' ? 3 : 2 });
    });
    if (entries.length > 1 && tocWrap) {
      tocList.innerHTML = '';
      entries.forEach(function (e) {
        var a = document.createElement('a');
        a.href = '#' + e.id;
        a.textContent = e.text;
        if (e.lv === 3) a.className = 'lv3';
        tocList.appendChild(a);
      });
      tocWrap.hidden = false;
    }

    /* Horizontal scroll containers for wide tables. */
    article.querySelectorAll('table').forEach(function (t) {
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });

    /* Prev / next pager from manifest order. */
    var pager = document.createElement('div');
    pager.className = 'docs-pager';
    var prev = pages[idx - 1];
    var next = pages[idx + 1];
    if (prev) pager.appendChild(pagerLink(prev, 'Previous', 'pager-prev'));
    if (next) pager.appendChild(pagerLink(next, 'Next', 'pager-next'));
    if (prev || next) article.appendChild(pager);

    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  function pagerLink(p, dir, cls) {
    var a = document.createElement('a');
    a.className = cls;
    a.href = p.file === 'index' ? './' : '?page=' + p.file;
    a.innerHTML = '<span class="pager-dir">' + dir + '</span><span class="pager-title"></span>';
    a.querySelector('.pager-title').textContent = p.file === 'index' ? 'Strand User Guide' : p.title;
    return a;
  }
})();
