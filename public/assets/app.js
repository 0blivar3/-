'use strict';
(() => {
  /* ---------- константы ---------- */
  const ATM = { 1: 1.0, 2: 1.0675, 3: 1.1349, 4: 1.2024, 5: 1.2699, 6: 1.3373, 7: 1.4048, 8: 1.4723, 9: 1.5397, 10: 1.6072 };
  const ZM = { 1: 1.12, 2: 1.34, 3: 1.5, 4: 1.62, 5: 1.72, 6: 1.81, 7: 1.88, 8: 1.94, 9: 2.0 };
  const AI_NAMES = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok'];
  const USERS_KEY = '__users';
  const WIKI_HOST = 'minecraft-backrooms.fandom.com';
  const WIKI_DEFAULT = 'https://minecraft-backrooms.fandom.com/ru/wiki/';
  const DRAFT_KEY = 'wb_draft_v4';
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
    authors: [], users: [], reviews: [], articleDates: [], articles: [], pending: [], myReviews: [], notifications: [], likesByReview: new Map(),
    me: null, myAuthorId: null, admin: false, loaded: false, config: {}, idx: null, prefillRating: null,
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
  const scored = (list) => list.filter((r) => r.hasScore !== false && Number.isFinite(r.score));
  const reviewed = (list) => list.filter((r) => r.hasReview !== false);
  const avg = (list) => { const scores = scored(list); return scores.length ? scores.reduce((s, r) => s + r.score, 0) / scores.length : 0; };
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

  const scoreRing = (value, cls = '') => h('div', { class: `score-ring ${tier(value)} ${cls}`, title: 'Балл из 100' },
    h('span', { class: 'sr-num' }, String(Math.round(value))), h('span', { class: 'sr-max' }, '/100'));

  const statsRow = (items, cls = '') => h('div', { class: `stats-row ${cls}` }, items.map(([val, label]) =>
    h('div', { class: 'stat-box' }, h('div', { class: 'stat-box-val' }, String(val)), h('div', { class: 'stat-box-lbl' }, label))));

  const emptyBox = (text) => h('div', { class: 'empty' }, text);

  /* ---------- индекс данных ---------- */
  const localDateISO = (timestamp) => {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtArticleDate = (value) => {
    const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : '—';
  };

  function buildIndex() {
    const idx = { authors: new Map(), users: new Map(), byAuthor: new Map(), byUser: new Map(), articles: [] };
    const dateOverrides = new Map((state.articleDates || []).map((item) => [lc(item.articleTitle), item.createdDate]));
    const push = (map, key, r) => { if (!map.has(key)) map.set(key, []); map.get(key).push(r); };
    state.authors.forEach((a) => idx.authors.set(a.id, a));
    state.users.forEach((u) => idx.users.set(lc(u.username), u));
    const arts = new Map((state.articles || []).map((a) => [lc(a.title), { ...a, reviews: [] }]));
    for (const r of state.reviews) {
      push(idx.byAuthor, r.authorId, r);
      if (r.registered && r.reviewerKind === 'user') push(idx.byUser, lc(r.reviewerName), r);
      const key = lc(r.articleTitle);
      if (!arts.has(key)) arts.set(key, { title: r.articleTitle, authorId: r.authorId, reviews: [] });
      arts.get(key).reviews.push(r);
    }
    idx.articles = [...arts.values()].map((a) => {
      const scores = scored(a.reviews);
      const first = a.reviews.length ? Math.min(...a.reviews.map((r) => r.createdAt)) : 0;
      return {
        ...a,
        avg: avg(scores),
        max: scores.length ? Math.max(...scores.map((r) => r.score)) : 0,
        latest: a.reviews.length ? Math.max(...a.reviews.map((r) => r.createdAt)) : 0,
        createdDate: a.createdDate || dateOverrides.get(lc(a.title)) || (first ? localDateISO(first) : ''),
      };
    });
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
    const all = authorReviews(a.id);
    const rs = reviewed(all);
    const average = avg(all);
    return h('a', { class: 'entity-card', href: authorHref(a.id) },
      banner(a.name),
      h('div', { class: 'ec-body' },
        avatar(a.name, a.avatar, 'avatar-lg ec-avatar'),
        h('div', { class: 'ec-name' }, a.name),
        h('div', { class: 'ec-badge' }, authorBadge(rs.length, average)),
        h('p', { class: 'ec-bio' }, a.bio || 'Описание пока не добавлено.'),
        statsRow([[uniqueTitles(all), 'Статей'], [rs.length, 'Рецензий'], [scored(all).length ? average.toFixed(1) : '—', 'Ср. балл']])));
  }

  function userCard(u) {
    const all = userReviews(u.username);
    const rs = reviewed(all);
    const own = authorOfUser(u.username);
    return h('a', { class: 'entity-card', href: userHref(u.username) },
      banner(u.username),
      h('div', { class: 'ec-body' },
        avatar(u.username, u.avatar, 'avatar-lg ec-avatar'),
        h('div', { class: 'ec-name' }, u.username, u.banned ? h('span', { class: 'chip chip-warn' }, 'заблокирован') : null),
        h('div', { class: 'ec-badge' }, own ? `✍️ Автор: ${own.name}` : userBadge(rs.length)),
        h('p', { class: 'ec-bio' }, u.bio || 'Пользователь пока ничего не рассказал о себе.'),
        statsRow([[rs.length, 'Рецензий'], [uniqueTitles(all), 'Статей'], [scored(all).length ? avg(all).toFixed(1) : '—', 'Ср. оценка']])));
  }

  function articleScoreBadge(art, ringClass = '') {
    const scoreList = scored(art.reviews);
    const ring = scoreList.length
      ? scoreRing(art.avg, ringClass)
      : h('div', { class: `score-ring score-ring-empty ${ringClass}`, title: 'Пока нет оценок' },
          h('span', { class: 'sr-num' }, '—'), h('span', { class: 'sr-max' }, '/100'));
    const voteRows = scoreList.slice(0, 8).map((r) => h('div', { class: 'score-tooltip-row' },
      h('span', null, r.reviewerName), h('strong', null, `${r.score} / 100`)));
    return h('div', {
      class: 'score-tooltip-wrap',
      tabindex: 0,
      role: 'group',
      'aria-label': scoreList.length ? `Средняя оценка ${art.avg.toFixed(1)} из 100. Нажмите или наведите, чтобы увидеть голоса.` : 'У статьи пока нет оценок',
    }, ring,
      h('div', { class: 'score-tooltip', role: 'tooltip' },
        h('strong', { class: 'score-tooltip-title' }, 'Оценки пользователей'),
        h('div', { class: 'score-tooltip-summary' }, scoreList.length
          ? `${scoreList.length} ${plural(scoreList.length, ['оценка', 'оценки', 'оценок'])} · ${art.avg.toFixed(1)} / 100`
          : 'Оценок пока нет'),
        ...voteRows));
  }

  function openRatingForArticle(art) {
    state.prefillRating = { title: art.title, authorId: art.authorId };
    if (location.hash === '#/evaluator') applyPendingRating();
    else location.hash = '#/evaluator';
  }

  function articleCard(art) {
    const author = state.idx.authors.get(art.authorId);
    const reviewCount = reviewed(art.reviews).length;
    const scoreCount = scored(art.reviews).length;
    return h('article', { class: 'article-card' },
      articleScoreBadge(art),
      h('div', { class: 'ac-main' },
        h('a', { class: 'ac-title ac-title-link', href: articleHref(art.title) }, art.title),
        h('div', { class: 'ac-meta' }, 'Автор: ', author ? author.name : 'Неизвестный'),
        h('div', { class: 'ac-chips' },
          h('span', { class: 'chip' }, cnt(reviewCount, F_REV)),
          h('span', { class: 'chip' }, cnt(scoreCount, ['оценка', 'оценки', 'оценок'])),
          h('span', { class: 'chip' }, scoreCount ? `макс. ${art.max}` : 'нет оценок'),
          h('span', { class: 'chip' }, `Создана: ${fmtArticleDate(art.createdDate)}`),
          art.latest ? h('span', { class: 'chip' }, `Активность: ${fmtDay(art.latest)}`) : null,
          art.wikiUrl ? h('a', { class: 'chip', href: art.wikiUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Статья в ЗМВ ↗') : null),
        h('div', { class: 'ac-actions' },
          h('a', { class: 'btn btn-outline article-card-action', href: articleHref(art.title) }, 'Открыть страницу'))));
  }

  function articleDateEditor(art) {
    if (!state.admin) return null;
    const form = h('form', {
      class: 'article-date-editor',
      hidden: true,
      onsubmit: async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          await api('/admin/articles/date', { method: 'POST', body: { articleTitle: art.title, createdDate: dateInput.value } });
          toast('Дата создания статьи обновлена', 'ok');
          await loadData();
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          submit.disabled = false;
        }
      },
    });
    const dateInput = h('input', { class: 'input-field', type: 'date', value: art.createdDate, required: true, 'aria-label': 'Дата создания статьи' });
    form.append(
      h('label', { class: 'field-label' }, 'Новая дата создания'),
      dateInput,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Сохранить дату'),
    );
    return h('div', { class: 'article-date-tools' },
      h('button', {
        type: 'button', class: 'btn btn-outline article-card-action',
        onclick: () => { form.hidden = !form.hidden; if (!form.hidden) dateInput.focus(); },
      }, '✏️ Изменить дату'),
      form);
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
      if (moderation) actions.push(h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: () => moderate(r.id, 'reject') }, 'Отклонить'));
      actions.push(h('button', { type: 'button', class: 'btn btn-danger btn-outline', onclick: () => moderate(r.id, 'delete') }, '🗑 Удалить'));
    }
    const hasReview = r.hasReview !== false;
    const hasScore = r.hasScore !== false;
    const ownReview = state.me && lc(r.reviewerName) === lc(state.me.username);
    if (r.status === 'approved' && r.reviewerKind === 'user' && hasReview) {
      const likesButton = h('button', {
        type: 'button',
        class: `btn btn-outline review-like${r.likedByMe ? ' is-liked' : ''}`,
        disabled: !!r.likedByMe || !!ownReview,
        title: ownReview ? 'Нельзя поставить лайк своей рецензии' : r.likedByMe ? 'Вы уже поставили лайк' : 'Нравится рецензия',
        onclick: () => likeReview(r.id),
      }, `👍 ${Number(r.likes || 0)}`);
      const listButton = h('button', { type: 'button', class: 'review-likers-toggle', 'aria-expanded': 'false', 'aria-label': 'Показать пользователей, которым нравится рецензия', onclick: async (event) => {
        const panel = event.currentTarget.nextElementSibling;
        const opening = panel.hidden;
        panel.hidden = !opening;
        event.currentTarget.setAttribute('aria-expanded', String(opening));
        if (!opening) return;
        try {
          if (!state.likesByReview.has(r.id)) state.likesByReview.set(r.id, (await api(`/reviews/${encodeURIComponent(r.id)}/likes`)).likes);
          const likes = state.likesByReview.get(r.id);
          panel.replaceChildren(...(likes.length ? likes.map((like) => h('div', { class: 'review-liker' }, h('strong', null, like.username), h('time', { datetime: new Date(like.createdAt).toISOString() }, fmtDate(like.createdAt)))) : [h('div', { class: 'muted small' }, 'Пока никто не поставил лайк.') ]));
        } catch (error) { panel.replaceChildren(h('div', { class: 'muted small' }, error.message)); }
      } }, 'Кто лайкнул?');
      actions.push(h('div', { class: 'review-likes' }, likesButton, listButton, h('div', { class: 'review-likers-popover', role: 'region', 'aria-label': 'Пользователи, поставившие лайк', hidden: true })));
    }
    const reviewText = hasReview ? r.text : 'Пользователь поставил оценку без текстовой рецензии.';
    const long = hasReview && r.text.length > 700;
    const text = h('div', { class: 'review-text' + (long ? ' clamped' : '') + (!hasReview ? ' muted' : '') }, reviewText);
    const more = long ? h('button', { type: 'button', class: 'link-btn', onclick: (e) => {
      const c = text.classList.toggle('clamped');
      e.currentTarget.textContent = c ? 'Показать полностью' : 'Свернуть';
    } }, 'Показать полностью') : null;
    return h('article', { class: 'review-card', id: `review-${r.id}` },
      h('div', { class: 'review-top-bar' },
        h('div', null,
          h('h3', { class: 'review-main-title' }, hasReview ? r.reviewTitle : 'Оценка без рецензии'),
          h('div', { class: 'review-meta' },
            h('a', { class: 'review-article-title', href: articleHref(r.articleTitle) }, 'Статья: ', h('strong', null, r.articleTitle)),
            h('a', { class: 'review-article-title', href: authorHref(r.authorId) }, 'Автор: ' + author.name))),
        hasScore ? h('div', { class: 'score-breakdown-box' },
          h('div', { class: 'score-total-display' }, String(r.score), h('span', { class: 'muted small' }, ' / 100')),
          ownReview ? h('div', { class: 'muted tiny' }, 'Ваша оценка') : null)
          : h('div', { class: 'review-no-score muted small' }, 'Без оценки')),
      h('div', { class: 'row-gap' }, reviewerTag(r),
        showStatus ? h('span', { class: `chip ${r.status === 'approved' ? 'chip-ok' : r.status === 'rejected' ? 'chip-warn' : 'chip-warn'}` }, r.status === 'approved' ? '✓ Опубликовано' : r.status === 'rejected' ? 'Отклонено' : '⏳ На модерации') : null),
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
    const reviewItems = reviewed(rs);
    const scoreItems = scored(rs);
    const featured = scoreItems.filter((r) => r.hasReview !== false);
    if (featured.length) {
      const top = [...featured].sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)[0];
      const author = state.idx.authors.get(top.authorId) || { name: 'Неизвестный' };
      hero.append(h('a', { class: 'hero-featured', href: articleHref(top.articleTitle) },
        h('div', { class: 'hero-badge' }, '🏆 Топ-1 статья портала'),
        h('div', { class: 'hero-title' }, top.articleTitle),
        h('div', { class: 'hero-meta' }, 'Автор: ', h('strong', null, author.name), ' • Оценка: ', h('strong', { class: 'gold' }, `${top.score} / 100`)),
        h('div', { class: 'hero-quote' }, '«' + top.text.slice(0, 300) + '»')));
    }
    $('#statTotalReviews').textContent = String(reviewItems.length);
    $('#statAvgScore').textContent = scoreItems.length ? `${avg(scoreItems).toFixed(1)} / 100` : '—';
    $('#statArticles').textContent = String(state.idx.articles.length);
    $('#statUsers').textContent = String(state.users.length);

    const tops = state.authors.map((a) => ({ a, n: reviewed(authorReviews(a.id)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 5);
    $('#homeTopAuthorsList').replaceChildren(...(tops.length
      ? tops.map(({ a, n }) => h('div', { class: 'top-author-row' },
        h('a', { class: 'row-gap', href: authorHref(a.id) }, avatar(a.name, a.avatar, 'avatar-xs'), a.name),
        h('span', { class: 'muted small' }, cnt(n, F_REV))))
      : [emptyBox('Пока пусто.')]));

    const sort = $('#feedSortSelect').value;
    const sorted = [...rs];
    if (sort === 'highest') sorted.sort((a, b) => (b.hasScore === false ? -1 : b.score) - (a.hasScore === false ? -1 : a.score));
    else if (sort === 'lowest') sorted.sort((a, b) => (a.hasScore === false ? Infinity : a.score) - (b.hasScore === false ? Infinity : b.score));
    else sorted.sort((a, b) => b.createdAt - a.createdAt);
    $('#recentFeed').replaceChildren(...(sorted.length
      ? sorted.slice(0, state.feedLimit).map((r) => reviewCard(r))
      : [emptyBox(state.loaded ? 'Пока нет рецензий и оценок для отображения.' : 'Загрузка…')]));
    $('#feedMoreBtn').hidden = sorted.length <= state.feedLimit;
  }

  function renderArticlesList() {
    const q = norm($('#articlesSearch').value.trim());
    const sort = $('#articlesSort').value;
    let list = state.idx.articles.filter((a) => !q || norm(a.title).includes(q));
    const by = {
      rating: (a, b) => b.avg - a.avg, reviews: (a, b) => reviewed(b.reviews).length - reviewed(a.reviews).length,
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
    else if (sort === 'highest') rs.sort((a, b) => (b.hasScore === false ? -1 : b.score) - (a.hasScore === false ? -1 : a.score));
    else if (sort === 'lowest') rs.sort((a, b) => (a.hasScore === false ? Infinity : a.score) - (b.hasScore === false ? Infinity : b.score));
    else rs.sort((a, b) => b.createdAt - a.createdAt);
    const scoreReviews = scored(rs);
    const reviewCount = reviewed(rs).length;

    const author = state.idx.authors.get(article.authorId) || { id: 'a1', name: 'Неизвестный автор' };
    head.replaceChildren(h('div', { class: 'rzt-card' },
      articleScoreBadge(article, 'ring-xl'),
      h('div', { class: 'rzt-details' },
        h('div', { class: 'rzt-tags' }, h('span', { class: 'rzt-tag' }, '📄 Статья вики'), h('span', { class: 'rzt-tag rzt-tag-accent' }, 'Закулисье')),
        h('h2', { class: 'rzt-title' }, article.title),
        h('a', { class: 'row-gap author-inline', href: authorHref(author.id) }, avatar(author.name, author.avatar, 'avatar-xs'), 'Автор: ', h('strong', null, author.name)),
        h('div', { class: 'article-created-date' }, 'Дата создания: ', h('strong', null, fmtArticleDate(article.createdDate))),
        article.wikiUrl ? h('div', { class: 'article-detail-actions' }, h('a', { class: 'btn btn-outline', href: article.wikiUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть статью в ЗМВ ↗')) : null,
        articleDateEditor(article),
        h('div', { class: 'article-detail-actions' },
          h('button', { type: 'button', class: 'btn btn-purple', onclick: () => openRatingForArticle(article) }, '⭐ Оценить эту статью')),
        statsRow([[reviewCount, 'Рецензий'], [scoreReviews.length, 'Оценок'], [scoreReviews.length ? Math.round(article.avg) : '—', 'Ср. балл'], [scoreReviews.length ? article.max : '—', 'Макс. балл'], [scoreReviews.length ? Math.min(...scoreReviews.map((r) => r.score)) : '—', 'Мин. балл']], 'inline-stats'))));
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
    const all = authorReviews(a.id);
    const rs = reviewed(all);
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
      name: a.name, avatarUrl: a.avatar, badge: authorBadge(rs.length, avg(all)), lines: lines.filter(Boolean), bio: a.bio, actions,
      stats: [[uniqueTitles(all), 'Статей'], [rs.length, 'Рецензий'], [scored(all).length ? avg(all).toFixed(1) : '—', 'Ср. балл'], [scored(all).length ? Math.max(...scored(all).map((r) => r.score)) : '—', 'Лучший балл']],
    })];
    if (state.editingAuthor === a.id && canEditAuthor(a)) body.push(h('div', { class: 'panel' }, h('h3', { class: 'panel-title' }, '✏️ Редактирование карточки'), authorEditForm(a)));

    const groups = new Map();
    all.forEach((r) => {
      const k = lc(r.articleTitle);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const content = state.authorTab === 'articles'
      ? (groups.size ? h('div', { class: 'article-grid' }, state.idx.articles.filter((x) => groups.has(lc(x.title))).sort((x, y) => y.avg - x.avg).map(articleCard)) : emptyBox('Статей пока нет.'))
      : h('div', null, all.length ? all.map((r) => reviewCard(r)) : emptyBox('Рецензий и оценок пока нет.'));
    body.push(h('div', { class: 'panel' },
      tabButtons([['articles', '📚 Статьи'], ['reviews', '💬 Рецензии и оценки']], state.authorTab, (k) => { state.authorTab = k; route(); }), content));
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

  function socialLinksNode(links) {
    const labels = {
      fandom: 'Fandom', youtube: 'YouTube', tiktok: 'TikTok', discord: 'Discord',
      telegram: 'Telegram', instagram: 'Instagram', vk: 'ВКонтакте', other: 'Ссылка',
    };
    const items = Object.entries(links || {}).filter(([key, value]) => {
      if (!labels[key] || typeof value !== 'string' || !value) return false;
      try { return new URL(value).protocol === 'https:'; } catch { return false; }
    });
    return items.length
      ? h('div', { class: 'social-links' }, items.map(([key, value]) =>
          h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-outline' }, labels[key] + ' ↗')))
      : null;
  }

  function renderUserPage(username) {
    const box = $('#userPage');
    const u = state.idx.users.get(lc(username));
    if (!u) { box.replaceChildren(h('div', { class: 'panel' }, emptyBox(state.loaded ? 'Пользователь не найден.' : 'Загрузка…'))); return; }
    const all = userReviews(u.username);
    const rs = reviewed(all);
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
      stats: [[rs.length, 'Рецензий'], [uniqueTitles(all), 'Статей'], [scored(all).length ? avg(all).toFixed(1) : '—', 'Ср. оценка'], [scored(all).length ? Math.max(...scored(all).map((r) => r.score)) : '—', 'Макс. оценка']],
    })];
    const socialNode = socialLinksNode(u.socialLinks);
    if (socialNode) body.push(h('div', { class: 'panel' }, h('h3', { class: 'panel-title' }, '🔗 Ссылки'), socialNode));
    const favoriteAuthors = (u.favoriteAuthorIds || []).map((id) => state.idx.authors.get(id)).filter(Boolean);
    if (favoriteAuthors.length) body.push(h('div', { class: 'panel' },
      h('h3', { class: 'panel-title' }, '⭐ Любимые авторы'),
      h('div', { class: 'card-grid' }, favoriteAuthors.map(authorCard))));
    const favoriteArticles = (u.favoriteArticles || []).map((title) => state.idx.articles.find((a) => lc(a.title) === lc(title))).filter(Boolean);
    if (favoriteArticles.length) body.push(h('div', { class: 'panel' },
      h('h3', { class: 'panel-title' }, '📚 Избранные статьи'),
      h('div', { class: 'article-grid' }, favoriteArticles.map(articleCard))));
    if (own) body.push(h('div', { class: 'panel' }, h('h3', { class: 'panel-title' }, '✍️ Карточка автора'), authorCard(own)));
    const arts = state.idx.articles.filter((x) => x.reviews.some((r) => r.registered && lc(r.reviewerName) === lc(u.username)));
    const content = state.userTab === 'reviews'
      ? h('div', null, all.length ? all.map((r) => reviewCard(r)) : emptyBox('Рецензий и оценок пока нет.'))
      : (arts.length ? h('div', { class: 'article-grid' }, arts.map(articleCard)) : emptyBox('Статей пока нет.'));
    body.push(h('div', { class: 'panel' }, tabButtons([['reviews', '💬 Рецензии и оценки'], ['articles', '📚 Оценённые статьи']], state.userTab, (k) => { state.userTab = k; route(); }), content));
    box.replaceChildren(...body);
    document.title = `${u.username} — профиль | Закулисье Майнкрафта Вики`;
  }

  async function likeReview(id) {
    if (!state.me) { toast('Войдите в аккаунт, чтобы поставить лайк', 'error'); return; }
    try {
      await api(`/reviews/${encodeURIComponent(id)}/like`, { method: 'POST', body: {} });
      await loadData();
    } catch (e) { toast(e.message, 'error'); }
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
    const revs = state.reviews.filter((r) => r.hasReview !== false && norm(r.reviewTitle).includes(query)).slice(0, 10);
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
    const list = state.reviews.filter((r) => r.hasReview !== false && (isUsers ? r.reviewerKind === 'user' : r.reviewerKind === 'ai' && r.reviewerName === key));
    const icon = h('div', null);
    if (!isUsers && Object.hasOwn(AI_ICONS, key)) icon.innerHTML = AI_ICONS[key]; // константа из этого файла
    $('#aiProfileContent').replaceChildren(
      h('div', { class: 'row-gap mb-12' }, icon, h('div', null,
        h('h2', { class: 'section-title' }, isUsers ? 'Пользователи' : key),
        h('div', { class: 'muted small' }, 'Средняя оценка: ', h('strong', { class: 'purple-text' }, `${avg(list).toFixed(1)} / 100`), ` | ${cnt(list.length, F_REV)}`))),
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
    const socialKeys = ['fandom', 'youtube', 'tiktok', 'discord', 'telegram', 'instagram', 'vk', 'other'];
    const socialInputIds = ['profileSocialFandom', 'profileSocialYoutube', 'profileSocialTiktok', 'profileSocialDiscord', 'profileSocialTelegram', 'profileSocialInstagram', 'profileSocialVk', 'profileSocialOther'];
    socialInputIds.forEach((id, i) => { $('#' + id).value = (me.socialLinks && me.socialLinks[socialKeys[i]]) || ''; });
    $('#profileFavoriteAuthors').replaceChildren(...state.authors.map((a) =>
      h('option', { value: a.id, selected: (me.favoriteAuthorIds || []).includes(a.id) }, a.name)));
    const titles = [...new Set(state.idx.articles.map((a) => a.title))].sort((a, b) => a.localeCompare(b, 'ru'));
    $('#profileFavoriteArticles').replaceChildren(...titles.map((title) =>
      h('option', { value: title, selected: (me.favoriteArticles || []).some((v) => lc(v) === lc(title)) }, title)));

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
    moderation: 'Модерация', profile: 'Мой профиль', search: 'Поиск', updates: 'История обновлений',
  };
  const NAV_OF = { article: 'articles', author: 'authors', user: 'users' };

  function applyPendingRating() {
    if (!state.prefillRating) return;
    const target = state.prefillRating;
    state.prefillRating = null;
    $('#articleTitle').value = target.title;
    $('#authorSelect').value = target.authorId;
    $('#submissionType').value = 'rating';
    $('#reviewTitle').value = '';
    $('#reviewText').value = '';
    $('#textCounter').textContent = '0';
    updateSubmissionMode();
    updateScore();
    saveDraft();
    $('#articleTitle').focus({ preventScroll: true });
    toast('Статья выбрана. Выставьте баллы и отправьте оценку.', 'ok');
  }

  function route() {
    if (!state.idx) return;
    const articleAuthorSelect = $('#newArticleAuthor');
    if (articleAuthorSelect) {
      const currentAuthor = articleAuthorSelect.value;
      articleAuthorSelect.replaceChildren(h('option', { value: '' }, 'Выберите автора'), ...state.authors.map((a) => h('option', { value: a.id }, a.name)));
      if (state.authors.some((a) => a.id === currentAuthor)) articleAuthorSelect.value = currentAuthor;
    }
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
    if (name === 'evaluator') { ensureWiki(); applyPendingRating(); }
    if (name === 'moderation') renderModeration();
    if (name === 'profile') renderProfile();
    if (name === 'search') renderSearch(param);
  }

  function renderAuthBox() {
    const box = $('#authBox');
    if (state.me) {
      const unread = state.notifications.filter((n) => !n.readAt).length;
      const messages = state.notifications.map((n) => {
        const message = n.type === 'review_liked'
          ? `${n.actorName} поставил лайк рецензии «${n.reviewTitle}»`
          : n.type === 'review_approved' ? `Рецензия «${n.reviewTitle}» принята`
            : `Рецензия «${n.reviewTitle}» отклонена`;
        return h('div', { class: `notification-item${n.readAt ? '' : ' unread'}` }, h('div', null, message), h('time', { datetime: new Date(n.createdAt).toISOString() }, fmtDate(n.createdAt)));
      });
      const notifications = h('details', { class: 'notification-menu', ontoggle: async (event) => {
        if (!event.currentTarget.open || !unread) return;
        try {
          await api('/me/notifications/read', { method: 'POST', body: {} });
          state.notifications = state.notifications.map((n) => ({ ...n, readAt: n.readAt || Date.now() }));
          event.currentTarget.querySelector('summary').textContent = '🔔 Уведомления';
          event.currentTarget.querySelectorAll('.notification-item').forEach((item) => item.classList.remove('unread'));
        } catch { /* оставляем уведомления непрочитанными при ошибке */ }
      } }, h('summary', null, `🔔 Уведомления${unread ? ` (${unread})` : ''}`), h('div', { class: 'notification-list', role: 'region', 'aria-label': 'Уведомления' }, ...(messages.length ? messages : [h('div', { class: 'muted small' }, 'Уведомлений пока нет.')])));
      box.replaceChildren(
        h('a', { class: 'user-chip', href: '#/profile', title: 'Мой профиль' }, avatar(state.me.username, state.me.avatar, 'avatar-xs'), h('span', null, state.me.username)),
        notifications,
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
      state.authors = data.authors; state.reviews = data.reviews; state.users = data.users || []; state.articleDates = data.articleDates || []; state.articles = data.articles || [];
      state.loaded = true;
      err.hidden = true;
    } catch (e) {
      state.loaded = true;
      err.hidden = false;
      err.replaceChildren('Не удалось загрузить данные: ' + e.message + ' ', h('button', { type: 'button', class: 'btn btn-outline', onclick: () => loadData() }, 'Повторить'));
    }
    state.pending = []; state.myReviews = [];
    if (state.admin) { try { state.pending = (await api('/admin/pending')).reviews; } catch { /* нет прав */ } }
    if (state.me) {
      try { state.myReviews = (await api('/me/reviews')).reviews; } catch { /* ignore */ }
      try { state.notifications = (await api('/me/notifications')).notifications; } catch { state.notifications = []; }
    } else state.notifications = [];
    rerender();
  }

  async function refreshAll() { await loadSession(); await loadData(); }

  async function moderate(id, action) {
    try {
      if (action === 'approve' || action === 'reject') await api(`/admin/reviews/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      else {
        if (!confirm('Удалить эту рецензию?')) return;
        await api(`/admin/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      toast(action === 'approve' ? 'Рецензия опубликована' : action === 'reject' ? 'Рецензия отклонена' : 'Рецензия удалена', 'ok');
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
        const socialKeys = ['fandom', 'youtube', 'tiktok', 'discord', 'telegram', 'instagram', 'vk', 'other'];
        const socialInputIds = ['profileSocialFandom', 'profileSocialYoutube', 'profileSocialTiktok', 'profileSocialDiscord', 'profileSocialTelegram', 'profileSocialInstagram', 'profileSocialVk', 'profileSocialOther'];
        const socialLinks = Object.fromEntries(socialKeys.map((key, i) => [key, $('#' + socialInputIds[i]).value.trim()]));
        const favoriteAuthorIds = [...$('#profileFavoriteAuthors').selectedOptions].map((option) => option.value);
        const favoriteArticles = [...$('#profileFavoriteArticles').selectedOptions].map((option) => option.value);
        if (favoriteAuthorIds.length > 20 || favoriteArticles.length > 20) throw new Error('Можно выбрать не больше 20 любимых авторов и 20 статей');
        await api('/me/profile', { method: 'POST', body: { bio: $('#profileBio').value, socialLinks, favoriteAuthorIds, favoriteArticles } });
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

    $('#toggleArticleFormBtn').addEventListener('click', () => {
      const form = $('#createArticleForm');
      form.hidden = !form.hidden;
      if (!form.hidden) $('#newArticleTitle').focus();
    });
    $('#createArticleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await api('/admin/articles', { method: 'POST', body: {
          title: $('#newArticleTitle').value,
          authorId: $('#newArticleAuthor').value,
          createdDate: $('#newArticleDate').value,
          wikiUrl: $('#newArticleUrl').value,
        } });
        form.reset();
        form.hidden = true;
        toast('Статья добавлена в каталог', 'ok');
        await loadData();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });
  }

  /* ---------- оценщик ---------- */
  const textLen = () => [...$('#reviewText').value].length;

  function updateSubmissionMode() {
    const mode = $('#submissionType').value;
    const hasReview = mode !== 'rating';
    const hasScore = mode !== 'review';
    $('#scoreFields').hidden = !hasScore;
    $('#ratingInput').required = hasScore;
    $('#reviewTitleField').hidden = !hasReview;
    $('#reviewTextField').hidden = !hasReview;
    $('#reviewTitle').required = hasReview;
    $('#reviewText').required = hasReview;
    $('#scorePreview').hidden = !hasScore;
    $('#submitBtn').title = mode === 'rating' ? 'Отправить оценку' : mode === 'review' ? 'Отправить рецензию' : 'Отправить оценку и рецензию';
    $('#submitBtn').setAttribute('aria-label', $('#submitBtn').title);
    $('#moderationNote').textContent = mode === 'rating'
      ? 'Оценки без рецензии публикуются сразу, без модерации.'
      : mode === 'review'
        ? 'Рецензии без оценки публикуются после проверки модератором.'
        : 'Рецензии и оценки публикуются после проверки модератором.';
  }

  function updateScore() {
    const score = Number($('#ratingInput').value);
    $('#finalScore').textContent = Number.isInteger(score) && score >= 0 && score <= 100 ? String(score) : '—';
    $('#finalScore').classList.toggle('rzt-score-max', score === 100);
  }

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ articleTitle: $('#articleTitle').value, reviewTitle: $('#reviewTitle').value, text: $('#reviewText').value, rating: $('#ratingInput').value, submissionType: $('#submissionType').value })); } catch { /* недоступно */ }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || localStorage.getItem('wb_draft_v3') || 'null');
      if (!d || typeof d !== 'object') return;
      if (typeof d.submissionType === 'string' && ['both', 'rating', 'review'].includes(d.submissionType)) $('#submissionType').value = d.submissionType;
      if (typeof d.articleTitle === 'string') $('#articleTitle').value = d.articleTitle.slice(0, 150);
      if (typeof d.reviewTitle === 'string') $('#reviewTitle').value = d.reviewTitle.slice(0, 120);
      if (typeof d.text === 'string') $('#reviewText').value = d.text.slice(0, 10000);
      let draftRating = Number(d.rating);
      if (!Number.isInteger(draftRating) && Array.isArray(d.criteria) && d.criteria.length === 5) draftRating = Math.round(calcScore(d.criteria.map(Number)) * 100 / 90);
      if (Number.isInteger(draftRating) && draftRating >= 0 && draftRating <= 100) $('#ratingInput').value = String(draftRating);
    } catch { /* повреждённый черновик */ }
    updateSubmissionMode();
  }

  function resetForm() {
    $('#ratingInput').value = '50';
    $('#submissionType').value = 'both';
    ['articleTitle', 'reviewTitle', 'reviewText'].forEach((id) => { $('#' + id).value = ''; });
    try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem('wb_draft_v3'); } catch { /* ignore */ }
    $('#textCounter').textContent = '0';
    updateSubmissionMode();
    updateScore();
  }

  function initEvaluator() {
    $('#reviewerKind').addEventListener('change', updateEvaluatorUi);
    $('#submissionType').addEventListener('change', () => { updateSubmissionMode(); saveDraft(); });
    $('#aiProfile').replaceChildren(...AI_NAMES.map((n) => h('option', { value: n }, n)));
    $('#ratingInput').addEventListener('input', () => { updateScore(); saveDraft(); });
    ['articleTitle', 'reviewTitle'].forEach((id) => $('#' + id).addEventListener('input', saveDraft));
    $('#reviewText').addEventListener('input', () => { $('#textCounter').textContent = String(textLen()); saveDraft(); });
    $('#resetBtn').addEventListener('click', resetForm);
    $('#reviewForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const aiMode = state.admin && $('#reviewerKind').value === 'ai';
      if (!aiMode && !state.me) { toast('Чтобы отправить оценку или рецензию, войдите в аккаунт', 'error'); return openAuth('login'); }
      if (!e.currentTarget.reportValidity()) return;
      if (!state.authors.length) return toast('Список авторов не загружен', 'error');
      const btn = $('#submitBtn');
      btn.disabled = true;
      try {
        const mode = $('#submissionType').value;
        const hasReview = mode !== 'rating';
        const hasScore = mode !== 'review';
        const res = await api('/reviews', { method: 'POST', body: {
          articleTitle: $('#articleTitle').value, reviewTitle: hasReview ? $('#reviewTitle').value : '', authorId: $('#authorSelect').value,
          text: hasReview ? $('#reviewText').value : '', rating: hasScore ? Number($('#ratingInput').value) : undefined, hasReview, hasScore,
          reviewerKind: aiMode ? 'ai' : 'user', reviewerName: aiMode ? $('#aiProfile').value : undefined,
        } });
        const action = mode === 'rating' ? 'Оценка' : mode === 'review' ? 'Рецензия' : 'Оценка и рецензия';
        toast(res.status === 'approved' ? action + ' опубликована!' : 'Спасибо! ' + action.toLowerCase() + ' отправлена на модерацию.', 'ok');
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
    const S = parseInt($('#v_score_100').value, 10);
    const Q = S / 100;
    const mSum = Math.min(9, Math.max(1, Math.round(num('v_m_author') + num('v_m_expect'))));
    const M = ZM[mSum];
    const V = (R + C + D) * Q * M;

    $('#badgeR').textContent = `${R.toFixed(1)} б.`;
    $('#badgeC').textContent = `${C.toFixed(1)} б.`;
    $('#badgeD').textContent = `${D.toFixed(1)} б.`;
    $('#v_score_100_lbl').textContent = `${S}/100`;
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
