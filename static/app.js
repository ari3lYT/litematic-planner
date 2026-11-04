"use strict";
const $ = (s) => document.querySelector(s),
  main = $("#main"),
  dialog = $("#dialog");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n || 0);
const categories = [
  "Строительные блоки",
  "Цветные блоки",
  "Природные блоки",
  "Функциональные блоки",
  "Редстоун",
];
let prefs = {
  view: "warehouse",
  pins: [],
  theme: "dark",
  compact: false,
  units: "packs",
  nickname: "",
  ...read("sklad:prefs", {}),
};
if (!prefs.chestWorkspaceV1) {
  prefs.view = "chests";
  prefs.chestWorkspaceV1 = true;
  write("sklad:prefs", prefs);
}
if (!prefs.designV5) {
  prefs.theme = "dark";
  prefs.designV5 = true;
  prefs.chestLargeSlots = true;
  prefs.materialView = prefs.view === "list" ? "list" : "warehouse";
  write("sklad:prefs", prefs);
}
let state = {
  id: null,
  key: null,
  data: null,
  session: null,
  tab: "materials",
  search: "",
  category: "Все",
  hideDone: true,
  hideBusy: false,
  group: true,
  onlyPinned: false,
  onlySurplus: false,
  sort: "remaining",
  ...read("sklad:filters", {}),
};
let busy = false,
  timer = null,
  lastData = "",
  requestVersion = 0,
  activeAction = null;
