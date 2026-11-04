"use strict";
// Shared presentation components. Resource accounting lives in app.js and the API.
function uiIcon(name, extra = "") {
  return `<svg class="ui-icon ${extra}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="./assets/ui-icons.svg?v=5#${name}"></use></svg>`;
}
function currentSection() {
  return state.tab === "materials"
    ? prefs.view === "chests"
      ? "chests"
      : "materials"
    : state.tab;
}
function projectNav() {
  const active = currentSection();
  return `<nav class="app-nav" aria-label="Навигация по сбору"><div class="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div><div class="nav-sections" role="tablist" aria-label="Разделы сбора">${[
    ["materials", "layout-grid", "Материалы"],
    ["editor", "layers", "Редактор схемы"],
    ["chests", "box", "3D-склад"],
    ["mine", "list-checks", "Мои задачи"],
    ["team", "users", "Команда"],
  ]
    .map(
      ([id, icon, label]) =>
        `<button role="tab" id="tab-${id}" data-section="${id}" aria-controls="tab-content" aria-selected="${id === active}" tabindex="${id === active ? 0 : -1}">${uiIcon(icon)}<span>${label}</span>${id === "editor" ? '<small class="feature-new">NEW!</small>' : ""}${id === "mine" ? '<b id="nav-task-count" class="nav-count"></b>' : ""}</button>`,
    )
    .join(
      "",
    )}</div><div class="nav-utilities"><div class="nav-label">ИНСТРУМЕНТЫ</div><button data-do="replacements">${uiIcon("arrow-left-right")}<span>Замены блоков</span></button><button data-do="history">${uiIcon("history")}<span>История</span></button><button data-do="export">${uiIcon("download")}<span>Экспорт списка</span></button></div><div class="nav-foot"><span>${uiIcon("lock")} Доступ по ссылке</span><p>Ваши сборы видите только вы и приглашённые.</p></div></nav>`;
}
function projectOverview() {
  const t = totals(),
    pct = Math.round((t.delivered / t.required) * 100) || 0;
  return `<section class="overview" aria-label="Прогресс сбора"><div class="overview-main"><div class="overview-top"><div><span>Собрано ресурсов</span><strong>${pct}<em>%</em></strong></div><span>${fmt(t.delivered)} <small>/ ${fmt(t.required)}</small></span></div><div class="progress-track" role="progressbar" aria-label="Собрано ресурсов" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, pct)}%"></i></div></div><div class="overview-stat"><span>Осталось собрать</span><b>${fmt(t.required - t.delivered)}</b><small>${fmt(Math.max(0, t.required - t.delivered - t.reserved))} свободно</small></div><div class="overview-stat"><span>В работе у команды</span><b>${fmt(t.reserved)}</b><small>${state.data.people.length} участников</small></div></section>`;
}
function refreshOverview() {
  const old = $(".overview");
  if (old) old.outerHTML = projectOverview();
  const mine = state.data.reservations.filter(
    (r) =>
      r.status === "active" &&
      r.participant_id === state.session?.participant_id,
  ).length;
  const count = $("#nav-task-count");
  if (count) {
    count.textContent = mine || "";
    count.hidden = !mine;
  }
}
function syncNavigation() {
  const active = currentSection();
  document.querySelectorAll(".app-nav [data-section]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.section === active));
    b.tabIndex = b.dataset.section === active ? 0 : -1;
  });
  $("#tab-content")?.setAttribute("aria-labelledby", "tab-" + active);
  refreshOverview();
}
function navigateSection(section, transferChecked = false) {
  if (section === "editor" && state.tab !== "editor" && !transferChecked)
    return suggestSchematicTransfer("editor", () => navigateSection(section, true));
  if (section === "chests" || section === "materials") {
    state.tab = "materials";
    prefs.view =
      section === "chests" ? "chests" : prefs.materialView || "warehouse";
    write("sklad:prefs", prefs);
  } else state.tab = section;
  renderTab();
  syncNavigation();
  if (matchMedia("(max-width:760px)").matches)
    $("#tab-content")?.scrollIntoView({ block: "start", behavior: "auto" });
}
function quickCollect() {
  showDialog(
    "Сдать ресурсы",
    `<p>Выберите материал. Сдача сразу обновит общий прогресс.</p><div class="search-box quick-search">${uiIcon("search")}<label class="visually-hidden" for="quick-search">Найти материал для сдачи</label><input id="quick-search" type="search" placeholder="Название материала…" autocomplete="off"></div><div id="quick-results" class="quick-results"></div>`,
  );
  quickCollectResults("");
  $("#quick-search").focus();
}
function quickCollectResults(query) {
  const q = query.trim().toLowerCase(),
    items = state.data.materials.filter(
      (m) =>
        m.required > m.delivered &&
        (!q || m.label.toLowerCase().includes(q) || m.block_id.includes(q)),
    );
  $("#quick-results").innerHTML =
    items
      .slice(0, 80)
      .map((m) => {
        const free = Math.max(0, m.required - m.delivered - m.reserved);
        return `<button class="quick-material" data-action="${free ? "collect" : "assignments"}" data-id="${m.id}"><img src="${icon(m.block_id)}" width="32" height="32" alt=""><span><b>${esc(m.label)}</b><small>${free ? fmt(free) + " свободно для сдачи" : "Сдать из резерва команды"}</small></span>${uiIcon("chevron-right")}</button>`;
      })
      .join("") ||
    '<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте другое название.</p></div>';
}
function updateTheme() {
  const dark =
    prefs.theme === "dark" ||
    (prefs.theme === "auto" &&
      matchMedia("(prefers-color-scheme:dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark
    ? "#101113"
    : "#f5f5f7";
  chestScene?.theme?.(dark);
  schematicEditor.scene?.theme?.(dark);
}
const uiButtonIcons = {
  share: "link",
  settings: "settings-2",
  preferences: "settings-2",
  history: "history",
  replacements: "arrow-left-right",
  export: "download",
  "open-link": "link",
  "clear-recent": "trash-2",
  "reset-filters": "sliders-horizontal",
  close: "x",
};
const uiChestIcons = {
  select: "mouse-pointer-2",
  place: "plus",
  coordinates: "move-3d",
  camera: "crosshair",
  turn: "rotate-cw",
  rotate: "rotate-cw",
  position: "move-3d",
  labels: "image",
  fill: "plus",
  delete: "trash-2",
  move: "move-3d",
  focus: "maximize-2",
  "slots-size": "layout-grid",
};
// Normalize icons in the existing dialogs while they migrate to shared components.
function upgradeButtonIcon(button) {
  if (
    button.querySelector(".ui-icon") ||
    button.classList.contains("chest-slot") ||
    button.classList.contains("chest-material")
  )
    return;
  const name =
    uiButtonIcons[button.dataset.do] ||
    uiChestIcons[button.dataset.chestTool] ||
    (button.dataset.pin
      ? "star"
      : button.dataset.action === "replace"
        ? "arrow-left-right"
        : button.dataset.undo
          ? "undo-2"
          : button.hasAttribute("data-remove-rule")
            ? "x"
            : null);
  if (!name) return;
  for (const child of button.childNodes) {
    if (child.nodeType === Node.TEXT_NODE)
      child.textContent = child.textContent.replace(/^[\s↗↶⇄＋+×⚙↻⌖↖★☆]+/u, "");
  }
  button.insertAdjacentHTML("afterbegin", uiIcon(name));
}
const uiObserver = new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1 || node.closest("svg")) continue;
      if (node.matches("button")) upgradeButtonIcon(node);
      node.querySelectorAll("button").forEach(upgradeButtonIcon);
    }
});
uiObserver.observe(document.body, { childList: true, subtree: true });
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.section) navigateSection(b.dataset.section);
  if (b.dataset.materialStatus) {
    state.hideDone = b.dataset.materialStatus !== "all";
    state.hideBusy = b.dataset.materialStatus === "free";
    saveFilters();
    renderMaterials();
  }
  if (b.dataset.do === "quick-collect") quickCollect();
  if (b.dataset.do === "toggle-theme") {
    prefs.theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    write("sklad:prefs", prefs);
    updateTheme();
  }
  if (b.dataset.do === "material-filters") {
    $("#material-filters").open = !$("#material-filters").open;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "quick-search") quickCollectResults(e.target.value);
});
document.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "k" &&
    state.data &&
    !dialog.open
  ) {
    e.preventDefault();
    quickCollect();
  }
});
matchMedia("(prefers-color-scheme:dark)").addEventListener("change", () => {
  if (prefs.theme === "auto") updateTheme();
});
function projectMenu() {
  showDialog(
    "Действия со сбором",
    `<div class="project-menu">${[
      ["settings", "settings-2", "Настройки сбора", "Название и заметки"],
      [
        "replacements",
        "arrow-left-right",
        "Замены блоков",
        "Подобрать материалы для постройки",
      ],
      [
        "history",
        "history",
        "История изменений",
        "Посмотреть и отменить действия",
      ],
      ["schematic-editor", "layers", 'Редактор лайтматики <small class="feature-new">NEW!</small>', "3D, замены и скачивание .litematic"],
      ["export", "download", "Экспорт списка", "Скачать материалы в CSV"],
      ["share", "link", "Пригласить команду", "Скопировать секретную ссылку"],
      [
        "preferences",
        "settings-2",
        "Мои настройки",
        "Имя, тема и единицы измерения",
      ],
    ]
      .map(
        ([action, icon, title, detail]) =>
          `<button class="quick-material" data-do="${action}">${uiIcon(icon)}<span><b>${title}</b><small>${detail}</small></span>${uiIcon("chevron-right")}</button>`,
      )
      .join("")}</div>`,
  );
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.do === "project-menu") projectMenu();
  if (!e.target.closest(".filter-disclosure")) {
    const filters = $("#material-filters");
    if (filters) filters.open = false;
  }
});
