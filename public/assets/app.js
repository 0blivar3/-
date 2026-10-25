'use strict';
(() => {
  /* ---------- константы ---------- */
  const ATM = { 1: 1.0, 2: 1.0675, 3: 1.1349, 4: 1.2024, 5: 1.2699, 6: 1.3373, 7: 1.4048, 8: 1.4723, 9: 1.5397, 10: 1.6072 };
  const ZM = { 1: 1.12, 2: 1.34, 3: 1.5, 4: 1.62, 5: 1.72, 6: 1.81, 7: 1.88, 8: 1.94, 9: 2.0 };
  const AI_NAMES = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok'];
  const USERS_KEY = '__users';
  const WIKI_HOST = 'minecraft-backrooms.fandom.com';
  const WIKI_DEFAULT = 'https://minecraft-backrooms.fandom.com/ru/wiki/';
  const DRAFT_KEY = 'wb_draft_v2';
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
    authors: [], reviews: [], pending: [],
    admin: false, loaded: false, config: {},
    feedLimit: PAGE, authorTab: 'articles', turnstileToken: '', turnstileId: null,
    wikiLoaded: false,
  };

  /* ---------- утилиты ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Безопасное создание DOM: весь пользовательский текст вставляется только как textContent.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
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
    setTimeout(() => el.remove(), 5000);
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

  const articleHref = (title) => '#/article/' + encodeURIComponent(title);
  const authorById = (id) => state.authors.find((a) => a.id === id);
  const avg = (list) => (list.length ? list.reduce((s, r) => s + r.score, 0) / list.length : 0);
  const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const calcScore = (c) => Math.min(90, Math.round((c[0] + c[1] + c[2] + c[3]) * 1.4 * ATM[c[4]]));
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  function uniqueArticles() {
    const map = new Map();
    for (const r of state.reviews) {
      const key = r.articleTitle.toLowerCase();
      if (!map.has(key)) map.set(key, { title: r.articleTitle, reviews: [] });
      map.get(key).reviews.push(r);
    }
    return [...map.values()];
  }

  /* ---------- карточки ---------- */
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
    return h('span', { class: 'ai-reviewer-tag user-reviewer-tag' }, '👤 ' + r.reviewerName);
  }

  function reviewCard(r, { moderation = false } = {}) {
    const author = authorById(r.authorId) || { name: 'Неизвестный автор' };
    const actions = [];
    if (state.admin) {
      if (moderation) actions.push(h('button', { type: 'button', class: 'btn btn-ok', onclick: () => moderate(r.id, 'approve') }, '✓ Одобрить'));
      actions.push(h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: () => moderate(r.id, 'delete') }, '🗑 Удалить'));
    }
    return h('article', { class: 'review-card' },
      h('div', { class: 'review-top-bar' },
        h('div', null,
          h('h3', { class: 'review-main-title' }, r.reviewTitle),
          h('a', { class: 'review-article-title', href: articleHref(r.articleTitle) },
            'Статья: ', h('strong', null, r.articleTitle), ' | Автор: ' + author.name)),
        h('div', { class: 'score-breakdown-box' },
          h('div', { class: 'score-total-display' }, String(r.score), h('span', { class: 'muted small' }, ' / 90')),
          h('div', { class: 'score-criteria-display', title: 'Критерии' }, r.criteria.join(' ')))),
      reviewerTag(r),
      h('div', { class: 'review-text' }, r.text),
      h('div', { class: 'review-date' }, fmtDate(r.createdAt)),
      actions.length ? h('div', { class: 'review-actions' }, actions) : null);
  }

  const emptyBox = (text) => h('div', { class: 'empty' }, text);

  /* ---------- рендер страниц ---------- */
  function renderHome() {
    const hero = $('#heroContainer');
    hero.replaceChildren();
    const rs = state.reviews;
    if (rs.length) {
      const top = [...rs].sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)[0];
      const author = authorById(top.authorId) || { name: 'Неизвестный' };
      hero.append(h('a', { class: 'hero-featured', href: articleHref(top.articleTitle) },
        h('div', { class: 'hero-badge' }, '🏆 Топ-1 статья портала'),
        h('div', { class: 'hero-title' }, top.articleTitle),
        h('div', { class: 'hero-meta' }, 'Автор: ', h('strong', null, author.name), ' • Оценка: ',
          h('strong', { class: 'gold' }, `${top.score} / 90`)),
        h('div', { class: 'hero-quote' }, '«' + top.text + '»')));
    }

    $('#statTotalReviews').textContent = String(rs.length);
    $('#statAvgScore').textContent = `${avg(rs).toFixed(1)} / 90`;

    const tops = state.authors
      .map((a) => ({ a, n: rs.filter((r) => r.authorId === a.id).length }))
      .filter((x) => x.n > 0)
      .sort((x, y) => y.n - x.n).slice(0, 4);
    const topBox = $('#homeTopAuthorsList');
    topBox.replaceChildren(...(tops.length
      ? tops.map(({ a, n }) => h('div', { class: 'top-author-row' },
        h('a', { href: '#/authors/' + encodeURIComponent(a.id) }, a.name),
        h('span', { class: 'muted small' }, `${n} рец.`)))
      : [emptyBox('Пока пусто.')]));

    const sort = $('#feedSortSelect').value;
    const sorted = [...rs];
    if (sort === 'highest') sorted.sort((a, b) => b.score - a.score);
    else if (sort === 'lowest') sorted.sort((a, b) => a.score - b.score);
    else sorted.sort((a, b) => b.createdAt - a.createdAt);

    const feed = $('#recentFeed');
    feed.replaceChildren(...(sorted.length
      ? sorted.slice(0, state.feedLimit).map((r) => reviewCard(r))
      : [emptyBox(state.loaded ? 'Нет рецензий для отображения.' : 'Загрузка…')]));
    $('#feedMoreBtn').hidden = sorted.length <= state.feedLimit;
  }

  function renderArticle(titleParam) {
    const head = $('#articleHeaderCard');
    const list = $('#articleReviewsList');
    const articles = uniqueArticles();
    let article = null;
    if (titleParam) article = articles.find((a) => a.title.toLowerCase() === titleParam.toLowerCase());
    else if (articles.length) article = articles[0];

    if (!article) {
      head.replaceChildren(h('div', { class: 'empty' }, titleParam ? 'Статья не найдена.' : 'Пока нет статей.'));
      list.replaceChildren();
      return;
    }
    const sort = $('#articleReviewsSortSelect').value;
    const rs = [...article.reviews];
    if (sort === 'oldest') rs.sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === 'highest') rs.sort((a, b) => b.score - a.score);
    else if (sort === 'lowest') rs.sort((a, b) => a.score - b.score);
    else rs.sort((a, b) => b.createdAt - a.createdAt);

    const author = authorById(article.reviews[0].authorId) || { name: 'Неизвестный автор' };
    head.replaceChildren(h('div', { class: 'rzt-card' },
      h('div', { class: 'rzt-cover', 'aria-hidden': 'true' }, '📦'),
      h('div', { class: 'rzt-details' },
        h('div', { class: 'rzt-tags' }, h('span', { class: 'rzt-tag' }, '📄 Статья вики'), h('span', { class: 'rzt-tag rzt-tag-accent' }, 'Закулисье')),
        h('h2', { class: 'rzt-title' }, article.title),
        h('div', null, 'Автор: ', h('strong', null, author.name)),
        h('div', { class: 'rzt-scores-row' },
          h('div', { class: 'rzt-score-circle rzt-circle-blue', title: 'Средний балл' }, String(Math.round(avg(rs)))),
          h('div', { class: 'rzt-score-circle rzt-circle-outline', title: 'Максимальный балл' }, String(Math.max(...rs.map((r) => r.score)))),
          h('div', { class: 'rzt-score-circle rzt-circle-gray', title: 'Всего рецензий' }, `${rs.length} рец.`)))));
    list.replaceChildren(...rs.map((r) => reviewCard(r)));
    document.title = `${article.title} — рецензии | Закулисье Майнкрафта Вики`;
  }

  function authorBadge(count, average) {
    if (average >= 80) return '🌟 Легенда Закулисья';
    if (count >= 3) return 'Мастер Атмосферы';
    return 'Новичок Вики';
  }

  function renderAuthors(selectedId) {
    const grid = $('#authorsGridContainer');
    grid.replaceChildren(...state.authors.map((a) => {
      const revs = state.reviews.filter((r) => r.authorId === a.id);
      const average = avg(revs);
      const avatar = a.avatar
        ? h('img', { class: 'author-avatar-lg', src: a.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : h('div', { class: 'author-avatar-lg', 'aria-hidden': 'true' }, [...a.name][0].toUpperCase());
      return h('a', { class: `author-card-item ${a.id === selectedId ? 'selected' : ''}`, href: '#/authors/' + encodeURIComponent(a.id) },
        h('div', { class: 'author-header-info' }, avatar,
          h('div', null, h('div', { class: 'author-name-lg' }, a.name), h('div', { class: 'author-badge-title' }, authorBadge(revs.length, average)))),
        h('div', { class: 'author-stats-mini' },
          h('div', { class: 'author-stat-box' }, h('div', { class: 'author-stat-num' }, String(revs.length)), h('div', { class: 'author-stat-lbl' }, 'Рецензий')),
          h('div', { class: 'author-stat-box' }, h('div', { class: 'author-stat-num blue' }, average.toFixed(1)), h('div', { class: 'author-stat-lbl' }, 'Ср. балл'))));
    }));

    const detail = $('#authorProfileDetailBlock');
    const author = selectedId ? authorById(selectedId) : null;
    detail.hidden = !author;
    $('#deleteAuthorBtn').dataset.id = author ? author.id : '';
    $('#deleteAuthorBtn').hidden = !author || author.id === 'a1';
    if (!author) return;

    $('#subTabArticlesBtn').classList.toggle('active', state.authorTab === 'articles');
    $('#subTabReviewsBtn').classList.toggle('active', state.authorTab === 'reviews');
    const box = $('#authorProfileContent');
    const revs = state.reviews.filter((r) => r.authorId === author.id);
    if (state.authorTab === 'articles') {
      const groups = new Map();
      revs.forEach((r) => { if (!groups.has(r.articleTitle)) groups.set(r.articleTitle, []); groups.get(r.articleTitle).push(r); });
      box.replaceChildren(...(groups.size
        ? [...groups].map(([title, list]) => h('a', { class: 'review-card article-row', href: articleHref(title) },
          h('div', null, h('div', { class: 't' }, '📄 ' + title), h('div', { class: 'muted small' }, `Рецензий: ${list.length}`)),
          h('div', { class: 'avg' }, String(Math.round(avg(list))), h('span', { class: 'muted small' }, ' / 90'))))
        : [emptyBox('Статей пока нет.')]));
    } else {
      box.replaceChildren(...(revs.length ? revs.map((r) => reviewCard(r)) : [emptyBox('Рецензий нет.')]));
    }
  }

  function syncCriticSelect() {
    const sel = $('#aiViewerSelect');
    if (sel.options.length) return;
    sel.append(...AI_NAMES.map((n) => h('option', { value: n }, n)), h('option', { value: USERS_KEY }, '👤 Пользователи'));
  }

  function renderCritics() {
    syncCriticSelect();
    const key = $('#aiViewerSelect').value || AI_NAMES[0];
    const isUsers = key === USERS_KEY;
    const list = state.reviews.filter((r) => (isUsers ? r.reviewerKind === 'user' : r.reviewerKind === 'ai' && r.reviewerName === key));
    const icon = document.createElement('div');
    if (!isUsers && Object.hasOwn(AI_ICONS, key)) icon.innerHTML = AI_ICONS[key];
    $('#aiProfileContent').replaceChildren(
      h('div', { class: 'row-gap mb-12' },
        icon,
        h('div', null,
          h('h2', { class: 'section-title' }, isUsers ? 'Пользователи' : key),
          h('div', { class: 'muted small' }, 'Средняя оценка: ', h('strong', { class: 'purple-text' }, `${avg(list).toFixed(1)} / 90`), ` | Рецензий: ${list.length}`))),
      ...(list.length ? list.map((r) => reviewCard(r)) : [emptyBox('Рецензий пока нет.')]));
  }

  function renderModeration() {
    const box = $('#moderationList');
    box.replaceChildren(...(state.pending.length
      ? state.pending.map((r) => reviewCard(r, { moderation: true }))
      : [emptyBox('Очередь пуста.')]));
  }

  function updatePendingBadge() {
    const b = $('#pendingBadge');
    b.textContent = String(state.pending.length);
    b.hidden = !state.pending.length;
  }

  function syncAuthorSelect() {
    const sel = $('#authorSelect');
    const prev = sel.value;
    sel.replaceChildren(...state.authors.map((a) => h('option', { value: a.id }, a.name)));
    if (prev && state.authors.some((a) => a.id === prev)) sel.value = prev;
    $('#articleList').replaceChildren(...uniqueArticles().map((a) => h('option', { value: a.title })));
  }

  /* ---------- маршрутизация ---------- */
  const TITLES = {
    home: 'Закулисье Майнкрафта Вики — Экспертный портал рецензий',
    value: 'Калькулятор ценности статей ЗМВ',
    evaluator: 'Оценить статью',
    article: 'Просмотр статьи',
    authors: 'Авторы',
    critics: 'Критики',
    moderation: 'Модерация',
    system: 'Формула оценки (90 баллов)',
  };

  function route() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [nameRaw, ...rest] = raw.split('/');
    let name = Object.hasOwn(TITLES, nameRaw) ? nameRaw : 'home';
    const param = rest.length ? safeDecode(rest.join('/')) : null;
    if (name === 'moderation' && !state.admin) name = 'home';

    $$('.tab-content').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
    $$('.nav-btn').forEach((a) => {
      const on = a.dataset.route === name;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = TITLES[name] + (name === 'home' ? '' : ' | Закулисье Майнкрафта Вики');

    if (name === 'home') renderHome();
    if (name === 'value') recalcZmvi();
    if (name === 'evaluator') ensureWiki();
    if (name === 'article') renderArticle(param);
    if (name === 'authors') renderAuthors(param);
    if (name === 'critics') renderCritics();
    if (name === 'moderation') renderModeration();
  }

  function rerender() { syncAuthorSelect(); updatePendingBadge(); route(); }

  /* ---------- данные ---------- */
  async function loadData() {
    const err = $('#loadError');
    try {
      const data = await api('/data');
      state.authors = data.authors;
      state.reviews = data.reviews;
      state.loaded = true;
      err.hidden = true;
    } catch (e) {
      state.loaded = true;
      err.hidden = false;
      err.replaceChildren('Не удалось загрузить данные: ' + e.message + ' ',
        h('button', { type: 'button', class: 'btn btn-outline', onclick: () => loadData() }, 'Повторить'));
    }
    if (state.admin) {
      try { state.pending = (await api('/admin/pending')).reviews; } catch { state.pending = []; }
    } else state.pending = [];
    rerender();
  }

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

  /* ---------- админ ---------- */
  function setAdmin(on) {
    state.admin = on;
    document.body.classList.toggle('admin-mode', on);
    $('#adminReviewerBlock').hidden = !on;
    $('#userNickBlock').hidden = on && $('#reviewerKind').value === 'ai';
    $('#moderationNote').hidden = on;
    updateReviewerFields();
  }

  function updateReviewerFields() {
    const aiMode = state.admin && $('#reviewerKind').value === 'ai';
    $('#aiProfile').hidden = !aiMode;
    $('#userNickBlock').hidden = aiMode;
    $('#reviewerName').required = !aiMode;
    $('#turnstileBox').hidden = state.admin;
  }

  async function checkAdmin() {
    try { setAdmin((await api('/admin/me')).admin); } catch { setAdmin(false); }
  }

  function initAdminUi() {
    const dialog = $('#loginDialog');
    $('#loginBtn').addEventListener('click', () => { $('#adminPassword').value = ''; dialog.showModal(); $('#adminPassword').focus(); });
    $('#loginCancel').addEventListener('click', () => dialog.close());
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/admin/login', { method: 'POST', body: { password: $('#adminPassword').value } });
        $('#adminPassword').value = '';
        dialog.close();
        setAdmin(true);
        toast('Вы вошли как администратор', 'ok');
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/admin/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
      setAdmin(false);
      state.pending = [];
      if (location.hash === '#/moderation') location.hash = '#/home';
      rerender();
      toast('Вы вышли из режима администратора');
    });

    $('#exportBtn').addEventListener('click', async () => {
      try {
        const data = await api('/admin/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
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
      if (file.size > 1.5 * 1024 * 1024) return toast('Файл слишком большой (максимум 1.5 МБ)', 'error');
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
    $('#deleteAuthorBtn').addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (!id || !confirm('Удалить автора? Его статьи перейдут к «Неизвестному автору».')) return;
      try { await api(`/admin/authors/${encodeURIComponent(id)}`, { method: 'DELETE' }); location.hash = '#/authors'; toast('Автор удалён', 'ok'); await loadData(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ---------- оценщик ---------- */
  const critEls = () => ['c1', 'c2', 'c3', 'c4', 'cAtm'].map((id) => $('#' + id));
  const criteria = () => critEls().map((el) => parseInt(el.value, 10));

  function updateScore() {
    const c = criteria();
    ['val1', 'val2', 'val3', 'val4', 'valAtm'].forEach((id, i) => { $('#' + id).textContent = String(c[i]); });
    const score = calcScore(c);
    $('#finalScore').textContent = String(score);
    $('#finalScore').classList.toggle('rzt-score-max', score === 90);
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        articleTitle: $('#articleTitle').value, reviewTitle: $('#reviewTitle').value,
        text: $('#reviewText').value, reviewerName: $('#reviewerName').value, criteria: criteria(),
      }));
    } catch { /* хранилище недоступно */ }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || typeof d !== 'object') return;
      if (typeof d.articleTitle === 'string') $('#articleTitle').value = d.articleTitle.slice(0, 150);
      if (typeof d.reviewTitle === 'string') $('#reviewTitle').value = d.reviewTitle.slice(0, 120);
      if (typeof d.text === 'string') $('#reviewText').value = d.text.slice(0, 5000);
      if (typeof d.reviewerName === 'string') $('#reviewerName').value = d.reviewerName.slice(0, 32);
      if (Array.isArray(d.criteria) && d.criteria.length === 5) {
        critEls().forEach((el, i) => { const n = Number(d.criteria[i]); if (Number.isInteger(n) && n >= 1 && n <= 10) el.value = String(n); });
      }
    } catch { /* повреждённый черновик игнорируем */ }
  }

  function resetForm(clearName = false) {
    critEls().forEach((el) => { el.value = '5'; });
    ['articleTitle', 'reviewTitle', 'reviewText', 'website'].forEach((id) => { $('#' + id).value = ''; });
    if (clearName) $('#reviewerName').value = '';
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    $('#textCounter').textContent = '0';
    updateScore();
  }

  function loadTurnstile(siteKey) {
    const s = h('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, defer: true });
    s.addEventListener('load', () => {
      state.turnstileId = window.turnstile.render('#turnstileBox', { sitekey: siteKey, callback: (t) => { state.turnstileToken = t; }, 'expired-callback': () => { state.turnstileToken = ''; } });
    });
    document.head.append(s);
  }

  function initEvaluator() {
    $('#reviewerKind').addEventListener('change', updateReviewerFields);
    $('#aiProfile').replaceChildren(...AI_NAMES.map((n) => h('option', { value: n }, n)));
    critEls().forEach((el) => el.addEventListener('input', () => { updateScore(); saveDraft(); }));
    ['articleTitle', 'reviewTitle', 'reviewerName'].forEach((id) => $('#' + id).addEventListener('input', saveDraft));
    $('#reviewText').addEventListener('input', () => { $('#textCounter').textContent = String([...$('#reviewText').value].length); saveDraft(); });
    $('#resetBtn').addEventListener('click', () => resetForm());

    $('#reviewForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (!form.reportValidity()) return;
      if (!state.authors.length) return toast('Список авторов не загружен', 'error');
      if (!state.admin && state.config.turnstileSiteKey && !state.turnstileToken) return toast('Подтвердите, что вы не робот', 'error');

      const aiMode = state.admin && $('#reviewerKind').value === 'ai';
      const body = {
        articleTitle: $('#articleTitle').value, reviewTitle: $('#reviewTitle').value,
        authorId: $('#authorSelect').value, text: $('#reviewText').value, criteria: criteria(),
        reviewerKind: aiMode ? 'ai' : 'user',
        reviewerName: aiMode ? $('#aiProfile').value : $('#reviewerName').value,
        website: $('#website').value, turnstile: state.turnstileToken,
      };
      const btn = $('#submitBtn');
      btn.disabled = true;
      try {
        const res = await api('/reviews', { method: 'POST', body });
        toast(res.status === 'approved' ? 'Рецензия опубликована!' : 'Спасибо! Рецензия отправлена на модерацию.', 'ok');
        resetForm();
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
      finally {
        btn.disabled = false;
        if (state.turnstileId !== null && window.turnstile) { window.turnstile.reset(state.turnstileId); state.turnstileToken = ''; }
      }
    });

    $('#wikiForm').addEventListener('submit', (e) => { e.preventDefault(); loadWiki($('#wikiUrl').value); });
  }

  function parseWikiUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.hostname !== WIKI_HOST || u.username || u.password) return null;
      return u.toString();
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
  async function init() {
    $('#atmTable').replaceChildren(...Object.entries(ATM).map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v.toFixed(4)))));
    $$('.zmvi-in').forEach((el) => el.addEventListener('input', recalcZmvi));
    $('#feedSortSelect').addEventListener('change', () => { state.feedLimit = PAGE; renderHome(); });
    $('#feedMoreBtn').addEventListener('click', () => { state.feedLimit += PAGE; renderHome(); });
    $('#articleReviewsSortSelect').addEventListener('change', route);
    $('#aiViewerSelect').addEventListener('change', renderCritics);
    $('#subTabArticlesBtn').addEventListener('click', () => { state.authorTab = 'articles'; route(); });
    $('#subTabReviewsBtn').addEventListener('click', () => { state.authorTab = 'reviews'; route(); });

    initAdminUi();
    initEvaluator();
    loadDraft();
    $('#textCounter').textContent = String([...$('#reviewText').value].length);
    updateScore();
    recalcZmvi();
    window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
    route();

    try { state.config = await api('/config'); } catch { state.config = {}; }
    if (state.config.turnstileSiteKey) loadTurnstile(state.config.turnstileSiteKey);
    await checkAdmin();
    await loadData();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
