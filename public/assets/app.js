'use strict';
(() => {
  /* ---------- константы ---------- */
  const ATM = { 1: 1.0, 2: 1.0675, 3: 1.1349, 4: 1.2024, 5: 1.2699, 6: 1.3373, 7: 1.4048, 8: 1.4723, 9: 1.5397, 10: 1.6072 };
  const ZM = { 1: 1.12, 2: 1.34, 3: 1.5, 4: 1.62, 5: 1.72, 6: 1.81, 7: 1.88, 8: 1.94, 9: 2.0 };
  const AI_NAMES = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok'];
  const USERS_KEY = '__users';
  const WIKI_HOST = 'minecraft-backrooms.fandom.com';
  const WIKI_DEFAULT = 'https://minecraft-backrooms.fandom.com/ru/wiki/';
  const DRAFT_KEY = 'wb_draft_v3';
  const PAGE = 20;

  // Статичные доверенные SVG-иконки (не содержат пользовательских данных).
  const AI_ICONS = {
    ChatGPT: '<svg class="ai-avatar-img" viewBox="0 0 24 24" fill="#10a37f" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6a6 6 0 0 1 6 6h-6V6z" fill="#fff"/></svg>',
    Claude: '<svg class="ai-avatar-img" viewBox="0 0 24 24" fill="#d97706" aria-hidden="true"><rect width="20" height="20" x="2" y="2" rx="5"/><text x="12" y="16" font-weight="900" font-size="12" fill="#fff" text-anchor="middle">C</text></svg>',
    Gemini: '<svg class="ai-avatar-img" viewBox="0 0 24 24" fill="#3b82f6" aria-hidden="true"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9Z"/></svg>',
    DeepSeek: '<svg class="ai-avatar-img" viewBox="0 0 24 24" fill="#0284c7" aria-hidden="true"><circle cx="12" cy="12" r="10"/><text x="12" y="15.5" font-weight="900" font-size="9" fill="#fff" text-anchor="middle">DS</text></svg>',
    Grok: '<svg class="ai-avatar-img" viewBox="0 0 24 24" fill="#ef4444" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="3"/><text x="12" y="16" font-weight="900" font-size="12" fill="#fff" text-anchor="middle">G</text></svg>',
  };

  const state = {
    authors: [], users: [], reviews: [], pending: [], myReviews: [],
    me: null, myAuthorId: null, admin: false, loaded: false, config: {}, idx: null,
    feedLimit: PAGE, authorTab: 'articles', userTab: 'reviews', editingAuthor: null,
    authMode: 'login', turnstileToken: '', turnstileId: null, tsLoading: false, wikiLoaded: false,
  };

  /* ---------- утилиты ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const lc = (s) => String(s || '').toLowerCase();
  const norm = (s) => lc(s).replace(/ё/g, 'е');
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const limits = () => ({ body: (state.config.limits && state.config.limits.body) || 10000, bio: (state.config.limits && state.config.limits.bio) || 600 });

  // Безопасное создание DOM: весь пользовательский текст вставляется только как textContent.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function toast(message, kind = '') {
    const el = h('div', { class: `toast ${kind}` }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 5500);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch('/api' + path, init); } catch { throw new Error('Нет связи с сервером'); }
    let data = null;
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
    return data;
  }

  const plural = (n, [a, b, c]) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const cnt = (n, forms) => `${n} ${plural(n, forms)}`;
  const F_REV = ['рецензия', 'рецензии', 'рецензий'];
  const F_ART = ['статья', 'статьи', 'статей'];
  const avg = (list) => (list.length ? list.reduce((s, r) => s + r.score, 0) / list.length : 0);
  const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString('ru-RU', { dateStyle: 'long' });
  const calcScore = (c) => Math.min(90, Math.round((c[0] + c[1] + c[2] + c[3]) * 1.4 * ATM[c[4]]));
  const articleHref = (t) => '#/article/' + encodeURIComponent(t);
  const authorHref = (id) => '#/author/' + encodeURIComponent(id);
  const userHref = (name) => '#/user/' + encodeURIComponent(name);
  const tier = (s) => (s >= 80 ? 'tier-s' : s >= 65 ? 'tier-a' : s >= 45 ? 'tier-b' : 'tier-c');

  function hue(str) { let x = 0; for (const ch of String(str)) x = (x * 31 + ch.codePointAt(0)) % 360; return x; }

  function avatar(name, url, cls = '') {
    const make = () => {
      const d = h('div', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, ([...String(name || '?')][0] || '?').toUpperCase());
      d.style.background = `linear-gradient(135deg, hsl(${hue(name)} 62% 44%), hsl(${(hue(name) + 55) % 360} 62% 30%))`;
      return d;
    };
    if (!url) return make();
    const img = h('img', { class: `avatar ${cls}`, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(make()));
    return img;
  }

  function banner(name, cls = 'banner') {
    const d = h('div', { class: cls, 'aria-hidden': 'true' });
    const a = hue(name);
    d.style.background = `linear-gradient(120deg, hsl(${a} 55% 28%), hsl(${(a + 70) % 360} 60% 22%))`;
    return d;
  }

  const scoreRing = (value, cls = '') => h('div', { class: `score-ring ${tier(value)} ${cls}`, title: 'Балл из 90' },
    h('span', { class: 'sr-num' }, String(Math.round(value))), h('span', { class: 'sr-max' }, '/90'));

  const statsRow = (items, cls = '') => h('div', { class: `stats-row ${cls}` }, items.map(([val, label]) =>
    h('div', { class: 'stat-box' }, h('div', { class: 'stat-box-val' }, String(val)), h('div', { class: 'stat-box-lbl' }, label))));

  const emptyBox = (text) => h('div', { class: 'empty' }, text);

  /* ---------- индекс данных ---------- */
  function buildIndex() {
    const idx = { authors: new Map(), users: new Map(), byAuthor: new Map(), byUser: new Map(), articles: [] };
    const push = (map, key, r) => { if (!map.has(key)) map.set(key, []); map.get(key).push(r); };
    state.authors.forEach((a) => idx.authors.set(a.id, a));
    state.users.forEach((u) => idx.users.set(lc(u.username), u));
    const arts = new Map();
    for (const r of state.reviews) {
      push(idx.byAuthor, r.authorId, r);
      if (r.registered && r.reviewerKind === 'user') push(idx.byUser, lc(r.reviewerName), r);
      const key = lc(r.articleTitle);
      if (!arts.has(key)) arts.set(key, { title: r.articleTitle, authorId: r.authorId, reviews: [] });
      arts.get(key).reviews.push(r);
    }
    idx.articles = [...arts.values()].map((a) => ({
      ...a, avg: avg(a.reviews), max: Math.max(...a.reviews.map((r) => r.score)), latest: Math.max(...a.reviews.map((r) => r.createdAt)),
    }));
    state.idx = idx;
  }

  const authorReviews = (id) => (state.idx.byAuthor.get(id) || []);
  const userReviews = (name) => (state.idx.byUser.get(lc(name)) || []);
  const uniqueTitles = (list) => new Set(list.map((r) => lc(r.articleTitle))).size;
  const authorOfUser = (name) => state.authors.find((a) => a.ownerUsername && lc(a.ownerUsername) === lc(name));
  const canEditAuthor = (a) => state.admin || (!!state.me && !!a.ownerUsername && lc(a.ownerUsername) === lc(state.me.username));

  function authorBadge(count, average) {
    if (!count) return 'Без рецензий';
    if (average >= 80 && count >= 2) return '🌟 Легенда Закулисья';
    if (average >= 65) return '🏆 Мастер атмосферы';
    return count >= 3 ? 'Опытный автор' : 'Новичок вики';
  }
  function userBadge(count) {
    if (count >= 20) return '🏅 Ветеран критики';
    if (count >= 5) return '⭐ Активный критик';
    return count >= 1 ? 'Критик' : 'Новичок';
  }

  /* ---------- карточки ---------- */
  function authorCard(a) {
    const rs = authorReviews(a.id);
    const average = avg(rs);
    return h('a', { class: 'entity-card', href: authorHref(a.id) },
      banner(a.name),
      h('div', { class: 'ec-body' },
        avatar(a.name, a.avatar, 'avatar-lg ec-avatar'),
        h('div', { class: 'ec-name' }, a.name),
        h('div', { class: 'ec-badge' }, authorBadge(rs.length, average)),
        h('p', { class: 'ec-bio' }, a.bio || 'Описание пока не добавлено.'),
        statsRow([[uniqueTitles(rs), 'Статей'], [rs.length, 'Рецензий'], [rs.length ? average.toFixed(1) : '—', 'Ср. балл']])));
  }

  function userCard(u) {
    const rs = userReviews(u.username);
    const own = authorOfUser(u.username);
    return h('a', { class: 'entity-card', href: userHref(u.username) },
      banner(u.username),
      h('div', { class: 'ec-body' },
        avatar(u.username, u.avatar, 'avatar-lg ec-avatar'),
        h('div', { class: 'ec-name' }, u.username, u.banned ? h('span', { class: 'chip chip-warn' }, 'заблокирован') : null),
        h('div', { class: 'ec-badge' }, own ? `✍️ Автор: ${own.name}` : userBadge(rs.length)),
        h('p', { class: 'ec-bio' }, u.bio || 'Пользователь пока ничего не рассказал о себе.'),
        statsRow([[rs.length, 'Рецензий'], [uniqueTitles(rs), 'Статей'], [rs.length ? avg(rs).toFixed(1) : '—', 'Ср. оценка']])));
  }

  function articleCard(art) {
    const author = state.idx.authors.get(art.authorId);
    return h('a', { class: 'article-card', href: articleHref(art.title) },
      scoreRing(art.avg),
      h('div', { class: 'ac-main' },
        h('div', { class: 'ac-title' }, art.title),
        h('div', { class: 'ac-meta' }, 'Автор: ', author ? author.name : 'Неизвестный'),
        h('div', { class: 'ac-chips' },
          h('span', { class: 'chip' }, cnt(art.reviews.length, F_REV)),
          h('span', { class: 'chip' }, `макс. ${art.max}`),
          h('span', { class: 'chip' }, fmtDay(art.latest)))));
  }

  function reviewerTag(r) {
    if (r.reviewerKind === 'ai') {
      const tag = h('span', { class: 'ai-reviewer-tag' });
      if (Object.hasOwn(AI_ICONS, r.reviewerName)) {
        const icon = document.createElement('span');
        icon.innerHTML = AI_ICONS[r.reviewerName]; // константа из этого файла
        tag.append(icon);
      }
      tag.append(' ' + r.reviewerName);
      return tag;
    }

    const user = r.registered ? state.idx.users.get(lc(r.reviewerName)) : null;
    const tag = user
      ? h('a', { class: 'ai-reviewer-tag user-reviewer-tag', href: userHref(r.reviewerName) })
      : h('span', { class: 'ai-reviewer-tag user-reviewer-tag' });
    tag.append(
      avatar(r.reviewerName, user?.avatar, 'reviewer-avatar'),
      h('span', null, r.reviewerName)
    );
    return tag;
  }

  async function copyReviewLink(id) {
    const url = `${location.origin}${location.pathname}#/review/${encodeURIComponent(id)}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = h('textarea', { class: 'sr-only', readonly: true });
        input.value = url;
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('Не удалось скопировать ссылку');
      }
      toast('Ссылка на рецензию скопирована', 'ok');
    } catch {
      toast('Не удалось скопировать ссылку. Попробуйте скопировать адрес вручную.', 'error');
    }
  }

  function reviewCard(r, { moderation = false, showStatus = false } = {}) {
    const author = state.idx.authors.get(r.authorId) || { name: 'Неизвестный автор' };
    const actions = [];
    if (r.status === 'approved') {
      actions.push(h('button', { type: 'button', class: 'btn btn-outline', onclick: () => copyReviewLink(r.id) }, '🔗 Копировать ссылку'));
    }
    if (state.admin) {
      if (moderation) actions.push(h('button', { type: 'button', class: 'btn btn-ok', onclick: () => moderate(r.id, 'approve') }, '✓ Одобрить'));
      actions.push(h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: () => moderate(r.id, 'delete') }, '🗑 Удалить'));
    }
    const long = r.text.length > 700;
    const text = h('div', { class: 'review-text' + (long ? ' clamped' : '') }, r.text);
    const more = long ? h('button', { type: 'button', class: 'link-btn', onclick: (e) => {
      const c = text.classList.toggle('clamped');
      e.currentTarget.textContent = c ? 'Показать полностью' : 'Свернуть';
    } }, 'Показать полностью') : null;
    return h('article', { class: 'review-card', id: `review-${r.id}` },
      h('div', { class: 'review-top-bar' },
        h('div', null,
          h('h3', { class: 'review-main-title' }, r.reviewTitle),
          h('div', { class: 'review-meta' },
            h('a', { class: 'review-article-title', href: articleHref(r.articleTitle) }, 'Статья: ', h('strong', null, r.articleTitle)),
            h('a', { class: 'review-article-title', href: authorHref(r.authorId) }, 'Автор: ' + author.name))),
        h('div', { class: 'score-breakdown-box' },
          h('div', { class: 'score-total-display' }, String(r.score), h('span', { class: 'muted small' }, ' / 90')),
          h('div', { class: 'score-criteria-display', title: 'Критерии' }, r.criteria.join(' ')))),
      h('div', { class: 'row-gap' }, reviewerTag(r),
        showStatus ? h('span', { class: `chip ${r.status === 'approved' ? 'chip-ok' : 'chip-warn'}` }, r.status === 'approved' ? '✓ Опубликовано' : '⏳ На модерации') : null),
      text, more,
      h('div', { class: 'review-date' }, fmtDate(r.createdAt)),
      actions.length ? h('div', { class: 'review-actions' }, actions) : null);
  }

  function profileHero({ name, avatarUrl, badge, lines = [], bio, stats, actions = [] }) {
    return h('div', { class: 'profile-hero' },
      banner(name, 'ph-banner'),
      h('div', { class: 'ph-body' },
        avatar(name, avatarUrl, 'avatar-xl ph-avatar'),
        h('div', { class: 'ph-info' },
          h('h2', { class: 'ph-name' }, name),
          badge ? h('div', { class: 'ec-badge' }, badge) : null,
          lines.map((l) => h('div', { class: 'muted small' }, l))),
        actions.length ? h('div', { class: 'ph-actions' }, actions) : null),
      h('p', { class: 'ph-bio' + (bio ? '' : ' muted') }, bio || 'Описание пока не добавлено.'),
      statsRow(stats, 'ph-stats'));
  }

  const tabButtons = (items, current, onPick) => h('div', { class: 'sub-tabs' }, items.map(([key, label]) =>
    h('button', { type: 'button', class: 'sub-tab-btn' + (current === key ? ' active' : ''), onclick: () => onPick(key) }, label)));

  /* ---------- страницы ---------- */
  function renderHome() {
    const hero = $('#heroContainer');
    hero.replaceChildren();
    const rs = state.reviews;
    if (rs.length) {
      const top = [...rs].sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)[0];
      const author = state.idx.authors.get(top.authorId) || { name: 'Неизвестный' };
      hero.append(h('a', { class: 'hero-featured', href: articleHref(top.articleTitle) },
        h('div', { class: 'hero-badge' }, '🏆 Топ-1 статья портала'),
        h('div', { class: 'hero-title' }, top.articleTitle),
        h('div', { class: 'hero-meta' }, 'Автор: ', h('strong', null, author.name), ' • Оценка: ', h('strong', { class: 'gold' }, `${top.score} / 90`)),
        h('div', { class: 'hero-quote' }, '«' + top.text.slice(0, 300) + '»')));
    }
    $('#statTotalReviews').textContent = String(rs.length);
    $('#statAvgScore').textContent = `${avg(rs).toFixed(1)} / 90`;
    $('#statArticles').textContent = String(state.idx.articles.length);
    $('#statUsers').textContent = String(state.users.length);

    const tops = state.authors.map((a) => ({ a, n: authorReviews(a.id).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 5);
    $('#homeTopAuthorsList').replaceChildren(...(tops.length
      ? tops.map(({ a, n }) => h('div', { class: 'top-author-row' },
        h('a', { class: 'row-gap', href: authorHref(a.id) }, avatar(a.name, a.avatar, 'avatar-xs'), a.name),
        h('span', { class: 'muted small' }, cnt(n, F_REV))))
      : [emptyBox('Пока пусто.')]));

    const sort = $('#feedSortSelect').value;
    const sorted = [...rs];
    if (sort === 'highest') sorted.sort((a, b) => b.score - a.score);
    else if (sort === 'lowest') sorted.sort((a, b) => a.score - b.score);
    else sorted.sort((a, b) => b.createdAt - a.createdAt);
    $('#recentFeed').replaceChildren(...(sorted.length
      ? sorted.slice(0, state.feedLimit).map((r) => reviewCard(r))
      : [emptyBox(state.loaded ? 'Нет рецензий для отображения.' : 'Загрузка…')]));
    $('#feedMoreBtn').hidden = sorted.length <= state.feedLimit;
  }

  function renderArticlesList() {
    const q = norm($('#articlesSearch').value.trim());
    const sort = $('#articlesSort').value;
    let list = state.idx.articles.filter((a) => !q || norm(a.title).includes(q));
    const by = {
      rating: (a, b) => b.avg - a.avg, reviews: (a, b) => b.reviews.length - a.reviews.length,
      new: (a, b) => b.latest - a.latest, name: (a, b) => a.title.localeCompare(b.title, 'ru'),
    };
    list = list.sort(by[sort] || by.rating);
    $('#articlesCount').textContent = cnt(list.length, F_ART);
    $('#articlesGrid').replaceChildren(...(list.length ? list.map(articleCard) : [emptyBox(q ? 'Ничего не найдено.' : 'Статей пока нет.')]));
  }

  function renderArticle(title) {
    const head = $('#articleHeaderCard');
    const list = $('#articleReviewsList');
    const article = state.idx.articles.find((a) => lc(a.title) === lc(title));
    if (!article) {
      head.replaceChildren(h('div', { class: 'empty' }, state.loaded ? 'Статья не найдена.' : 'Загрузка…'));
      list.replaceChildren();
      return;
    }
    const sort = $('#articleReviewsSortSelect').value;
    const rs = [...article.reviews];
    if (sort === 'oldest') rs.sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === 'highest') rs.sort((a, b) => b.score - a.score);
    else if (sort === 'lowest') rs.sort((a, b) => a.score - b.score);
    else rs.sort((a, b) => b.createdAt - a.createdAt);

    const author = state.idx.authors.get(article.authorId) || { id: 'a1', name: 'Неизвестный автор' };
    head.replaceChildren(h('div', { class: 'rzt-card' },
      scoreRing(article.avg, 'ring-xl'),
      h('div', { class: 'rzt-details' },
        h('div', { class: 'rzt-tags' }, h('span', { class: 'rzt-tag' }, '📄 Статья вики'), h('span', { class: 'rzt-tag rzt-tag-accent' }, 'Закулисье')),
        h('h2', { class: 'rzt-title' }, article.title),
        h('a', { class: 'row-gap author-inline', href: authorHref(author.id) }, avatar(author.name, author.avatar, 'avatar-xs'), 'Автор: ', h('strong', null, author.name)),
        statsRow([[article.reviews.length, 'Рецензий'], [Math.round(article.avg), 'Ср. балл'], [article.max, 'Макс. балл'], [Math.min(...article.reviews.map((r) => r.score)), 'Мин. балл']], 'inline-stats'))));
    list.replaceChildren(...rs.map((r) => reviewCard(r)));
    document.title = `${article.title} — рецензии | Закулисье Майнкрафта Вики`;
  }

  function renderAuthorsList() {
    const q = norm($('#authorsSearch').value.trim());
    const sort = $('#authorsSort').value;
    const list = state.authors.filter((a) => !q || norm(a.name + ' ' + a.bio).includes(q));
    const by = {
      reviews: (a, b) => authorReviews(b.id).length - authorReviews(a.id).length,
      rating: (a, b) => avg(authorReviews(b.id)) - avg(authorReviews(a.id)),
      name: (a, b) => a.name.localeCompare(b.name, 'ru'),
    };
    list.sort(by[sort] || by.reviews);
    $('#authorsGridContainer').replaceChildren(...(list.length ? list.map(authorCard) : [emptyBox('Авторы не найдены.')]));
  }

  function authorEditForm(a) {
    const name = h('input', { class: 'input-field', id: 'aeName', type: 'text', maxlength: 60, minlength: 2, required: true, value: a.name });
    const url = h('input', { class: 'input-field', id: 'aeAvatar', type: 'url', maxlength: 300, placeholder: 'https://…', value: a.avatar || '' });
    const bio = h('textarea', { class: 'input-field', id: 'aeBio', rows: 4, maxlength: limits().bio }, a.bio || '');
    const owner = state.admin ? h('input', { class: 'input-field', id: 'aeOwner', type: 'text', maxlength: 24, placeholder: 'ник пользователя (пусто — не привязана)', value: a.ownerUsername || '' }) : null;
    return h('form', { class: 'inline-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api(`/authors/${encodeURIComponent(a.id)}`, { method: 'POST', body: { name: name.value, avatar: url.value.trim(), bio: bio.value } });
        if (owner && owner.value.trim() !== (a.ownerUsername || '')) {
          await api(`/admin/authors/${encodeURIComponent(a.id)}/owner`, { method: 'POST', body: { username: owner.value.trim() } });
        }
        state.editingAuthor = null;
        toast('Карточка автора сохранена', 'ok');
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
    } },
      h('label', { class: 'field-label', for: 'aeName' }, 'Имя автора'), name,
      h('label', { class: 'field-label', for: 'aeAvatar' }, 'Ссылка на аватар (https)'), url,
      h('label', { class: 'field-label', for: 'aeBio' }, `О себе (до ${limits().bio} символов)`), bio,
      owner ? [h('label', { class: 'field-label', for: 'aeOwner' }, 'Владелец карточки (может редактировать её сам)'), owner] : null,
      h('div', { class: 'row-gap end' },
        h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { state.editingAuthor = null; route(); } }, 'Отмена'),
        h('button', { type: 'submit', class: 'btn btn-purple' }, 'Сохранить')));
  }

  function renderAuthorPage(id) {
    const box = $('#authorPage');
    const a = state.idx.authors.get(id);
    if (!a) { box.replaceChildren(h('div', { class: 'panel' }, emptyBox(state.loaded ? 'Автор не найден.' : 'Загрузка…'))); return; }
    const rs = authorReviews(a.id);
    const owner = a.ownerUsername && state.idx.users.get(lc(a.ownerUsername));
    const actions = [];
    if (canEditAuthor(a)) actions.push(h('button', { type: 'button', class: 'btn btn-purple', onclick: () => { state.editingAuthor = a.id; route(); } }, '✏️ Редактировать'));
    if (state.admin && a.id !== 'a1') {
      actions.push(h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: async () => {
        if (!confirm('Удалить автора? Его рецензии перейдут к «Неизвестному автору».')) return;
        try { await api(`/admin/authors/${encodeURIComponent(a.id)}`, { method: 'DELETE' }); location.hash = '#/authors'; toast('Автор удалён', 'ok'); await loadData(); }
        catch (err) { toast(err.message, 'error'); }
      } }, '🗑 Удалить'));
    }
    const lines = [];
    if (owner) lines.push(h('span', null, 'Аккаунт: ', h('a', { href: userHref(owner.username) }, owner.username)));
    lines.push(a.updatedAt ? `Карточка обновлена ${fmtDay(a.updatedAt)}` : '');
    const body = [profileHero({
      name: a.name, avatarUrl: a.avatar, badge: authorBadge(rs.length, avg(rs)), lines: lines.filter(Boolean), bio: a.bio, actions,
      stats: [[uniqueTitles(rs), 'Статей'], [rs.length, 'Рецензий'], [rs.length ? avg(rs).toFixed(1) : '—', 'Ср. балл'], [rs.length ? Math.max(...rs.map((r) => r.score)) : '—', 'Лучший балл']],
    })];
    if (state.editingAuthor === a.id && canEditAuthor(a)) body.push(h('div', { class: 'panel' }, h('h3', { class: 'panel-title' }, '✏️ Редактирование карточки'), authorEditForm(a)));

    const groups = new Map();
    rs.forEach((r) => { const k = lc(r.articleTitle); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const content = state.authorTab === 'articles'
      ? (groups.size ? h('div', { class: 'article-grid' }, state.idx.articles.filter((x) => groups.has(lc(x.title))).sort((x, y) => y.avg - x.avg).map(articleCard)) : emptyBox('Статей пока нет.'))
      : h('div', null, rs.length ? rs.map((r) => reviewCard(r)) : emptyBox('Рецензий нет.'));
    body.push(h('div', { class: 'panel' },
      tabButtons([['articles', '📚 Статьи'], ['reviews', '💬 Рецензии']], state.authorTab, (k) => { state.authorTab = k; route(); }), content));
    box.replaceChildren(...body);
    document.title = `${a.name} — автор | Закулисье Майнкрафта Вики`;
  }

  function renderUsersList() {
    const q = norm($('#usersSearch').value.trim());
    const sort = $('#usersSort').value;
    const list = state.users.filter((u) => !q || norm(u.username + ' ' + u.bio).includes(q));
    const by = {
      reviews: (a, b) => userReviews(b.username).length - userReviews(a.username).length,
      new: (a, b) => b.createdAt - a.createdAt,
      name: (a, b) => a.username.localeCompare(b.username, 'ru'),
    };
    list.sort(by[sort] || by.reviews);
    $('#usersGrid').replaceChildren(...(list.length ? list.map(userCard) : [emptyBox(q ? 'Пользователи не найдены.' : 'Пока никто не зарегистрировался.')]));
  }

  async function adminUserAction(u, action) {
    try {
      const base = `/admin/users/${encodeURIComponent(u.username)}/`;
      if (action === 'ban') { await api(base + 'ban', { method: 'POST', body: { banned: !u.banned } }); toast(u.banned ? 'Пользователь разблокирован' : 'Пользователь заблокирован', 'ok'); }
      if (action === 'password') {
        const p = prompt(`Новый пароль для «${u.username}» (минимум 8 символов):`);
        if (!p) return;
        await api(base + 'password', { method: 'POST', body: { password: p } });
        toast('Пароль изменён, пользователь разлогинен', 'ok');
      }
      if (action === 'delete') {
        if (!confirm(`Удалить аккаунт «${u.username}»? Рецензии останутся, но отвяжутся от профиля.`)) return;
        await api(base + 'delete', { method: 'POST', body: {} });
        location.hash = '#/users';
        toast('Аккаунт удалён', 'ok');
      }
      await loadData();
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderUserPage(username) {
    const box = $('#userPage');
    const u = state.idx.users.get(lc(username));
    if (!u) { box.replaceChildren(h('div', { class: 'panel' }, emptyBox(state.loaded ? 'Пользователь не найден.' : 'Загрузка…'))); return; }
    const rs = userReviews(u.username);
    const own = authorOfUser(u.username);
    const actions = [];
    if (state.me && lc(state.me.username) === lc(u.username)) actions.push(h('a', { class: 'btn btn-purple', href: '#/profile' }, '✏️ Редактировать профиль'));
    if (state.admin) {
      actions.push(
        h('button', { type: 'button', class: 'btn btn-outline', onclick: () => adminUserAction(u, 'ban') }, u.banned ? '♻️ Разблокировать' : '⛔ Заблокировать'),
        h('button', { type: 'button', class: 'btn btn-outline', onclick: () => adminUserAction(u, 'password') }, '🔑 Сбросить пароль'),
        h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: () => adminUserAction(u, 'delete') }, '🗑 Удалить'));
    }
    const lines = [`На сайте с ${fmtDay(u.createdAt)}`];
    if (u.banned) lines.push('⛔ Аккаунт заблокирован');
    const body = [profileHero({
      name: u.username, avatarUrl: u.avatar, badge: userBadge(rs.length), lines, bio: u.bio, actions,
      stats: [[rs.length, 'Рецензий'], [uniqueTitles(rs), 'Статей'], [rs.length ? avg(rs).toFixed(1) : '—', 'Ср. оценка'], [rs.length ? Math.max(...rs.map((r) => r.score)) : '—', 'Макс. оценка']],
    })];
    if (own) body.push(h('div', { class: 'panel' }, h('h3', { class: 'panel-title' }, '✍️ Карточка автора'), authorCard(own)));
    const arts = state.idx.articles.filter((x) => x.reviews.some((r) => r.registered && lc(r.reviewerName) === lc(u.username)));
    const content = state.userTab === 'reviews'
      ? h('div', null, rs.length ? rs.map((r) => reviewCard(r)) : emptyBox('Рецензий пока нет.'))
      : (arts.length ? h('div', { class: 'article-grid' }, arts.map(articleCard)) : emptyBox('Статей пока нет.'));
    body.push(h('div', { class: 'panel' }, tabButtons([['reviews', '💬 Рецензии'], ['articles', '📚 Оценённые статьи']], state.userTab, (k) => { state.userTab = k; route(); }), content));
    box.replaceChildren(...body);
    document.title = `${u.username} — профиль | Закулисье Майнкрафта Вики`;
  }

  function renderSearch(q) {
    const raw = (q || '').trim();
    const query = norm(raw);
    $('#globalSearch').value = raw;
    $('#searchTitle').textContent = raw ? `Результаты поиска: «${raw}»` : 'Поиск';
    const box = $('#searchResults');
    if (!query) { box.replaceChildren(emptyBox('Введите название статьи, имя автора или ник пользователя.')); return; }
    const arts = state.idx.articles.filter((a) => norm(a.title).includes(query));
    const auths = state.authors.filter((a) => norm(a.name + ' ' + a.bio).includes(query));
    const usrs = state.users.filter((u) => norm(u.username + ' ' + u.bio).includes(query));
    const revs = state.reviews.filter((r) => norm(r.reviewTitle).includes(query)).slice(0, 10);
    const group = (title, items, gridCls, mapFn) => items.length ? h('section', { class: 'result-group' }, h('h3', { class: 'section-title mb-10' }, `${title} (${items.length})`), h('div', { class: gridCls }, items.map(mapFn))) : null;
    const parts = [
      group('📚 Статьи', arts, 'article-grid', articleCard),
      group('✍️ Авторы', auths, 'card-grid', authorCard),
      group('👤 Пользователи', usrs, 'card-grid', userCard),
      group('💬 Рецензии по заголовку', revs, 'review-list', (r) => reviewCard(r)),
    ].filter(Boolean);
    box.replaceChildren(...(parts.length ? parts : [emptyBox('Ничего не найдено. Попробуйте другое слово.')]));
  }

  function renderCritics() {
    const sel = $('#aiViewerSelect');
    if (!sel.options.length) sel.append(...AI_NAMES.map((n) => h('option', { value: n }, n)), h('option', { value: USERS_KEY }, '👤 Пользователи'));
    const key = sel.value || AI_NAMES[0];
    const isUsers = key === USERS_KEY;
    const list = state.reviews.filter((r) => (isUsers ? r.reviewerKind === 'user' : r.reviewerKind === 'ai' && r.reviewerName === key));
    const icon = h('div', null);
    if (!isUsers && Object.hasOwn(AI_ICONS, key)) icon.innerHTML = AI_ICONS[key]; // константа из этого файла
    $('#aiProfileContent').replaceChildren(
      h('div', { class: 'row-gap mb-12' }, icon, h('div', null,
        h('h2', { class: 'section-title' }, isUsers ? 'Пользователи' : key),
        h('div', { class: 'muted small' }, 'Средняя оценка: ', h('strong', { class: 'purple-text' }, `${avg(list).toFixed(1)} / 90`), ` | ${cnt(list.length, F_REV)}`))),
      ...(list.length ? list.map((r) => reviewCard(r)) : [emptyBox('Рецензий пока нет.')]));
  }

  function renderModeration() {
    $('#moderationList').replaceChildren(...(state.pending.length ? state.pending.map((r) => reviewCard(r, { moderation: true })) : [emptyBox('Очередь пуста.')]));
  }

  function renderProfile() {
    const me = state.me;
    $('#profileGuest').hidden = !!me;
    $('#profileBox').hidden = !me;
    if (!me) return;
    const lim = limits();
    $('#profileAvatarPreview').replaceChildren(avatar(me.username, me.avatar, 'avatar-xl'));
    $('#profileUsername').textContent = me.username;
    $('#profileSince').textContent = `На сайте с ${fmtDay(me.createdAt)}`;
    $('#profileViewLink').href = userHref(me.username);
    $('#profileAvatarFile').value = '';
    $('#profileBio').value = me.bio || '';
    $('#profileBio').maxLength = lim.bio;
    $('#profileBioCounter').textContent = `${[...me.bio || ''].length} / ${lim.bio}`;

    const mine = state.authors.find((a) => a.id === state.myAuthorId);
    $('#createMyAuthorForm').hidden = !!mine;
    $('#myAuthorBio').maxLength = lim.bio;
    if (!$('#myAuthorName').value) $('#myAuthorName').value = me.username;
    $('#myAuthorBox').replaceChildren(...(mine
      ? [h('p', { class: 'muted small mb-10' }, 'У вас есть карточка автора. Её можно редактировать на странице автора.'), authorCard(mine)]
      : [h('p', { class: 'muted small mb-10' }, 'Если вы пишете статьи для вики, создайте карточку автора: она появится в разделе «Авторы», и только вы сможете её редактировать.')]));
    $('#myReviewsList').replaceChildren(...(state.myReviews.length ? state.myReviews.map((r) => reviewCard(r, { showStatus: true })) : [emptyBox('Вы ещё не писали рецензий.')]));
  }

  /* ---------- маршрутизация ---------- */
  const TITLES = {
    home: 'Закулисье Майнкрафта Вики — Экспертный портал рецензий', articles: 'Статьи', article: 'Статья', authors: 'Авторы', author: 'Автор',
    users: 'Пользователи', user: 'Профиль', critics: 'Критики', value: 'Калькулятор ценности статей ЗМВ', evaluator: 'Оценить статью',
    system: 'Формула оценки (90 баллов)', moderation: 'Модерация', profile: 'Мой профиль', search: 'Поиск',
  };
  const NAV_OF = { article: 'articles', author: 'authors', user: 'users' };

  function route() {
    if (!state.idx) return;
    const raw = location.hash.replace(/^#\/?/, '');
    const [nameRaw, ...rest] = raw.split('/');
    let name = Object.hasOwn(TITLES, nameRaw) || nameRaw === 'review' ? nameRaw : 'home';
    let param = rest.length ? safeDecode(rest.join('/')) : null;
    let focusReviewId = null;
    if (name === 'review') {
      const targetReview = state.reviews.find((r) => r.id === param);
      if (targetReview) {
        focusReviewId = targetReview.id;
        param = targetReview.articleTitle;
        name = 'article';
      } else {
        name = 'home';
        param = null;
      }
    }
    if (name === 'authors' && param) name = 'author';
    if (name === 'users' && param) name = 'user';
    if (name === 'article' && !param) name = 'articles';
    if (name === 'moderation' && !state.admin) name = 'home';

    $$('.tab-content').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
    const navName = NAV_OF[name] || name;
    $$('.nav-btn').forEach((a) => {
      const on = a.dataset.route === navName;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (name !== 'search') $('#globalSearch').value = '';
    document.title = name === 'home' ? TITLES.home : `${TITLES[name]} | Закулисье Майнкрафта Вики`;

    if (name === 'home') renderHome();
    if (name === 'articles') renderArticlesList();
    if (name === 'article') {
      renderArticle(param);
      if (focusReviewId) requestAnimationFrame(() => {
        const target = document.getElementById(`review-${focusReviewId}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('review-link-target');
          setTimeout(() => target.classList.remove('review-link-target'), 2400);
        }
      });
    }
    if (name === 'authors') renderAuthorsList();
    if (name === 'author') renderAuthorPage(param);
    if (name === 'users') renderUsersList();
    if (name === 'user') renderUserPage(param);
    if (name === 'critics') renderCritics();
    if (name === 'value') recalcZmvi();
    if (name === 'evaluator') ensureWiki();
    if (name === 'moderation') renderModeration();
    if (name === 'profile') renderProfile();
    if (name === 'search') renderSearch(param);
  }

  function renderAuthBox() {
    const box = $('#authBox');
    if (state.me) {
      box.replaceChildren(
        h('a', { class: 'user-chip', href: '#/profile', title: 'Мой профиль' }, avatar(state.me.username, state.me.avatar, 'avatar-xs'), h('span', null, state.me.username)),
        h('button', { type: 'button', class: 'btn btn-outline', onclick: logoutUser }, 'Выйти'));
    } else {
      box.replaceChildren(
        h('button', { type: 'button', class: 'btn btn-outline', onclick: () => openAuth('login') }, 'Войти'),
        h('button', { type: 'button', class: 'btn', onclick: () => openAuth('register') }, 'Регистрация'));
    }
  }

  function syncAuthorSelect() {
    const sel = $('#authorSelect');
    const prev = sel.value;
    sel.replaceChildren(...state.authors.map((a) => h('option', { value: a.id }, a.name)));
    if (prev && state.authors.some((a) => a.id === prev)) sel.value = prev;
    $('#articleList').replaceChildren(...state.idx.articles.map((a) => h('option', { value: a.title })));
  }

  function updateEvaluatorUi() {
    $('#adminReviewerBlock').hidden = !state.admin;
    const aiMode = state.admin && $('#reviewerKind').value === 'ai';
    $('#aiProfile').hidden = !aiMode;
    const ident = $('#reviewerIdentity');
    ident.hidden = aiMode;
    ident.replaceChildren(...(state.me ? ['Рецензент: ', h('strong', null, state.me.username)] : ['Вы не вошли в аккаунт']));
    $('#loginPrompt').hidden = !!state.me || aiMode;
    $('#moderationNote').hidden = state.admin;
  }

  function setAdmin(on) {
    state.admin = on;
    document.body.classList.toggle('admin-mode', on);
    $('#adminLoginLink').hidden = on;
    updateEvaluatorUi();
  }

  function rerender() {
    buildIndex();
    syncAuthorSelect();
    const b = $('#pendingBadge');
    b.textContent = String(state.pending.length);
    b.hidden = !state.pending.length;
    renderAuthBox();
    updateEvaluatorUi();
    route();
  }

  /* ---------- данные и сессия ---------- */
  async function loadSession() {
    try {
      const me = await api('/me');
      state.me = me.user;
      state.myAuthorId = me.authorId;
    } catch { state.me = null; state.myAuthorId = null; }
    try { setAdmin((await api('/admin/me')).admin); } catch { setAdmin(false); }
  }

  async function loadData() {
    const err = $('#loadError');
    try {
      const data = await api('/data');
      state.authors = data.authors; state.reviews = data.reviews; state.users = data.users || [];
      state.loaded = true;
      err.hidden = true;
    } catch (e) {
      state.loaded = true;
      err.hidden = false;
      err.replaceChildren('Не удалось загрузить данные: ' + e.message + ' ', h('button', { type: 'button', class: 'btn btn-outline', onclick: () => loadData() }, 'Повторить'));
    }
    state.pending = []; state.myReviews = [];
    if (state.admin) { try { state.pending = (await api('/admin/pending')).reviews; } catch { /* нет прав */ } }
    if (state.me) { try { state.myReviews = (await api('/me/reviews')).reviews; } catch { /* ignore */ } }
    rerender();
  }

  async function refreshAll() { await loadSession(); await loadData(); }

  async function moderate(id, action) {
    try {
      if (action === 'approve') await api(`/admin/reviews/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} });
      else {
        if (!confirm('Удалить эту рецензию?')) return;
        await api(`/admin/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      toast(action === 'approve' ? 'Рецензия опубликована' : 'Рецензия удалена', 'ok');
      await loadData();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------- вход, регистрация ---------- */
  function ensureTurnstile() {
    const key = state.config.turnstileSiteKey;
    const box = $('#turnstileBox');
    const need = !!key && state.authMode === 'register';
    box.hidden = !need;
    if (!need) return;
    const render = () => {
      if (state.turnstileId === null) {
        state.turnstileId = window.turnstile.render(box, { sitekey: key, callback: (t) => { state.turnstileToken = t; }, 'expired-callback': () => { state.turnstileToken = ''; } });
      } else { window.turnstile.reset(state.turnstileId); state.turnstileToken = ''; }
    };
    if (window.turnstile) render();
    else if (!state.tsLoading) {
      state.tsLoading = true;
      const s = h('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, defer: true });
      s.addEventListener('load', render);
      document.head.append(s);
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const reg = mode === 'register';
    $('#authTabLogin').classList.toggle('active', !reg);
    $('#authTabRegister').classList.toggle('active', reg);
    $('#authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
    $('#authPassword').autocomplete = reg ? 'new-password' : 'current-password';
    $('#authPassword').minLength = reg ? 8 : 1;
    $('#authHint').textContent = reg
      ? 'Ник: 3–24 символа (буквы, цифры, «_» и «-»). Пароль: от 8 символов. Почта не нужна, поэтому восстановить пароль сможет только администратор.'
      : 'Нет аккаунта? Откройте вкладку «Регистрация».';
    ensureTurnstile();
  }

  function openAuth(mode) {
    $('#authPassword').value = '';
    setAuthMode(mode);
    const d = $('#authDialog');
    if (!d.open) d.showModal();
    $('#authUsername').focus();
  }

  async function logoutUser() {
    try { await api('/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    toast('Вы вышли из аккаунта');
    if (location.hash === '#/profile') location.hash = '#/home';
    await refreshAll();
  }

  function initAuth() {
    $('#authTabLogin').addEventListener('click', () => setAuthMode('login'));
    $('#authTabRegister').addEventListener('click', () => setAuthMode('register'));
    $('#authCancel').addEventListener('click', () => $('#authDialog').close());
    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const reg = state.authMode === 'register';
      if (reg && state.config.turnstileSiteKey && !state.turnstileToken) return toast('Подтвердите, что вы не робот', 'error');
      const btn = $('#authSubmit');
      btn.disabled = true;
      try {
        const res = await api(reg ? '/register' : '/login', { method: 'POST', body: { username: $('#authUsername').value, password: $('#authPassword').value, turnstile: state.turnstileToken } });
        $('#authPassword').value = '';
        $('#authDialog').close();
        toast(reg ? `Добро пожаловать, ${res.user.username}!` : `С возвращением, ${res.user.username}!`, 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
        if (state.turnstileId !== null && window.turnstile) { window.turnstile.reset(state.turnstileId); state.turnstileToken = ''; }
      } finally { btn.disabled = false; }
    });
    $('#loginPromptBtn').addEventListener('click', () => openAuth('login'));
    $('#profileGuestLogin').addEventListener('click', () => openAuth('login'));
    $('#profileGuestRegister').addEventListener('click', () => openAuth('register'));
  }

  /* ---------- профиль ---------- */
  async function compressAvatar(file) {
    const imageUrl = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Не удалось обработать изображение');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.92, 0.88, 0.84, 0.8]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
        if (!blob) throw new Error('Не удалось обработать изображение');
        if (blob.size <= 350 * 1024) return blob;
      }
      throw new Error('Изображение слишком сложное. Попробуйте файл поменьше.');
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }

  function initProfile() {
    let selectedAvatarFile = null;
    let previewObjectUrl = null;
    $('#profileBio').addEventListener('input', () => { $('#profileBioCounter').textContent = `${[...$('#profileBio').value].length} / ${limits().bio}`; });
    $('#profileAvatarFile').addEventListener('change', () => {
      selectedAvatarFile = $('#profileAvatarFile').files[0] || null;
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = selectedAvatarFile ? URL.createObjectURL(selectedAvatarFile) : null;
      $('#profileAvatarPreview').replaceChildren(avatar(
        state.me ? state.me.username : '?',
        previewObjectUrl || (state.me && state.me.avatar) || '',
        'avatar-xl',
      ));
    });
    $('#profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.currentTarget.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        if (selectedAvatarFile) {
          const compressed = await compressAvatar(selectedAvatarFile);
          const formData = new FormData();
          formData.append('avatar', compressed, 'avatar.webp');
          const res = await fetch('/api/me/avatar', { method: 'POST', credentials: 'same-origin', body: formData });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
          selectedAvatarFile = null;
          if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
          previewObjectUrl = null;
        }
        await api('/me/profile', { method: 'POST', body: { bio: $('#profileBio').value } });
        toast('Профиль сохранён', 'ok');
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
      finally { btn.disabled = false; }
    });
    $('#passwordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        await api('/me/password', { method: 'POST', body: { current: $('#pwCurrent').value, password: $('#pwNew').value } });
        form.reset();
        toast('Пароль изменён, остальные сессии завершены', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#deleteAccountForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (!confirm('Удалить аккаунт безвозвратно? Ваши рецензии останутся на сайте, но будут отвязаны от профиля.')) return;
      try {
        await api('/me/delete', { method: 'POST', body: { password: $('#deletePassword').value } });
        form.reset();
        location.hash = '#/home';
        toast('Аккаунт удалён', 'ok');
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#createMyAuthorForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('/authors', { method: 'POST', body: { name: $('#myAuthorName').value, avatar: $('#myAuthorAvatar').value.trim(), bio: $('#myAuthorBio').value } });
        toast('Карточка автора создана', 'ok');
        await refreshAll();
        location.hash = authorHref(res.id);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ---------- администратор ---------- */
  function initAdminUi() {
    const dialog = $('#loginDialog');
    $('#adminLoginLink').addEventListener('click', (e) => { e.preventDefault(); $('#adminPassword').value = ''; dialog.showModal(); $('#adminPassword').focus(); });
    $('#loginCancel').addEventListener('click', () => dialog.close());
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/admin/login', { method: 'POST', body: { password: $('#adminPassword').value } });
        $('#adminPassword').value = '';
        dialog.close();
        toast('Вы вошли как администратор', 'ok');
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#adminLogoutBtn').addEventListener('click', async () => {
      try { await api('/admin/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
      if (location.hash === '#/moderation') location.hash = '#/home';
      toast('Вы вышли из режима администратора');
      await refreshAll();
    });

    $('#exportBtn').addEventListener('click', async () => {
      try {
        const data = await api('/admin/export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `zmv_backup_${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { toast(e.message, 'error'); }
    });

    $('#importBtn').addEventListener('click', () => $('#importFileInput').click());
    $('#importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 2.8 * 1024 * 1024) return toast('Файл слишком большой (максимум 2.8 МБ)', 'error');
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { return toast('Файл не является корректным JSON', 'error'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return toast('Неверная структура файла', 'error');
      if (!confirm('Импортировать данные из файла? Существующие записи не будут удалены, дубликаты пропускаются.')) return;
      try {
        const res = await api('/admin/import', { method: 'POST', body: parsed });
        toast(`Импорт завершён: авторов добавлено ${res.authorsAdded}, рецензий обработано ${res.reviewsProcessed}, пропущено ${res.skipped}`, 'ok');
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
    });

    $('#toggleAuthorFormBtn').addEventListener('click', () => { const f = $('#createAuthorForm'); f.hidden = !f.hidden; });
    $('#createAuthorForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/admin/authors', { method: 'POST', body: { name: $('#newAuthorName').value, avatar: $('#newAuthorAvatar').value.trim() } });
        $('#newAuthorName').value = ''; $('#newAuthorAvatar').value = '';
        $('#createAuthorForm').hidden = true;
        toast('Автор добавлен', 'ok');
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ---------- оценщик ---------- */
  const critEls = () => ['c1', 'c2', 'c3', 'c4', 'cAtm'].map((id) => $('#' + id));
  const criteria = () => critEls().map((el) => parseInt(el.value, 10));
  const textLen = () => [...$('#reviewText').value].length;

  function updateScore() {
    const c = criteria();
    ['val1', 'val2', 'val3', 'val4', 'valAtm'].forEach((id, i) => { $('#' + id).textContent = String(c[i]); });
    const score = calcScore(c);
    $('#finalScore').textContent = String(score);
    $('#finalScore').classList.toggle('rzt-score-max', score === 90);
  }

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ articleTitle: $('#articleTitle').value, reviewTitle: $('#reviewTitle').value, text: $('#reviewText').value, criteria: criteria() })); } catch { /* недоступно */ }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || typeof d !== 'object') return;
      if (typeof d.articleTitle === 'string') $('#articleTitle').value = d.articleTitle.slice(0, 150);
      if (typeof d.reviewTitle === 'string') $('#reviewTitle').value = d.reviewTitle.slice(0, 120);
      if (typeof d.text === 'string') $('#reviewText').value = d.text.slice(0, 10000);
      if (Array.isArray(d.criteria) && d.criteria.length === 5) critEls().forEach((el, i) => { const n = Number(d.criteria[i]); if (Number.isInteger(n) && n >= 1 && n <= 10) el.value = String(n); });
    } catch { /* повреждённый черновик */ }
  }

  function resetForm() {
    critEls().forEach((el) => { el.value = '5'; });
    ['articleTitle', 'reviewTitle', 'reviewText'].forEach((id) => { $('#' + id).value = ''; });
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    $('#textCounter').textContent = '0';
    updateScore();
  }

  function initEvaluator() {
    $('#reviewerKind').addEventListener('change', updateEvaluatorUi);
    $('#aiProfile').replaceChildren(...AI_NAMES.map((n) => h('option', { value: n }, n)));
    critEls().forEach((el) => el.addEventListener('input', () => { updateScore(); saveDraft(); }));
    ['articleTitle', 'reviewTitle'].forEach((id) => $('#' + id).addEventListener('input', saveDraft));
    $('#reviewText').addEventListener('input', () => { $('#textCounter').textContent = String(textLen()); saveDraft(); });
    $('#resetBtn').addEventListener('click', resetForm);

    $('#reviewForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const aiMode = state.admin && $('#reviewerKind').value === 'ai';
      if (!aiMode && !state.me) { toast('Чтобы отправить рецензию, войдите в аккаунт', 'error'); return openAuth('login'); }
      if (!e.currentTarget.reportValidity()) return;
      if (!state.authors.length) return toast('Список авторов не загружен', 'error');
      const btn = $('#submitBtn');
      btn.disabled = true;
      try {
        const res = await api('/reviews', { method: 'POST', body: {
          articleTitle: $('#articleTitle').value, reviewTitle: $('#reviewTitle').value, authorId: $('#authorSelect').value,
          text: $('#reviewText').value, criteria: criteria(),
          reviewerKind: aiMode ? 'ai' : 'user', reviewerName: aiMode ? $('#aiProfile').value : undefined,
        } });
        toast(res.status === 'approved' ? 'Рецензия опубликована!' : 'Спасибо! Рецензия отправлена на модерацию.', 'ok');
        resetForm();
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
      finally { btn.disabled = false; }
    });

    $('#wikiForm').addEventListener('submit', (e) => { e.preventDefault(); loadWiki($('#wikiUrl').value); });
  }

  function parseWikiUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname === WIKI_HOST && !u.username && !u.password ? u.toString() : null;
    } catch { return null; }
  }

  function loadWiki(value) {
    const url = parseWikiUrl(value);
    if (!url) return toast(`Разрешены только https-ссылки на ${WIKI_HOST}`, 'error');
    $('#viewport').src = url;
    $('#wikiOpenLink').href = url;
    state.wikiLoaded = true;
  }
  function ensureWiki() { if (!state.wikiLoaded) loadWiki(WIKI_DEFAULT); }

  /* ---------- калькулятор ЗМВ ---------- */
  function recalcZmvi() {
    const num = (id) => parseFloat($('#' + id).value);
    const R = num('v_r_concept') + num('v_r_impl');
    const C = num('v_c_format') + num('v_c_concept') + num('v_c_semantic');
    const D = num('v_depth');
    const S = parseInt($('#v_score_90').value, 10);
    const Q = S / 90;
    const mSum = Math.min(9, Math.max(1, Math.round(num('v_m_author') + num('v_m_expect'))));
    const M = ZM[mSum];
    const V = (R + C + D) * Q * M;

    $('#badgeR').textContent = `${R.toFixed(1)} б.`;
    $('#badgeC').textContent = `${C.toFixed(1)} б.`;
    $('#badgeD').textContent = `${D.toFixed(1)} б.`;
    $('#v_score_90_lbl').textContent = `${S}/90`;
    $('#badgeQ').textContent = `${Q.toFixed(2)} (${Math.round(Q * 100)}%)`;
    $('#badgeM').textContent = `${M.toFixed(2)} (балл ${mSum})`;
    $('#calcValRes').textContent = V.toFixed(2);
    $('#calcFormulaBreakdown').textContent = `(R: ${R.toFixed(2)} + C: ${C.toFixed(2)} + D: ${D.toFixed(2)}) × Q: ${Q.toFixed(2)} × M: ${M.toFixed(2)}`;
    const cats = [[6, 'cat-silver', '🥈 Серебряная статья'], [12, 'cat-gold', '🥇 Золотая статья'], [18, 'cat-emerald', '❇️ Изумрудная статья'], [24, 'cat-sapphire', '🔷 Сапфировая статья']];
    const [, cls, label] = cats.find(([limit]) => V < limit) || [0, 'cat-ruby', '🔻 Рубиновая статья'];
    const badge = $('#calcCatBadge');
    badge.className = `val-category-badge ${cls}`;
    badge.textContent = label;
  }

  /* ---------- запуск ---------- */
  function applyLimits() {
    const lim = limits();
    $('#reviewText').maxLength = lim.body;
    $('#textMax').textContent = String(lim.body);
    $('#profileBio').maxLength = lim.bio;
  }

  async function init() {
    $('#atmTable').replaceChildren(...Object.entries(ATM).map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v.toFixed(4)))));
    $$('.zmvi-in').forEach((el) => el.addEventListener('input', recalcZmvi));
    $('#feedSortSelect').addEventListener('change', () => { state.feedLimit = PAGE; renderHome(); });
    $('#feedMoreBtn').addEventListener('click', () => { state.feedLimit += PAGE; renderHome(); });
    $('#articleReviewsSortSelect').addEventListener('change', route);
    $('#aiViewerSelect').addEventListener('change', renderCritics);
    [['articlesSearch', renderArticlesList], ['articlesSort', renderArticlesList], ['authorsSearch', renderAuthorsList], ['authorsSort', renderAuthorsList], ['usersSearch', renderUsersList], ['usersSort', renderUsersList]]
      .forEach(([id, fn]) => $('#' + id).addEventListener('input', fn));
    $('#globalSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#globalSearch').value.trim();
      location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/search';
    });

    initAdminUi(); initAuth(); initProfile(); initEvaluator();
    loadDraft();
    $('#textCounter').textContent = String(textLen());
    updateScore();
    recalcZmvi();
    window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

    buildIndex(); // пустой индекс, чтобы страницы рисовались до загрузки данных
    route();
    try { state.config = await api('/config'); } catch { state.config = {}; }
    applyLimits();
    await refreshAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