function applyPrefs() {
  updateTheme();
  document.body.classList.toggle("compact", !!prefs.compact);
}
applyPrefs();
function toast(message, changeId) {
  if (dialog.open) {
    let note = dialog.querySelector(".dialog-toast");
    if (!note) {
      note = document.createElement("div");
      note.className = "dialog-toast";
      note.setAttribute("role", "status");
      dialog.querySelector("h2").after(note);
    }
    note.textContent = message;
    clearTimeout(toast.dialogTimer);
    toast.dialogTimer = setTimeout(() => note.remove(), 5000);
    return;
  }
  $("#toast").innerHTML =
    esc(message) +
    (changeId
      ? ` <button class="toast-undo" data-undo="${Number(changeId)}">Отменить</button>`
      : "");
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => $("#toast").classList.remove("show"),
    changeId ? 15000 : 4000,
  );
}
function saveFilters() {
  write(
    "sklad:filters",
    Object.fromEntries(
      [
        "search",
        "category",
        "hideDone",
        "hideBusy",
        "group",
        "sort",
        "onlyPinned",
        "onlySurplus",
      ].map((k) => [k, state[k]]),
    ),
  );
}
function stackSize(id) {
  const n = id.split(":").pop();
  return /(?:shulker_box|_bed)$/.test(n)
    ? 1
    : /(?:banner|sign)$/.test(n)
      ? 16
      : 64;
}
function pack(n, id) {
  n = Math.max(0, n);
  if (!n) return "—";
  if (prefs.units === "items") return fmt(n) + " шт.";
  const size = stackSize(id);
  if (size === 1) return fmt(n) + " шт.";
  const sh = Math.floor(n / (size * 27)),
    st = Math.floor(n / size) % 27,
    it = n % size;
  return [
    sh ? `${fmt(sh)} шк.` : "",
    st ? `${st} ст.` : "",
    it ? `${it} шт.` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
function quantityText(n, id) {
  return (
    fmt(n) +
    " шт." +
    (prefs.units !== "items" && stackSize(id) > 1 && n >= stackSize(id)
      ? " · " + pack(n, id)
      : "")
  );
}
function icon(id) {
  return "./icon/" + encodeURIComponent(id.split(":").pop());
}
function totals() {
  return state.data.materials.reduce(
    (t, m) => ({
      required: t.required + m.required,
      delivered: t.delivered + Math.min(m.required, m.delivered),
      reserved: t.reserved + m.reserved,
    }),
    { required: 0, delivered: 0, reserved: 0 },
  );
}
function shareUrl(id = state.id, key = state.key) {
  const u = new URL("./", location.href);
  u.hash = new URLSearchParams({ p: id, k: key });
  return u.href;
}
function recent() {
  return read("sklad:recent", [])
    .filter((p) => p.id && p.key)
    .slice(0, 12);
}
function remember() {
  const p = state.data.project;
  write(
    "sklad:recent",
    [
      { id: state.id, key: state.key, title: p.title, total: p.total_blocks },
      ...recent().filter((x) => x.id !== state.id),
    ].slice(0, 12),
  );
}
function sessionKey() {
  return "build-together:" + state.id;
}
async function api(path, data) {
  const options = { headers: { "X-Collection-Key": state.key || "" } };
  if (data !== undefined) {
    options.method = "POST";
    if (data instanceof FormData) options.body = data;
    else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(data);
    }
  }
  const res = await fetch("./api/" + path, options);
  const result = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(result.error || "Сервер недоступен. Попробуйте ещё раз.");
  return result;
}
function showDialog(title, body, wide = false) {
  dialog.classList.toggle("wide", wide);
  activeAction = null;
  $("#dialog-content").innerHTML =
    `<button class="close-dialog" data-do="close" aria-label="Закрыть">${uiIcon("x")}</button><h2 id="dialog-title">${esc(title)}</h2>${body}`;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() {
  dialog.close();
  activeAction = null;
}
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) closeDialog();
});
function home() {
  rememberCollectionDraft();
  disposeEditor();
  chestDispose();
  document.body.classList.remove("in-project");
  clearInterval(timer);
  state.id = null;
  state.key = null;
  state.data = null;
  state.session = null;
  state.tab = "materials";
  lastData = "";
  document.title = "Склад · совместный сбор ресурсов";
  main.innerHTML = `${homeTools()}<section class="home-hero"><div class="home-copy"><div class="hero-badge">${uiIcon("box")} Ваше пространство для постройки</div><h1>Меньше хаоса.<br><span>Больше построено.</span></h1><p>Схема, команда и ресурсы — в одном месте. Загрузите Litematica, распределите задачи и организуйте свой 3D-склад.</p><div class="steps"><div class="step"><i>${uiIcon("file-box")}</i><span>Схема превращается в список материалов</span></div><div class="step"><i>${uiIcon("users")}</i><span>Команда распределяет задачи по ссылке</span></div><div class="step"><i>${uiIcon("box")}</i><span>Расставляйте сундуки, собирайте и стройте</span></div></div></div><section class="panel create-panel"><h2>Новый сбор</h2><p class="muted">Без регистрации. Только вы и ваша команда.</p><form id="create-form" class="form"><div class="field"><label for="collection-title">Название</label><input id="collection-title" name="title" maxlength="80" placeholder="Например, ферма железа" required autocomplete="off"></div><div class="field"><span class="field-label">Схема постройки</span><label class="drop" id="drop"><input name="file" id="schematic" type="file" accept=".litematic" required aria-label="Выбрать схему .litematic"><span class="drop-symbol" aria-hidden="true">${uiIcon("upload")}</span><b id="file-label">Выберите или перетащите .litematic</b><small>До 40 МБ · Litematica</small></label></div><p id="create-error" class="error-inline" role="alert"></p><button type="submit" class="btn dark" id="create-btn">Создать сбор ${uiIcon("arrow-right")}</button><p class="helper">Сбор виден только по секретной ссылке. Любой, кому вы её передадите, сможет участвовать и менять настройки сбора.</p></form></section></section><section class="local-section"><div class="section-head"><div><h2>На этом устройстве</h2><small>Только ваши недавно открытые сборы</small></div><div class="actions"><button class="btn small" data-do="open-link">Открыть по ссылке</button>${recent().length ? '<button class="btn link small" data-do="clear-recent">Очистить историю</button>' : ""}</div></div><div class="recent-grid">${recent()
    .map(
      (p) =>
        `<a class="panel recent" href="${esc(shareUrl(p.id, p.key))}"><span class="eyebrow">Совместный сбор</span><h3>${esc(p.title)}</h3><small>${fmt(p.total)} блоков ${uiIcon("arrow-up-right")}</small></a>`,
    )
    .join(
      "",
    )}</div>${!recent().length ? '<div class="empty compact">Здесь пока пусто. Создайте сбор или откройте ссылку от команды.</div>' : ""}</section>`;
  const file = $("#schematic"),
    drop = $("#drop");
  file.onchange = () => {
    $("#file-label").textContent =
      file.files[0]?.name || "Выберите или перетащите .litematic";
    if (file.files[0] && !$("#collection-title").value)
      $("#collection-title").value = file.files[0].name
        .replace(/\.litematic$/i, "")
        .slice(0, 80);
    collectionDraft.file = file.files[0] || null;
    collectionDraft.origin = collectionDraft.file ? transferFileId(collectionDraft.file) : "";
    collectionDraft.title = $("#collection-title").value;
  };
  $("#collection-title").addEventListener("input", rememberCollectionDraft);
  restoreCollectionDraft();
  for (const name of ["dragenter", "dragover"])
    drop.addEventListener(name, (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
  for (const name of ["dragleave", "drop"])
    drop.addEventListener(name, (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
    });
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
      file.files = e.dataTransfer.files;
      file.onchange();
    }
  });
}
async function create(e) {
  e.preventDefault();
  if (busy) return;
  const file = $("#schematic").files[0] || collectionDraft.file;
  if (!file || !file.name.toLowerCase().endsWith(".litematic"))
    return ($("#create-error").textContent = "Выберите файл .litematic");
  if (file.size > 40 * 1024 * 1024)
    return ($("#create-error").textContent =
      "Файл должен быть не больше 40 МБ");
  busy = true;
  $("#create-btn").disabled = true;
  $("#create-btn").textContent = "Разбираем схему…";
  $("#create-error").textContent = "";
  try {
    rememberCollectionDraft();
    const form = new FormData(e.target);
    form.set("file", file, file.name);
    const r = await api("projects", form);
    collectionSources.set(r.project_id, {file, title: collectionDraft.title, origin: collectionDraft.origin || transferFileId(file)});
    location.hash = new URLSearchParams({ p: r.project_id, k: r.share_key });
  } catch (err) {
    $("#create-error").textContent = err.message;
    $("#create-btn").disabled = false;
    $("#create-btn").textContent = "Создать сбор";
  } finally {
    busy = false;
  }
}
async function route() {
  disposeEditor();
  chestDispose();
  chestSelected = null;
  chestHighlight = null;
  const version = ++requestVersion;
  clearInterval(timer);
  if (dialog.open) closeDialog();
  const params = new URLSearchParams(location.hash.slice(1)),
    id = params.get("p"),
    key = params.get("k");
  if (!id && !key && location.hash === "#editor") return standaloneEditor();
  if (!id && !key) return home();
  if (
    !id ||
    !key ||
    !/^[\w-]{1,16}$/.test(id) ||
    !/^[\w-]{30,128}$/.test(key)
  ) {
    home();
    toast("Ссылка неполная. Попросите команду скопировать её целиком.");
    return;
  }
  state.id = id;
  state.key = key;
  state.data = null;
  state.session = read(sessionKey(), null);
  state.tab = "materials";
  main.innerHTML = '<div class="empty">Открываем сбор…</div>';
  lastData = "";
  try {
    const data = await api("state?project=" + encodeURIComponent(id));
    if (version !== requestVersion) return;
    state.data = data;
    lastData = JSON.stringify(data);
    remember();
    renderProject();
    timer = setInterval(poll, 6000);
  } catch (err) {
    if (version !== requestVersion) return;
    main.innerHTML = `<div class="panel empty" style="margin-top:40px"><h2>Нет доступа к сбору</h2><p>${esc(err.message)}</p><p>Проверьте, что ссылка скопирована полностью.</p><a href="./" class="btn">На главную</a><button class="btn" data-do="open-link">Вставить другую ссылку</button></div>`;
  }
}
async function poll(force = false) {
  if (!force && state.tab === "editor") return;
  if (
    !state.id ||
    (!force &&
      (dialog.open ||
        document.hidden ||
        busy ||
        (main.contains(document.activeElement) &&
          /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))))
  )
    return;
  const id = state.id;
  try {
    const data = await api("state?project=" + encodeURIComponent(id));
    if (id !== state.id) return;
    const serialized = JSON.stringify(data);
    const projectChanged =
      JSON.stringify(state.data?.project) !== JSON.stringify(data.project);
    state.data = data;
    if (force || serialized !== lastData) {
      lastData = serialized;
      remember();
      if (
        !projectChanged &&
        prefs.view === "chests" &&
        state.tab === "materials" &&
        $("#chest-workbench")
      )
        chestUpdate();
      else renderProject();
    }
    const sync = $("#sync");
    if (sync) sync.innerHTML = '<i class="sync-dot"></i> Обновлено сейчас';
  } catch (err) {
    const sync = $("#sync");
    if (sync) sync.textContent = "Нет связи · повторим автоматически";
    if (force) throw err;
  }
}
function renderProject() {
  disposeEditor();
  chestDispose();
  document.body.classList.add("in-project");
  const p = state.data.project;
  document.title = p.title + " · Склад";
  main.innerHTML = `<header class="page-head"><div><a class="back-link" data-home-mode="collection" href="./">${uiIcon("arrow-left")} Мои сборы</a><h1>${esc(p.title)}</h1><div class="project-meta"><span>${esc(p.filename)}</span><span>${fmt(state.data.materials.length)} материалов</span><span class="sync" id="sync"><i class="sync-dot"></i> Синхронизировано</span></div></div><div class="actions"><button class="btn primary" data-do="quick-collect">${uiIcon("plus")} Сдать ресурсы</button><button class="btn icon-button" data-do="share" aria-label="Пригласить команду" title="Пригласить команду">${uiIcon("link")}</button><button class="btn icon-button" data-do="project-menu" aria-label="Действия со сбором" title="Действия со сбором">${uiIcon("sliders-horizontal")}</button></div></header><div class="project-layout">${projectNav()}<div class="project-body">${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ""}${projectOverview()}<div class="workspace"><section class="panel material-panel"><div id="tab-content" role="tabpanel" aria-labelledby="tab-${currentSection()}"></div></section></div></div></div>`;
  renderTab();
}
function teamHtml() {
  return (
    state.data.people
      .map(
        (p) =>
          `<div class="member"><span class="avatar" aria-hidden="true">${esc(p.nickname.slice(0, 2).toUpperCase())}</span><div class="member-info"><div class="member-name">${esc(p.nickname)}</div><small>${fmt(p.contribution)} сдано</small></div><b>${fmt(p.contribution_percent)}%</b></div>`,
      )
      .join("") ||
    '<p class="helper">Первый участник появится, когда возьмёт задачу или сдаст ресурсы.</p>'
  );
}
function renderTab() {
  disposeEditor();
  if (state.tab !== "materials") chestDispose();
  if (state.tab === "materials") renderMaterials();
  else if (state.tab === "editor") renderEditor();
  else if (state.tab === "mine") renderMine();
  else
    $("#tab-content").innerHTML =
      `<div class="section-heading"><div><span class="eyebrow">Вместе быстрее</span><h2>Команда и активность</h2><p>Вклад каждого в общую постройку.</p></div><button class="btn small" data-do="preferences">${uiIcon("settings-2")} Моё имя</button></div><div class="team-layout"><section class="team-members">${teamHtml() || '<p class="helper">Пригласите команду по ссылке.</p>'}<button class="btn" data-do="share">${uiIcon("link")} Пригласить участника</button></section><section class="events"><h3>Последние действия</h3>${state.data.activity.map((a) => `<div class="event">${esc(a.text)}<time datetime="${new Date(a.created_at * 1000).toISOString()}">${new Date(a.created_at * 1000).toLocaleString("ru-RU")}</time></div>`).join("") || '<p class="helper">Здесь появятся действия команды.</p>'}</section></div>`;
  syncNavigation();
}
function renderMaterials() {
  if (prefs.view === "chests") return chestRender();
  chestDispose();
  const present = new Set(state.data.materials.map((m) => m.category)),
    surplus = state.data.materials.reduce(
      (n, m) => n + Math.max(0, m.delivered - m.required),
      0,
    );
  $("#tab-content").innerHTML =
    `${chestViews()}${surplus ? `<div class="surplus-banner"><span>${uiIcon("package")} <b>${fmt(surplus)} шт. излишка</b> после замен</span><button class="btn small" data-do="show-surplus">Показать</button></div>` : ""}<div class="toolbar"><div class="search-box">${uiIcon("search")}<label class="visually-hidden" for="search">Поиск материалов</label><input id="search" type="search" placeholder="Найти материал…" value="${esc(state.search)}" autocomplete="off"></div></div><div class="material-controls"><div class="status-switch" role="group" aria-label="Статус материалов"><button data-material-status="remaining" aria-pressed="${state.hideDone && !state.hideBusy}">Осталось</button><button data-material-status="free" aria-pressed="${state.hideBusy}">Свободно</button><button data-material-status="all" aria-pressed="${!state.hideDone && !state.hideBusy}">Все</button></div><details id="material-filters" class="filter-disclosure"><summary>${uiIcon("sliders-horizontal")} Фильтры ${state.onlyPinned || state.onlySurplus ? '<i class="filter-dot"></i>' : ""}</summary><div class="filters"><div class="field"><label for="sort">Сортировка материалов</label><select id="sort"><option value="remaining">Больше осталось</option><option value="quantity">Больше нужно</option><option value="name">По алфавиту</option><option value="progress">Сначала собранные</option></select></div><label class="check"><input id="group" type="checkbox" ${state.group ? "checked" : ""}>Группировать по категориям</label><label class="check"><input id="onlyPinned" type="checkbox" ${state.onlyPinned ? "checked" : ""}>Только избранное</label>${surplus ? `<label class="check"><input id="onlySurplus" type="checkbox" ${state.onlySurplus ? "checked" : ""}>Только излишки</label>` : ""}</div></details></div><div class="chips" role="group" aria-label="Категории материалов">${["Все", ...categories.filter((c) => present.has(c))].map((c) => `<button class="chip" data-category="${esc(c)}" aria-pressed="${c === state.category}">${c === "Все" ? "Все категории" : esc(shortCategory(c))}</button>`).join("")}</div><div id="material-list"></div>`;
  $("#sort").value = state.sort;
  renderList();
}
function sortedMaterials() {
  const q = state.search.trim().toLowerCase();
  return state.data.materials
    .filter(
      (m) =>
        (state.category === "Все" || m.category === state.category) &&
        (!q ||
          m.label.toLowerCase().includes(q) ||
          m.block_id.toLowerCase().includes(q)) &&
        (!state.hideDone || m.delivered < m.required) &&
        (!state.hideBusy || m.required - m.delivered - m.reserved > 0) &&
        (!state.onlyPinned || pinned(m)) &&
        (!state.onlySurplus || m.delivered > m.required),
    )
    .sort(
      (a, b) =>
        Number(pinned(b)) - Number(pinned(a)) ||
        (state.sort === "name"
          ? a.label.localeCompare(b.label, "ru")
          : state.sort === "quantity"
            ? b.required - a.required
            : state.sort === "progress"
              ? (b.required ? b.delivered / b.required : 1) -
                (a.required ? a.delivered / a.required : 1)
              : b.required - b.delivered - (a.required - a.delivered)),
    );
}
function renderList() {
  const list = sortedMaterials(),
    warehouse = prefs.view !== "list";
  const complete = state.data.materials.filter(
    (m) => m.required > 0 && m.delivered >= m.required,
  ).length;
  let html = `<div class="warehouse-meta"><span>${warehouse ? "Материалов" : "Показано"} <b>${fmt(list.length)}</b> из ${fmt(state.data.materials.length)}</span><span>${uiIcon("circle-check")} ${complete} собрано</span></div>`;
  if (!list.length) {
    $("#material-list").innerHTML =
      html +
      '<div class="empty"><h2>Здесь пока пусто</h2><p>Попробуйте другую категорию или покажите все материалы.</p><button class="btn" data-do="reset-filters">Сбросить фильтры</button></div>';
    return;
  }
  const row = warehouse ? stockCard : materialRow;
  if (!warehouse)
    html +=
      '<div class="material-head"><span>Материал</span><span>Нужно</span><span>Осталось</span><span style="text-align:right">Действия</span></div>';
  const grid = (items) =>
    `<div class="${warehouse ? "stock-grid" : "stock-list"}">${items.map(row).join("")}</div>`;
  html += state.group
    ? categories
        .filter((c) => list.some((m) => m.category === c))
        .map(
          (c, i) =>
            `<section class="stock-shelf"><header class="shelf-title"><span class="shelf-number">${String(i + 1).padStart(2, "0")}</span><h3>${esc(c)}</h3><span>${list.filter((m) => m.category === c).length}</span></header>${grid(list.filter((m) => m.category === c))}</section>`,
        )
        .join("")
    : grid(list);
  $("#material-list").innerHTML = html;
}
function assignmentLabel(m) {
  const rows = state.data.reservations.filter(
    (r) => r.material_id === m.id && r.status === "active",
  );
  const names = [...new Set(rows.map((r) => r.nickname))];
  return (
    (names.length === 1 ? names[0] : "Команда") +
    " · " +
    fmt(m.reserved) +
    " в работе ↗"
  );
}
function materialRow(m) {
  const available = Math.max(0, m.required - m.delivered - m.reserved),
    done = m.delivered >= m.required;
  return `<article class="material-row ${done ? "done" : ""}"><div class="ident"><div class="item"><img src="${icon(m.block_id)}" alt="" loading="lazy" width="32" height="32"></div><div><div class="material-name">${esc(m.label)}</div>${m.reserved ? `<button class="assignment-link" data-action="assignments" data-id="${m.id}" aria-label="Задачи команды: ${esc(m.label)}">${esc(assignmentLabel(m))}</button>` : `<small>${done ? "✓ Собрано" : "Никто ещё не взял"}</small>`}<div class="mini-bar" aria-hidden="true"><i style="width:${Math.min(100, (m.delivered / m.required) * 100)}%"></i></div></div></div><div class="material-number"><span class="mobile-label">Нужно</span><b>${fmt(m.required)}</b><small>${pack(m.required, m.block_id)}</small></div><div class="material-number"><span class="mobile-label">Осталось</span><b>${fmt(Math.max(0, m.required - m.delivered))}</b><small>${pack(m.required - m.delivered, m.block_id)}</small></div>${done ? '<div class="done-label">✓ Готово</div>' : `<div class="row-actions"><button class="btn small" data-action="reserve" data-id="${m.id}" ${!available ? "disabled" : ""} aria-label="Взять: ${esc(m.label)}">Взять</button><button class="btn small primary" data-action="collect" data-id="${m.id}" ${!available ? "disabled" : ""} aria-label="Сдать: ${esc(m.label)}">Сдать</button></div>`}</article>`;
}
function renderMine() {
  const list = state.session
    ? state.data.reservations.filter(
        (r) =>
          r.participant_id === state.session.participant_id &&
          r.status === "active",
      )
    : [];
  $("#tab-content").innerHTML =
    `<div class="section-heading"><div><span class="eyebrow">Личный план</span><h2>Мои задачи</h2><p>Сдавайте по частям, когда ресурсы готовы.</p></div><button class="btn small" data-section="materials">${uiIcon("plus")} Взять ещё</button></div>${list.map((r) => `<article class="task"><div class="ident"><div class="item"><img src="${icon(r.block_id)}" alt="" width="32" height="32"></div><div><div class="material-name">${esc(r.label)}</div><small>Осталось ${fmt(r.quantity - r.delivered)} · ${pack(r.quantity - r.delivered, r.block_id)}</small><small>${fmt(r.delivered)} из ${fmt(r.quantity)} сдано</small></div></div><div class="row-actions"><button class="btn small" data-action="cancel" data-id="${esc(r.id)}">Освободить</button><button class="btn small primary" data-action="deliver" data-id="${esc(r.id)}">Сдать</button></div></article>`).join("") || '<div class="empty"><h2>У вас пока нет задач</h2><p>Нажмите «Взять» рядом с материалом — команда увидит, что вы его собираете.</p><button class="btn" data-tab="materials">Выбрать материалы</button></div>'}`;
}
async function ensureSession() {
  if (state.session) return;
  const r = await api("join", {
    project_id: state.id,
    nickname: prefs.nickname || "",
  });
  state.session = r;
  write(sessionKey(), r);
}
function auth() {
  return {
    project_id: state.id,
    participant_id: state.session.participant_id,
    token: state.session.token,
  };
}
function assignments(id) {
  const m = state.data.materials.find((x) => x.id === Number(id));
  const rows = state.data.reservations.filter(
    (r) => r.material_id === Number(id) && r.status === "active",
  );
  if (!m) return;
  showDialog(
    "Задачи команды",
    `<p>${esc(m.label)}</p><div class="notice" style="margin-top:18px">По секретной ссылке можно помочь закрыть задачу другого участника. Сдача будет учтена в его вкладе.</div>${rows.map((r) => `<article class="task" style="padding:18px 0"><div><b>${esc(r.nickname)}</b><small style="display:block">Осталось ${quantityText(r.quantity - r.delivered, r.block_id)}</small></div><div class="row-actions"><button class="btn small" data-action="cancel" data-id="${esc(r.id)}">Освободить</button><button class="btn small primary" data-action="deliver" data-id="${esc(r.id)}">Сдать</button></div></article>`).join("")}<div class="dialog-actions"><button class="btn" data-do="close">Закрыть</button></div>`,
  );
}
function action(kind, id) {
  if (kind === "replace") return replacements(Number(id));
  if (kind === "assignments") return assignments(id);
  const item =
    kind === "deliver" || kind === "cancel"
      ? state.data.reservations.find((x) => x.id === id)
      : state.data.materials.find((x) => x.id === Number(id));
  if (!item) return;
  const max =
    kind === "deliver" || kind === "cancel"
      ? item.quantity - item.delivered
      : item.required - item.delivered - item.reserved;
  if (max <= 0) return;
  const label =
    kind === "reserve"
      ? "Взять в работу"
      : kind === "cancel"
        ? "Освободить остаток"
        : "Сдать ресурсы";
  if (kind === "cancel") {
    showDialog(
      label,
      `<p>${esc(item.label)}${item.participant_id !== state.session?.participant_id ? " · резерв " + esc(item.nickname) : ""} · ${fmt(max)} останется доступно команде. Уже сданные ресурсы сохранятся.</p><form class="form" id="cancel-form"><div class="dialog-actions"><button class="btn" type="button" data-do="close">Назад</button><button class="btn primary" type="submit">Освободить</button></div></form>`,
    );
    activeAction = { kind, id, item, max };
    return;
  }
  showDialog(
    label,
    `<p>${esc(item.label)}${kind === "deliver" && item.participant_id !== state.session?.participant_id ? " · за " + esc(item.nickname) : ""}</p><form id="quantity-form" class="form"><div class="notice">${kind === "reserve" ? "Резерв покажет команде, что вы собираете этот материал. Прогресс увеличится после сдачи." : "Отмечайте только ресурсы, которые уже передали в общий склад."}<br>Доступно: <b>${quantityText(max, item.block_id)}</b></div><div class="qty-fields"><div class="field"><label for="quantity">Количество</label><input id="quantity" type="text" value="${Math.min(max, stackSize(item.block_id))}" placeholder="2ш 5ст 12" inputmode="text" autocomplete="off" required></div><div class="field"><label for="unit">Единица</label><select id="unit"><option value="1">Штуки</option><option value="${stackSize(item.block_id)}">Стаки</option><option value="${stackSize(item.block_id) * 27}">Шалкеры</option></select></div></div><div class="presets"><button class="btn small" type="button" data-add="${stackSize(item.block_id)}">+1 стак</button><button class="btn small" type="button" data-add="${stackSize(item.block_id) * 27}">+1 шалкер</button><button class="btn small" type="button" data-preset="${max}">Всё доступное</button></div><div class="helper">Можно вводить: 2ш 5ст 12. Шалкер = 27 стаков этого материала.</div><div id="quantity-hint" class="helper"></div><p id="action-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button class="btn" type="button" data-do="close">Отмена</button><button class="btn primary" type="submit">${kind === "reserve" ? "Взять в работу" : "Подтвердить сдачу"}</button></div></form>`,
  );
  activeAction = { kind, id, item, max };
  quantityHint();
  $("#quantity").select();
}
function quantityHint() {
  if (!activeAction || !$("#quantity")) return;
  try {
    const n = parseAmount(
      $("#quantity").value,
      activeAction.item.block_id,
      Number($("#unit").value),
    );
    $("#quantity-hint").textContent =
      `Итого: ${quantityText(n, activeAction.item.block_id)}`;
    $("#quantity").setCustomValidity(
      n > 0 && n <= activeAction.max
        ? ""
        : `Введите количество от 1 до ${fmt(activeAction.max)} шт.`,
    );
  } catch (err) {
    $("#quantity-hint").textContent = err.message;
    $("#quantity").setCustomValidity(err.message);
  }
}
async function submitAction(e) {
  e.preventDefault();
  if (busy || !activeAction) return;
  const a = activeAction;
  let n = 0;
  try {
    n =
      a.kind === "cancel"
        ? 0
        : parseAmount(
            $("#quantity").value,
            a.item.block_id,
            Number($("#unit").value),
          );
  } catch (err) {
    toast(err.message);
    return;
  }
  if (a.kind !== "cancel" && (n < 1 || n > a.max)) return;
  busy = true;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await ensureSession();
    const payload = { ...auth(), quantity: n };
    if (a.kind === "reserve" || a.kind === "collect")
      payload.material_id = Number(a.id);
    else payload.reservation_id = a.id;
    const r = await api(a.kind, payload);
    closeDialog();
    await poll(true);
    toast(
      a.kind === "reserve"
        ? "Задача закреплена за вами"
        : a.kind === "cancel"
          ? "Остаток снова доступен команде"
          : "Ресурсы сданы. Спасибо за вклад!",
      r.change_id,
    );
  } catch (err) {
    if ($("#action-error")) $("#action-error").textContent = err.message;
    else toast(err.message);
    btn.disabled = false;
  } finally {
    busy = false;
  }
}
function preferences() {
  showDialog(
    "Ваши настройки",
    `<p>Эти настройки сохраняются только в этом браузере.</p><form class="form" id="preferences-form"><div class="field"><label for="nickname">Ваше имя в команде — по желанию</label><input id="nickname" name="nickname" maxlength="32" value="${esc(state.session?.nickname || prefs.nickname)}" placeholder="Можно оставить пустым" autocomplete="nickname"><small>Без имени вы будете гостем. Аккаунт не нужен.</small></div><div class="field"><label for="theme">Оформление</label><select id="theme" name="theme"><option value="auto">Как на устройстве</option><option value="light">Светлое</option><option value="dark">Тёмное</option></select></div><div class="field"><label for="units">Количество материалов</label><select id="units" name="units"><option value="packs">Штуки, стаки и шалкеры</option><option value="items">Только штуки</option></select></div><label class="check"><input id="compact" name="compact" type="checkbox" ${prefs.compact ? "checked" : ""}>Компактные строки материалов</label><div class="dialog-actions"><button class="btn" type="button" data-do="close">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`,
  );
  $("#theme").value = prefs.theme;
  $("#units").value = prefs.units;
}
async function savePreferences(e) {
  e.preventDefault();
  const nickname = $("#nickname").value.trim();
  if (nickname && nickname.length < 2) {
    $("#nickname").setCustomValidity("Введите минимум 2 символа");
    $("#nickname").reportValidity();
    return;
  }
  const next = {
    ...prefs,
    nickname,
    theme: $("#theme").value,
    units: $("#units").value,
    compact: $("#compact").checked,
  };
  const btn = e.submitter;
  btn.disabled = true;
  try {
    if (state.session && nickname !== state.session.nickname) {
      const displayName =
        nickname || "Гость " + state.session.participant_id.slice(0, 4);
      await api("profile", { ...auth(), nickname: displayName });
      state.session.nickname = displayName;
      write(sessionKey(), state.session);
    }
    prefs = next;
    write("sklad:prefs", prefs);
    applyPrefs();
    closeDialog();
    if (state.data) await poll(true);
    toast("Настройки сохранены");
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}
function settings() {
  const p = state.data.project;
  showDialog(
    "Настройки сбора",
    `<p>Настройки общие для всех, у кого есть секретная ссылка.</p><form class="form" id="settings-form"><div class="field"><label for="settings-title">Название сбора</label><input id="settings-title" name="title" maxlength="80" value="${esc(p.title)}" required></div><div class="field"><label for="notes">Заметка для команды</label><textarea id="notes" name="notes" rows="3" maxlength="500" placeholder="Где находится склад? Куда приносить ресурсы?">${esc(p.notes || "")}</textarea></div><div class="notice">Ссылка даёт доступ к просмотру и изменениям. Публичного поиска сборов нет. Передавайте её только своей команде.</div><button class="btn" type="button" data-do="export">Скачать список материалов · CSV</button><div class="dialog-actions"><button class="btn" type="button" data-do="close">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`,
  );
}
async function saveSettings(e) {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    await api("settings", {
      project_id: state.id,
      title: $("#settings-title").value,
      notes: $("#notes").value,
    });
    closeDialog();
    await poll(true);
    toast("Сбор обновлён");
  } catch (err) {
    toast(err.message);
    e.submitter.disabled = false;
  }
}
async function share() {
  try {
    await navigator.clipboard.writeText(shareUrl());
    toast("Секретная ссылка скопирована. Передайте её команде.");
  } catch {
    showDialog(
      "Ссылка для команды",
      `<p>Все, у кого есть эта ссылка, смогут просматривать и изменять сбор.</p><div class="field" style="margin-top:20px"><label for="share-link">Скопируйте ссылку целиком</label><input id="share-link" readonly value="${esc(shareUrl())}"></div><div class="dialog-actions"><button class="btn primary" data-do="close">Готово</button></div>`,
    );
    $("#share-link").select();
  }
}
function openLink() {
  showDialog(
    "Открыть сбор по ссылке",
    `<p>Вставьте полную ссылку, которую вам передала команда.</p><form class="form" id="link-form"><div class="field"><label for="collection-link">Секретная ссылка</label><input id="collection-link" type="url" placeholder="https://d2omg.ru/l/#…" required></div><p id="link-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button class="btn" type="button" data-do="close">Отмена</button><button class="btn primary">Открыть сбор</button></div></form>`,
  );
}
function exportCsv() {
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@-]/, "'" + "$&")
      .replace(/"/g, '""') +
    '"';
  const rows = [
    [
      "Материал",
      "ID",
      "Категория",
      "Нужно",
      "Сдано",
      "В работе",
      "Осталось",
      "Излишек",
    ],
    ...state.data.materials.map((m) => [
      m.label,
      m.block_id,
      m.category,
      m.required,
      m.delivered,
      m.reserved,
      Math.max(0, m.required - m.delivered),
      Math.max(0, m.delivered - m.required),
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(["\ufeff" + rows.map((r) => r.map(cell).join(";")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "materials.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Список материалов скачан");
}
function parseAmount(text, id, multiplier = 1) {
  const raw = String(text).toLowerCase().trim().replace(/,/g, ".");
  if (!raw) throw Error("Укажите количество");
  if (/^\d+$/.test(raw)) {
    const n = Number(raw) * multiplier;
    if (Number.isSafeInteger(n)) return n;
    throw Error("Слишком большое количество");
  }
  let rest = raw,
    total = 0,
    seen = new Set();
  const pattern =
    /(\d+)\s*(шалкеров|шалкера|шалкер|шк\.?|стаков|стака|стак|ст\.?|штуки|штук|шт\.?|ш|с)/y;
  while (rest.trim()) {
    rest = rest.trim();
    pattern.lastIndex = 0;
    const match = pattern.exec(rest);
    if (match) {
      const unit = match[2];
      const type = /^(шал|шк|ш$)/.test(unit)
        ? "sh"
        : /^(ст|с$)/.test(unit)
          ? "st"
          : "it";
      if (seen.has(type)) throw Error("Единицу можно указать один раз");
      seen.add(type);
      total +=
        Number(match[1]) *
        (type === "sh"
          ? stackSize(id) * 27
          : type === "st"
            ? stackSize(id)
            : 1);
      rest = rest.slice(match[0].length);
    } else if (/^\d+$/.test(rest)) {
      total += Number(rest);
      rest = "";
    } else throw Error("Например: 2ш 5ст 12 или просто 64");
  }
  if (!Number.isSafeInteger(total)) throw Error("Слишком большое количество");
  return total;
}
async function undoChange(id, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try {
    await ensureSession();
    await api("undo", { ...auth(), change_id: Number(id) });
    if (dialog.open) closeDialog();
    await poll(true);
    toast("Действие отменено. Учёт ресурсов восстановлен.");
  } catch (err) {
    toast(err.message);
    if (button) button.disabled = false;
  } finally {
    busy = false;
  }
}
function renderHistory() {
  const changes = state.data.changes || [];
  showDialog(
    "История изменений",
    `<p>Действие можно отменить, пока последующие действия команды не изменили ресурсы.</p><div class="change-list">${changes.map((c) => `<article class="change-row"><div><span class="badge">${{ replace: "Замена", collect: "Сдача", deliver: "Сдача", reserve: "Резерв", cancel: "Освобождение", chest_create: "Сундук", chest_update: "Оформление", chest_delete: "Сундук", chest_fill: "Наполнение", chest_transfer: "Перенос" }[c.kind] || "Изменение"}</span><p>${esc(c.label)}</p><small>${new Date(c.created_at * 1000).toLocaleString("ru-RU")}${c.undone ? " · отменено" : ""}</small></div>${c.can_undo ? `<button class="btn small" data-undo="${c.id}">Отменить</button>` : ""}</article>`).join("") || '<div class="empty">Здесь появятся сдачи, резервы и замены.</div>'}</div><div class="dialog-actions"><button class="btn" data-do="close">Готово</button></div>`,
    true,
  );
}
function tone(c) {
  return (
    {
      "Строительные блоки": "tone-stone",
      "Цветные блоки": "tone-color",
      "Природные блоки": "tone-nature",
      "Функциональные блоки": "tone-tools",
      Редстоун: "tone-redstone",
    }[c] || "tone-stone"
  );
}
function shortCategory(c) {
  return c.replace(" блоки", "");
}
function stockCard(m) {
  const remaining = Math.max(0, m.required - m.delivered),
    free = Math.max(0, remaining - m.reserved),
    surplus = Math.max(0, m.delivered - m.required),
    done = !remaining;
  return `<article class="stock-card ${done ? "complete" : ""} ${pinned(m) ? "pinned" : ""}" data-stock-id="${m.id}"><div class="stock-art ${tone(m.category)}"><span class="stock-status ${done ? "is-done" : m.reserved ? "is-working" : ""}">${done ? uiIcon("check") : ""}${materialStatus(m)}</span><button class="pin-btn" data-pin="${m.id}" aria-label="${pinned(m) ? "Открепить" : "Закрепить"}: ${esc(m.label)}" aria-pressed="${pinned(m)}">${pinned(m) ? "★" : "☆"}</button><img src="${icon(m.block_id)}" alt="" loading="lazy" width="84" height="84"><span class="stock-art-category">${esc(shortCategory(m.category))}</span></div><div class="stock-content"><h3>${esc(m.label)}</h3><div class="stock-amount"><b>${fmt(done ? m.delivered : remaining)}</b><span>${done ? "на складе" : "осталось"}<small>${pack(done ? m.delivered : remaining, m.block_id)}</small></span></div>${cardProgress(m)}<div class="stock-detail"><span>Сдано <b>${fmt(m.delivered)}</b></span><span>Нужно <b>${fmt(m.required)}</b></span></div>${surplus ? `<div class="surplus-note">+${fmt(surplus)} шт. излишка на складе</div>` : ""}<div class="stock-task">${m.reserved ? `<button class="assignment-link" data-action="assignments" data-id="${m.id}" aria-label="Задачи команды: ${esc(m.label)}">${esc(assignmentLabel(m))}</button>` : `<span>${done ? (m.required ? "Всё собрано" : "Не нужен новому списку") : "Свободно для сбора: " + fmt(free)}</span>`}</div><div class="stock-actions">${done ? `<span class="stock-ready">${m.required ? uiIcon("check") + " Готово" : "На складе"}</span>` : `<button class="btn small" data-action="reserve" data-id="${m.id}" ${!free ? "disabled" : ""} aria-label="Взять: ${esc(m.label)}">Взять</button><button class="btn small primary" data-action="collect" data-id="${m.id}" ${!free ? "disabled" : ""} aria-label="Сдать: ${esc(m.label)}">Сдать</button>`}<button class="btn small replace-icon" data-action="replace" data-id="${m.id}" ${!m.required ? "disabled" : ""} aria-label="Заменить: ${esc(m.label)}" title="Заменить материал">⇄</button></div></div></article>`;
}
function cardProgress(m) {
  const collected = m.required
    ? Math.min(100, (m.delivered / m.required) * 100)
    : 0;
  const working = m.required
    ? Math.min(100 - collected, (m.reserved / m.required) * 100)
    : 0;
  return `<div class="stock-progress" role="progressbar" aria-label="Собрано: ${esc(m.label)}" aria-valuenow="${Math.round(collected)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${collected}%"></i><em style="width:${working}%"></em></div>`;
}
function pinned(m) {
  return (prefs.pins || []).includes(state.id + ":" + m.block_id);
}
function materialStatus(m) {
  return m.required === 0
    ? "Излишек"
    : m.delivered >= m.required
      ? "Собрано"
      : m.reserved
        ? "В работе"
        : "Нужно собрать";
}
document.addEventListener("submit", (e) => {
  const handlers = {
    "create-form": create,
    "quantity-form": submitAction,
    "cancel-form": submitAction,
    "preferences-form": savePreferences,
    "settings-form": saveSettings,
    "link-form": (e) => {
      e.preventDefault();
      try {
        const u = new URL($("#collection-link").value),
          p = new URLSearchParams(u.hash.slice(1));
        if (!p.get("p") || !p.get("k")) throw Error();
        closeDialog();
        if (location.hash === u.hash) route();
        else location.hash = u.hash;
      } catch {
        $("#link-error").textContent =
          "Нужна полная ссылка с секретным ключом после #";
      }
    },
  };
  if (handlers[e.target.id]) handlers[e.target.id](e);
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.search = e.target.value;
    saveFilters();
    renderList();
  }
  if (e.target.id === "quantity") quantityHint();
  if (e.target.id === "nickname") e.target.setCustomValidity("");
});
document.addEventListener("change", (e) => {
  if (
    [
      "sort",
      "hideDone",
      "hideBusy",
      "group",
      "onlyPinned",
      "onlySurplus",
    ].includes(e.target.id)
  ) {
    state[e.target.id] =
      e.target.type === "checkbox" ? e.target.checked : e.target.value;
    saveFilters();
    renderList();
  }
  if (e.target.id === "unit") quantityHint();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.undo) {
    undoChange(b.dataset.undo, b);
    return;
  }
  if (b.dataset.view) {
    prefs.view = b.dataset.view;
    if (prefs.view !== "chests") prefs.materialView = prefs.view;
    write("sklad:prefs", prefs);
    renderMaterials();
    syncNavigation();
    return;
  }
  if (b.dataset.pin) {
    const m = state.data.materials.find((x) => x.id === Number(b.dataset.pin)),
      key = state.id + ":" + m.block_id;
    prefs.pins = pinned(m)
      ? prefs.pins.filter((x) => x !== key)
      : [...(prefs.pins || []), key];
    write("sklad:prefs", prefs);
    renderList();
    return;
  }
  if (b.dataset.add) {
    let old = 0;
    try {
      old = parseAmount(
        $("#quantity").value,
        activeAction.item.block_id,
        Number($("#unit").value),
      );
    } catch {}
    $("#unit").value = "1";
    $("#quantity").value = Math.min(
      activeAction.max,
      old + Number(b.dataset.add),
    );
    quantityHint();
    return;
  }
  if (b.dataset.do === "show-surplus") {
    Object.assign(state, {
      search: "",
      category: "Все",
      hideDone: false,
      hideBusy: false,
      onlySurplus: true,
      onlyPinned: false,
    });
    saveFilters();
    renderMaterials();
    return;
  }
  if (b.dataset.tab) {
    if (b.dataset.tab === "materials") navigateSection("materials");
    else {
      state.tab = b.dataset.tab;
      renderTab();
    }
    if (b.closest(".mobile-dock")) {
      const target =
        state.tab === "materials"
          ? $("#chest-workbench") || $("#material-list")
          : $("#tab-content");
      target?.scrollIntoView({ block: "start", behavior: "auto" });
    }
    return;
  }
  if (b.dataset.category) {
    state.category = b.dataset.category;
    saveFilters();
    document
      .querySelectorAll("[data-category]")
      .forEach((x) =>
        x.setAttribute(
          "aria-pressed",
          String(x.dataset.category === state.category),
        ),
      );
    renderList();
    return;
  }
  if (b.dataset.preset) {
    $("#unit").value = "1";
    $("#quantity").value = b.dataset.preset;
    quantityHint();
    return;
  }
  if (b.dataset.action) {
    action(b.dataset.action, b.dataset.id);
    return;
  }
  const handlers = {
    preferences,
    settings,
    share,
    history: renderHistory,
    replacements,
    close: closeDialog,
    "open-link": openLink,
    export: exportCsv,
    "clear-recent": () => {
      write("sklad:recent", []);
      home();
      toast("История на этом устройстве очищена. Сами сборы сохранены.");
    },
    "reset-filters": () => {
      Object.assign(state, {
        search: "",
        category: "Все",
        hideDone: false,
        hideBusy: false,
        group: true,
        onlyPinned: false,
        onlySurplus: false,
        sort: "remaining",
      });
      saveFilters();
      renderMaterials();
    },
  };
  if (handlers[b.dataset.do]) handlers[b.dataset.do]();
});
document.addEventListener("keydown", (e) => {
  const tabs = [...document.querySelectorAll("[role=tab]")];
  if (
    tabs.includes(e.target) &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    const i = tabs.indexOf(e.target),
      next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? tabs.length - 1
            : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
    tabs[next].click();
    tabs[next].focus();
  }
});
let catalogCache = null,
  replacementDraft = null;
const woodNames = {
  oak: "Дуб",
  spruce: "Ель",
  birch: "Берёза",
  jungle: "Тропическое дерево",
  acacia: "Акация",
  dark_oak: "Тёмный дуб",
  mangrove: "Мангровое дерево",
  cherry: "Вишня",
  pale_oak: "Бледный дуб",
};
const colorNames = {
  white: "Белый",
  orange: "Оранжевый",
  magenta: "Пурпурный",
  light_blue: "Голубой",
  yellow: "Жёлтый",
  lime: "Лаймовый",
  pink: "Розовый",
  gray: "Серый",
  light_gray: "Светло-серый",
  cyan: "Бирюзовый",
  purple: "Фиолетовый",
  blue: "Синий",
  brown: "Коричневый",
  green: "Зелёный",
  red: "Красный",
  black: "Чёрный",
};
async function replacements(sourceId) {
  try {
    catalogCache = catalogCache || (await api("catalog")).blocks;
    const m =
      state.data.materials.find((m) => m.id === sourceId) ||
      state.data.materials.find((m) => m.required > m.delivered) ||
      state.data.materials.find((m) => m.required > 0);
    if (!m) return toast("В сборе нет материалов для замены");
    replacementDraft = {
      rules: [
        {
          source_id: m.id,
          target_block_id: "",
          quantity: Math.max(0, m.required - m.delivered),
        },
      ],
      active: 0,
      scope: "remaining",
      tab: "manual",
      family: "wood",
      query: "",
      plan: null,
      error: "",
      skipped: [],
    };
    renderReplacementEdit();
  } catch (err) {
    toast(err.message);
  }
}
function replacementQuantity(m) {
  return replacementDraft.scope === "all"
    ? m.required
    : Math.max(0, m.required - m.delivered);
}
function replacementMaterial(id) {
  return state.data.materials.find((m) => m.id === Number(id));
}
function replacementTarget(id) {
  return catalogCache.find((m) => m.block_id === id);
}
function replacementRuleRow(rule, i) {
  const m = replacementMaterial(rule.source_id),
    target = replacementTarget(rule.target_block_id);
  return `<article class="replacement-rule ${replacementDraft.active === i ? "active" : ""}"><span class="rule-number">${i + 1}</span><div class="rule-source"><label class="visually-hidden" for="replace-source-${i}">Исходный материал ${i + 1}</label><select id="replace-source-${i}" data-rule-source="${i}">${state.data.materials
    .filter((m) => m.required > 0)
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === rule.source_id ? "selected" : ""}>${esc(m.label)} · ${fmt(m.required)}</option>`,
    )
    .join(
      "",
    )}</select><small>Сдано: ${fmt(m?.delivered || 0)} · нужно: ${fmt(m?.required || 0)}</small></div><span class="rule-arrow" aria-hidden="true">${uiIcon("arrow-right")}</span><button class="rule-target ${target ? "selected" : ""}" data-edit-target="${i}" aria-label="Выбрать новый материал для замены ${i + 1}">${target ? `<img src="${icon(target.block_id)}" alt="" width="34" height="34"><span>${esc(target.label)}</span>` : "Выбрать блок…"}</button><div class="rule-quantity"><label for="replace-quantity-${i}">Количество</label><input id="replace-quantity-${i}" data-rule-quantity="${i}" type="number" min="1" max="${m?.required || 0}" step="1" value="${rule.quantity}"></div><button class="rule-delete" data-remove-rule="${i}" aria-label="Удалить замену ${i + 1}" ${replacementDraft.rules.length === 1 ? "disabled" : ""}>×</button></article>`;
}
function renderReplacementEdit() {
  replacementDraft.plan = null;
  const d = replacementDraft,
    sets = read("sklad:replacement-presets", []);
  showDialog(
    "Мастер замен",
    `<div class="wizard-step"><b>01</b><span>Выберите материалы</span><i></i><b class="muted">02</b><span class="muted">Проверьте расчёт</span></div><p>Замените материалы сбора, затем откройте эти же правила в 3D-редакторе и скачайте .litematic.</p><div class="replace-tabs"><button data-replace-tab="manual" aria-pressed="${d.tab === "manual"}">Отдельные блоки</button><button data-replace-tab="family" aria-pressed="${d.tab === "family"}">Древесина и цвета</button><button data-replace-tab="presets" aria-pressed="${d.tab === "presets"}">Мои наборы <span>${sets.length}</span></button></div><div class="replace-scope"><label for="replace-scope">Что заменить</label><select id="replace-scope"><option value="remaining">Только ещё не сданное</option><option value="all">Весь запланированный материал</option></select></div>${d.tab === "family" ? familyControls() : d.tab === "presets" ? `<div class="saved-presets">${sets.map((p, i) => `<button class="preset-card" data-load-preset="${i}"><b>${esc(p.name)}</b><small>${p.rules.length} правил · применить к этому сбору ↗</small></button>`).join("") || '<div class="empty compact">Соберите набор замен и сохраните его — он появится здесь на этом устройстве.</div>'}</div>` : ""}<div class="replacement-rules">${d.rules.map(replacementRuleRow).join("")}</div><button class="btn small" data-replace-add>+ Добавить замену</button>${d.tab === "manual" ? `<section class="block-picker"><div class="section-head"><h3>Новый блок для замены ${d.active + 1}</h3><span class="helper">${catalogCache.length} материалов</span></div><label class="visually-hidden" for="block-search">Найти новый блок</label><input id="block-search" type="search" placeholder="Например: еловые доски, кварц, blue…" value="${esc(d.query)}" autocomplete="off"><div id="block-results"></div></section>` : ""}${d.skipped.length ? `<div class="notice">Нет подходящего аналога: ${d.skipped.map(esc).join(", ")}. Эти материалы сохранятся без замены.</div>` : ""}<p class="error-inline" id="replacement-error" role="alert">${esc(d.error)}</p><div class="preset-save"><label class="visually-hidden" for="preset-name">Название набора замен</label><input id="preset-name" placeholder="Название набора — по желанию" maxlength="60"><button class="btn small" data-save-preset>Сохранить набор</button></div><div class="dialog-actions"><button class="btn" data-do="close">Отмена</button><button class="btn primary" data-preview-replacements>Проверить изменения ${uiIcon("arrow-right")}</button></div>`,
    true,
  );
  $("#replace-scope").value = d.scope;
  if (d.tab === "manual") renderCatalogResults();
}
function familyControls() {
  const family = replacementDraft.family,
    options = family === "wood" ? woodNames : colorNames,
    values =
      replacementDraft.familyValues?.[family] ||
      (family === "wood" ? ["oak", "spruce"] : ["white", "black"]);
  return `<section class="family-builder"><div class="row"><label class="check"><input type="radio" name="replace-family" value="wood" ${family === "wood" ? "checked" : ""}>Древесина</label><label class="check"><input type="radio" name="replace-family" value="color" ${family === "color" ? "checked" : ""}>Цветные блоки</label></div><div class="family-pair"><div class="field"><label for="family-from">Было</label><select id="family-from">${Object.entries(
    options,
  )
    .map(
      ([id, label]) =>
        `<option value="${id}" ${id === values[0] ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div><span aria-hidden="true">→</span><div class="field"><label for="family-to">Станет</label><select id="family-to">${Object.entries(
    options,
  )
    .map(
      ([id, label], i) =>
        `<option value="${id}" ${id === values[1] ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div><button class="btn dark" data-build-family>Подобрать</button></div><p class="helper">Подбираются существующие аналоги с той же формой: доски к доскам, ступени к ступеням, стекло к стеклу.</p></section>`;
}
function renderCatalogResults() {
  const d = replacementDraft,
    q = d.query.trim().toLowerCase(),
    rule = d.rules[d.active],
    source = replacementMaterial(rule?.source_id);
  const words = q.split(/\s+/).filter(Boolean);
  const candidates = catalogCache
    .filter(
      (b) =>
        b.block_id !== source?.block_id &&
        words.every((w) =>
          (b.label + " " + b.block_id).toLowerCase().includes(w),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.category === source?.category) -
        Number(a.category === source?.category),
    )
    .slice(0, 24);
  $("#block-results").innerHTML =
    `<div class="block-results">${candidates.map((b) => `<button class="block-choice" data-target-block="${esc(b.block_id)}" aria-pressed="${rule?.target_block_id === b.block_id}"><img src="${icon(b.block_id)}" alt="" loading="lazy" width="42" height="42"><span>${esc(b.label)}</span></button>`).join("")}</div>${!candidates.length ? '<p class="helper" style="padding-top:12px">Блок не найден. Попробуйте русское название или Minecraft ID.</p>' : ""}`;
}
function buildFamily() {
  const from = $("#family-from").value,
    to = $("#family-to").value,
    d = replacementDraft;
  if (from === to) return toast("Выберите разные виды или цвета");
  d.familyValues = { ...(d.familyValues || {}), [d.family]: [from, to] };
  const ids = new Set(catalogCache.map((b) => b.block_id)),
    rules = [],
    skipped = [];
  for (const m of state.data.materials) {
    const raw = m.block_id.replace("minecraft:", "");
    if (!raw.startsWith(from + "_") || !m.required) continue;
    const target = "minecraft:" + to + raw.slice(from.length),
      quantity = replacementQuantity(m);
    if (!quantity) continue;
    if (ids.has(target))
      rules.push({ source_id: m.id, target_block_id: target, quantity });
    else skipped.push(m.label);
  }
  if (!rules.length)
    return toast("В этом сборе нет подходящих материалов для такой замены");
  d.rules = rules;
  d.active = 0;
  d.skipped = skipped;
  d.error = "";
  renderReplacementEdit();
}
function replacementRules() {
  return replacementDraft.rules.map((r) => ({
    source_id: Number(r.source_id),
    target_block_id: r.target_block_id,
    quantity: Number(r.quantity),
  }));
}
function saveReplacementPreset() {
  const name = $("#preset-name").value.trim();
  if (!name) return toast("Назовите набор, чтобы найти его позже");
  if (replacementDraft.rules.some((r) => !r.target_block_id))
    return toast("Выберите новый блок для каждого правила");
  const presets = read("sklad:replacement-presets", []),
    entry = {
      name,
      rules: replacementDraft.rules.map((r) => ({
        source_block_id: replacementMaterial(r.source_id).block_id,
        target_block_id: r.target_block_id,
      })),
    };
  write(
    "sklad:replacement-presets",
    [entry, ...presets.filter((x) => x.name !== name)].slice(0, 20),
  );
  toast("Набор сохранён на этом устройстве");
}
function loadReplacementPreset(index) {
  const set = read("sklad:replacement-presets", [])[index];
  if (!set) return;
  const rules = [];
  for (const rule of set.rules) {
    const m = state.data.materials.find(
      (m) => m.block_id === rule.source_block_id,
    );
    if (m && replacementQuantity(m) > 0)
      rules.push({
        source_id: m.id,
        target_block_id: rule.target_block_id,
        quantity: replacementQuantity(m),
      });
  }
  if (!rules.length)
    return toast("В этом сборе нет подходящих материалов из набора");
  replacementDraft.rules = rules;
  replacementDraft.active = 0;
  replacementDraft.tab = "manual";
  replacementDraft.error = "";
  replacementDraft.skipped = [];
  renderReplacementEdit();
}
async function previewReplacements(button) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try {
    const plan = await api("replace-preview", {
      project_id: state.id,
      rules: replacementRules(),
    });
    replacementDraft.plan = plan;
    replacementDraft.error = "";
    renderReplacementPreview();
  } catch (err) {
    replacementDraft.error = err.message;
    const el = $("#replacement-error");
    if (el) el.textContent = err.message;
    button.disabled = false;
  } finally {
    busy = false;
  }
}
function renderReplacementPreview() {
  const p = replacementDraft.plan,
    pct = p.total_required
      ? Math.round((p.counted_after / p.total_required) * 100)
      : 0;
  showDialog(
    "Проверьте замену",
    `<div class="wizard-step"><b class="muted">✓</b><span class="muted">Материалы выбраны</span><i></i><b>02</b><span>Предварительный расчёт</span></div><div class="replace-summary"><div><small>Потребность</small><b>${fmt(p.total_required)}</b><span>количество блоков сохранится</span></div><div><small>Прогресс после замены</small><b>${pct}%</b><span>${fmt(p.counted_after)} подходят новому списку</span></div><div><small>Сохранится как излишек</small><b>${fmt(p.surplus_after)}</b><span>уже сданные блоки не пропадут</span></div></div><div class="replacement-preview">${p.changes.map((c) => `<article class="preview-row"><img src="${icon(c.block_id)}" alt="" width="42" height="42"><div><b>${esc(c.label)}</b><small>На складе: ${fmt(c.delivered)}${c.released ? " · освободится из резервов: " + fmt(c.released) : ""}${c.surplus ? " · излишек: " + fmt(c.surplus) : ""}</small></div><div class="preview-amount"><span>${fmt(c.before_required)}</span><b>→ ${fmt(c.after_required)}</b></div></article>`).join("")}</div>${p.released ? `<div class="notice">Освободится ${fmt(p.released)} шт. из действующих резервов старых материалов. Уже сданное и вклад участников сохранятся.</div>` : ""}<p class="helper" style="margin-top:15px">Замены списка сбора можно перенести в редактор схемы: посмотреть в 3D и скачать .litematic. Если команда изменит ресурсы, потребуется новый расчёт.</p><p class="error-inline" id="replacement-error" role="alert"></p><div class="dialog-actions"><button class="btn" data-editor-from-replacements>Редактор и .litematic</button><button class="btn" data-edit-replacements>← Исправить</button><button class="btn" data-preview-replacements>Пересчитать</button><button class="btn primary" data-apply-replacements>Применить замены</button></div>`,
    true,
  );
}
async function applyReplacements(button) {
  if (busy || !replacementDraft?.plan) return;
  busy = true;
  button.disabled = true;
  try {
    await ensureSession();
    const r = await api("replace", {
      ...auth(),
      rules: replacementRules(),
      revision: replacementDraft.plan.revision,
    });
    closeDialog();
    await poll(true);
    showDialog("Замены применены", `<p>Список сбора обновлён. Теперь можно перенести эти же правила в схему, проверить её в 3D и скачать готовый .litematic.</p><div class="dialog-actions"><button class="btn" data-undo="${r.change_id}">Отменить замены</button><button class="btn" data-do="close">Готово</button><button class="btn primary" data-editor-from-replacements>${uiIcon("download")} Скачать изменённую схему</button></div>`);
  } catch (err) {
    $("#replacement-error").textContent = err.message;
    button.disabled = false;
  } finally {
    busy = false;
  }
}
document.addEventListener("input", (e) => {
  if (e.target.id === "block-search") {
    replacementDraft.query = e.target.value;
    renderCatalogResults();
  }
  if (e.target.dataset.ruleQuantity !== undefined) {
    replacementDraft.rules[Number(e.target.dataset.ruleQuantity)].quantity =
      Number(e.target.value);
    replacementDraft.plan = null;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.ruleSource !== undefined) {
    const i = Number(e.target.dataset.ruleSource),
      m = replacementMaterial(e.target.value);
    replacementDraft.rules[i] = {
      source_id: m.id,
      target_block_id: "",
      quantity: replacementQuantity(m),
    };
    replacementDraft.active = i;
    replacementDraft.tab = "manual";
    renderReplacementEdit();
  }
  if (e.target.id === "replace-scope") {
    replacementDraft.scope = e.target.value;
    replacementDraft.rules.forEach(
      (r) =>
        (r.quantity = replacementQuantity(replacementMaterial(r.source_id))),
    );
    renderReplacementEdit();
  }
  if (e.target.name === "replace-family") {
    replacementDraft.family = e.target.value;
    renderReplacementEdit();
  }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.targetBlock) {
    replacementDraft.rules[replacementDraft.active].target_block_id =
      b.dataset.targetBlock;
    renderReplacementEdit();
    return;
  }
  if (b.dataset.editTarget !== undefined) {
    replacementDraft.active = Number(b.dataset.editTarget);
    replacementDraft.tab = "manual";
    replacementDraft.query = "";
    renderReplacementEdit();
    $("#block-search").focus();
    return;
  }
  if (b.dataset.removeRule !== undefined) {
    replacementDraft.rules.splice(Number(b.dataset.removeRule), 1);
    replacementDraft.active = Math.min(
      replacementDraft.active,
      replacementDraft.rules.length - 1,
    );
    renderReplacementEdit();
    return;
  }
  if (b.dataset.replaceTab) {
    replacementDraft.tab = b.dataset.replaceTab;
    renderReplacementEdit();
    return;
  }
  if (b.hasAttribute("data-replace-add")) {
    if (replacementDraft.rules.length >= 64)
      return toast("В одном наборе можно сделать до 64 замен");
    const m =
      state.data.materials.find(
        (m) =>
          m.required > 0 &&
          !replacementDraft.rules.some((r) => r.source_id === m.id),
      ) || state.data.materials.find((m) => m.required > 0);
    replacementDraft.rules.push({
      source_id: m.id,
      target_block_id: "",
      quantity: replacementQuantity(m),
    });
    replacementDraft.active = replacementDraft.rules.length - 1;
    replacementDraft.tab = "manual";
    renderReplacementEdit();
    return;
  }
  if (b.hasAttribute("data-build-family")) return buildFamily();
  if (b.hasAttribute("data-save-preset")) return saveReplacementPreset();
  if (b.dataset.loadPreset !== undefined)
    return loadReplacementPreset(Number(b.dataset.loadPreset));
  if (b.hasAttribute("data-preview-replacements"))
    return previewReplacements(b);
  if (b.hasAttribute("data-apply-replacements")) return applyReplacements(b);
  if (b.hasAttribute("data-edit-replacements")) return renderReplacementEdit();
});

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
route();
$(".skip").addEventListener("click", (e) => {
  e.preventDefault();
  main.focus();
});
