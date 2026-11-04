"use strict";
// The scene is lazy loaded; all inventory mutations remain server-authoritative.
let chestScene = null,
  chestMount = 0,
  chestSelected = null,
  chestHighlight = null;
let chestMode = "select",
  chestRotation = 0,
  chestKind = "single",
  chestLevel = 0,
  chestQuery = "";
const chestWarehouse = () =>
  state.data?.warehouse || { revision: 0, chests: [], allocated: {} };
const chestMaterial = (id) =>
  state.data?.materials.find((m) => m.id === Number(id));
const chestCurrent = () =>
  chestWarehouse().chests.find((c) => c.id === chestSelected);
function chestViews() {
  return `<div class="section-heading"><div><span class="eyebrow">${prefs.view === "chests" ? "Всё на своих местах" : "План постройки"}</span><h2>${prefs.view === "chests" ? "3D-склад" : "Материалы"}</h2></div>${prefs.view === "chests" ? `<div class="actions"><button class="btn small" data-chest-tool="coordinates">${uiIcon("plus")} Добавить сундук</button><button class="btn small icon-button" data-do="history" aria-label="История склада">${uiIcon("history")}</button></div>` : `<div class="view-switch" role="group" aria-label="Вид материалов"><button data-view="warehouse" aria-pressed="${prefs.view === "warehouse"}" aria-label="Карточки">${uiIcon("layout-grid")}</button><button data-view="list" aria-pressed="${prefs.view === "list"}" aria-label="Список">${uiIcon("list")}</button></div>`}</div>`;
}
function chestDispose() {
  chestMount++;
  chestScene?.dispose();
  chestScene = null;
  document.body.classList.remove("spatial-view");
}
function chestRender() {
  chestDispose();
  document.body.classList.add("spatial-view");
  $("#tab-content").innerHTML =
    chestViews() +
    `<section id="chest-workbench" class="chest-workbench"><div class="chest-world-column"><div class="chest-world-head"><div><span class="world-section-label">${uiIcon("boxes")} Пространство склада</span></div><span id="chest-count" class="badge"></span></div><div class="chest-scene-wrap"><div class="chest-world" id="chest-world"><div class="chest-loading">Загружаем 3D…</div></div><div class="chest-scene-tools"><button class="btn small primary" data-chest-tool="select">↖ Выбор</button><button class="btn small" data-chest-tool="place">＋ Расставить</button><button class="btn small" data-chest-tool="coordinates">По координатам</button><button class="btn small" data-chest-tool="camera" aria-label="Показать весь склад">⌖ Обзор</button></div><div class="chest-placement" id="chest-placement" hidden><label>Сундук<select id="chest-kind"><option value="single">Обычный · 27 слотов</option><option value="double">Двойной · 54 слота</option></select></label><label>Этаж<select id="chest-level"><option value="0">1 · пол</option><option value="1">2</option><option value="2">3</option><option value="3">4</option></select></label><button class="btn small" data-chest-tool="turn">↻ Повернуть</button><button class="btn small" data-chest-tool="select">Готово</button></div><div class="chest-world-hint" id="chest-world-hint">Вращайте мышью · колесо приближает · правая кнопка сдвигает</div></div><div class="chest-map-summary" id="chest-map-summary"></div><details class="chest-accessible"><summary>Все сундуки · выбор без 3D</summary><div id="chest-directory" class="chest-directory"></div></details></div><aside class="chest-inspector" id="chest-inspector" aria-live="polite"></aside></section><section class="chest-palette-section"><div class="chest-palette-head"><div><h2>Материалы для сундуков</h2><p>Уже сданное можно разложить. Новую сдачу — сразу положить в сундук.</p></div><label><span class="visually-hidden">Найти материал</span><input id="chest-search" type="search" placeholder="Найти материал…" value="${esc(chestQuery)}"></label></div><div id="chest-palette" class="chest-palette"></div></section>`;
  $("#chest-kind").value = chestKind;
  $("#chest-level").value = chestLevel;
  chestUpdate();
  const generation = chestMount,
    container = $("#chest-world");
  import("./chests3d.js?v=5")
    .then(({ mountChestScene }) => {
      if (generation !== chestMount || !container.isConnected) return;
      container.innerHTML = "";
      chestScene = mountChestScene(container, {
        icon,
        material: chestMaterial,
        onSelect: chestSelect,
        onPlace: chestPlace,
        onDrop: chestDrop,
        dark: document.documentElement.dataset.theme === "dark",
        initial: chestSceneData(),
      });
      chestSyncMode();
    })
    .catch(() => {
      if (generation !== chestMount) return;
      container.innerHTML =
        '<div class="chest-no-webgl"><h3>3D недоступно в этом браузере</h3><p>Создавайте сундуки по координатам и открывайте их в списке ниже. Слоты, рамки и таблички работают и без 3D.</p><button class="btn primary" data-chest-tool="coordinates">Добавить сундук</button></div>';
    });
}
function chestSceneData() {
  return {
    chests: chestWarehouse().chests,
    selected: chestSelected,
    highlight: chestHighlight,
    showLabels: true,
  };
}
function chestSelect(id) {
  chestSelected = id;
  chestMode = "select";
  chestUpdate();
  chestSyncMode();
  if (matchMedia("(max-width:760px)").matches)
    $("#chest-inspector")?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
}
function chestUpdate() {
  if (!$("#chest-workbench")) return;
  if (!chestCurrent()) chestSelected = chestWarehouse().chests[0]?.id || null;
  const w = chestWarehouse(),
    allocated = Object.values(w.allocated).reduce((a, b) => a + b, 0),
    delivered = state.data.materials.reduce((n, m) => n + m.delivered, 0);
  $("#chest-count").textContent = `${w.chests.length} / 128 сундуков`;
  $("#chest-map-summary").innerHTML =
    `<span><b>${fmt(allocated)}</b> в сундуках</span><span><b>${fmt(Math.max(0, delivered - allocated))}</b> ещё не разложено</span><span>32 × 32 клетки · 4 этажа</span>`;
  $("#chest-directory").innerHTML =
    w.chests
      .map(
        (c) =>
          `<button class="btn small ${c.id === chestSelected ? "primary" : ""}" data-chest-select="${esc(c.id)}">${esc(c.name)} <small>(${c.x}, ${c.y}, ${c.z}) · ${c.slots.length}/${c.capacity}</small></button>`,
      )
      .join("") ||
    '<p class="helper">Здесь пока пусто. Нажмите «Расставить» и выберите клетку или добавьте сундук по координатам.</p>';
  chestInspector();
  chestPalette();
  chestScene?.update(chestSceneData());
  refreshOverview();
}
function chestInspector() {
  const c = chestCurrent(),
    root = $("#chest-inspector");
  if (!c) {
    root.innerHTML = `<div class="chest-empty-inspector"><div class="chest-empty-icon" aria-hidden="true">${uiIcon("box")}</div><h3>Место для всего</h3><p>Добавьте первый сундук. Разложите ресурсы, повесьте рамку или подпишите табличку.</p><button class="btn primary" data-chest-tool="place">＋ Поставить сундук</button><button class="btn" data-chest-tool="coordinates">Указать координаты</button><small>Рамки с материалами и таблички настраиваются у каждого сундука.</small></div>`;
    return;
  }
  root.innerHTML = `<button class="btn small chest-back-to-scene" data-chest-tool="back-to-scene">${uiIcon("arrow-left")} К складу</button><div class="chest-inspector-title"><div><span class="eyebrow">${c.kind === "double" ? "Двойной сундук" : "Сундук"} · ${c.capacity} слотов</span><h3>${esc(c.name)}</h3></div><button class="btn small" data-chest-tool="labels" aria-label="Название, рамка и табличка">${uiIcon("settings-2")}</button></div><div class="chest-coords">X ${c.x} · Y ${c.y} · Z ${c.z}<button class="btn small" data-chest-tool="position">Переместить</button><button class="btn small" data-chest-tool="rotate" aria-label="Повернуть сундук на 90 градусов">↻</button></div><button class="btn small chest-slot-size" data-chest-tool="slots-size" aria-pressed="${!!prefs.chestLargeSlots}">Крупные слоты</button><div class="chest-slot-grid ${prefs.chestLargeSlots ? "large-slots" : ""}" role="group" aria-label="Содержимое ${esc(c.name)}">${Array.from(
    { length: c.capacity },
    (_, i) => {
      const s = c.slots.find((s) => s.slot === i),
        m = s && chestMaterial(s.material_id);
      return `<button class="chest-slot ${s ? "occupied" : ""}" data-chest-slot="${i}" ${s ? 'draggable="true"' : ""} aria-label="Слот ${i + 1}: ${m ? esc(m.label) + ", " + s.quantity + " шт." : "пусто, добавить материал"}" title="${m ? esc(m.label) + " · " + s.quantity + " шт." : "Слот " + (i + 1) + " · добавить"}">${m ? `<img src="${icon(m.block_id)}" alt="" draggable="false"><b>${s.quantity}</b>` : ""}</button>`;
    },
  ).join(
    "",
  )}</div><p class="helper chest-slot-help">Нажмите слот, чтобы наполнить или перенести. Можно перетаскивать стаки между слотами и на сундуки в 3D.</p><div class="chest-inspector-actions"><button class="btn primary" data-chest-tool="fill">＋ Наполнить</button><button class="btn" data-chest-tool="labels">Рамка и табличка</button></div><div class="chest-label-preview">${["frame", "both"].includes(c.label_mode) ? `<span>${uiIcon("image")} Рамка: ${esc(state.data.materials.find((m) => m.block_id === c.label_material)?.label || (c.label_material ? "выбранный материал" : "по содержимому"))}</span>` : ""}${["sign", "both"].includes(c.label_mode) ? `<span>${uiIcon("type")} ${esc(c.sign_text || c.name)}</span>` : ""}</div><button class="btn link small chest-remove" data-chest-tool="delete">Убрать сундук</button>`;
}
function chestPalette() {
  const root = $("#chest-palette");
  if (!root) return;
  const q = chestQuery.trim().toLowerCase(),
    w = chestWarehouse();
  const items = state.data.materials
    .filter(
      (m) => !q || m.label.toLowerCase().includes(q) || m.block_id.includes(q),
    )
    .sort(
      (a, b) =>
        b.delivered -
        (w.allocated[b.id] || 0) -
        (a.delivered - (w.allocated[a.id] || 0)),
    );
  root.innerHTML =
    items
      .map((m) => {
        const free = Math.max(0, m.delivered - (w.allocated[m.id] || 0));
        return `<button class="chest-material ${chestHighlight === m.block_id ? "active" : ""}" data-chest-material="${m.id}" draggable="true" title="${esc(m.label)} — выбрать сундук и наполнить"><img src="${icon(m.block_id)}" alt="" loading="lazy" width="30" height="30" draggable="false"><span><b>${esc(m.label)}</b><small>${free ? fmt(free) + " не разложено" : "Нет в неразложенном"} · ${fmt(w.allocated[m.id] || 0)} в сундуках</small></span>${uiIcon("plus")}</button>`;
      })
      .join("") || '<p class="helper">Материалы не найдены.</p>';
}
function chestSyncMode() {
  chestScene?.setMode({
    mode: chestMode,
    kind: chestKind,
    rotation: chestRotation,
    level: chestLevel,
  });
  const placement = $("#chest-placement");
  if (placement) placement.hidden = chestMode === "select";
  document
    .querySelectorAll('[data-chest-tool="place"],[data-chest-tool="select"]')
    .forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.chestTool === chestMode));
      b.classList.toggle("primary", b.dataset.chestTool === chestMode);
    });
  const hint = $("#chest-world-hint");
  if (hint)
    hint.textContent =
      chestMode === "select"
        ? "Вращайте мышью · колесо приближает · на телефоне — двумя пальцами"
        : `${chestMode === "move" ? "Перемещение" : "Расстановка"} · нажмите на клетку · поворот ${chestRotation * 90}° · зелёный — свободно`;
}
async function chestMutate(path, data, message, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try {
    await ensureSession();
    const r = await api(path, {
      ...auth(),
      revision: chestWarehouse().revision,
      ...data,
    });
    if (r.chest_id && data.op !== "delete") chestSelected = r.chest_id;
    await poll(true);
    if (dialog.open) closeDialog();
    toast(message, r.change_id);
    return r;
  } catch (err) {
    try {
      await poll(true);
    } catch {}
    const box = $("#chest-error");
    if (box && dialog.open) box.textContent = err.message;
    else toast(err.message);
    return null;
  } finally {
    busy = false;
    if (button?.isConnected) button.disabled = false;
  }
}
async function chestPlace(cell, mode) {
  if (busy) return;
  const c = chestCurrent();
  const result = await chestMutate(
    "chest",
    {
      op: mode === "move" ? "update" : "create",
      ...(mode === "move" ? { chest_id: c?.id } : {}),
      ...cell,
    },
    mode === "move" ? "Сундук перемещён" : "Сундук поставлен",
  );
  if (result && mode === "move") {
    chestMode = "select";
    chestSyncMode();
  }
}
function chestOptions(selected) {
  return state.data.materials
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === Number(selected) ? "selected" : ""}>${esc(m.label)}</option>`,
    )
    .join("");
}
function chestLabels() {
  const c = chestCurrent();
  if (!c) return;
  showDialog(
    "Название, рамка и табличка",
    `<form id="chest-label-form" class="form"><div class="field"><label for="chest-name">Название сундука</label><input id="chest-name" maxlength="40" value="${esc(c.name)}" required></div><div class="field"><label for="chest-label-mode">Что повесить на сундук</label><select id="chest-label-mode"><option value="none">Без меток</option><option value="frame">Рамку с материалом</option><option value="sign">Табличку с текстом</option><option value="both">Рамку и табличку</option></select></div><div class="field"><label for="chest-frame-material">Материал в рамке</label><select id="chest-frame-material"><option value="">Автоматически по содержимому</option>${state.data.materials.map((m) => `<option value="${esc(m.block_id)}">${esc(m.label)}</option>`).join("")}</select></div><div class="field"><label for="chest-sign-text">Текст таблички</label><textarea id="chest-sign-text" maxlength="64" rows="2" placeholder="Например, дерево для крыши">${esc(c.sign_text)}</textarea><small>До 64 символов. Если пусто — название сундука.</small></div><p id="chest-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button type="button" class="btn" data-do="close">Отмена</button><button class="btn primary" type="submit">Повесить и сохранить</button></div></form>`,
  );
  $("#chest-label-mode").value = c.label_mode;
  $("#chest-frame-material").value = c.label_material;
  chestLabelFields();
}
function chestLabelFields() {
  const mode = $("#chest-label-mode")?.value;
  if (!mode) return;
  $("#chest-frame-material").closest(".field").hidden = ![
    "frame",
    "both",
  ].includes(mode);
  $("#chest-sign-text").closest(".field").hidden = !["sign", "both"].includes(
    mode,
  );
}
function chestCoordinates(edit = false) {
  const c = edit ? chestCurrent() : null;
  showDialog(
    c ? "Положение сундука" : "Новый сундук",
    `<form id="chest-coordinate-form" class="form" data-edit="${c ? esc(c.id) : ""}"><p class="helper">X и Z: от −16 до 15. Верхние сундуки должны стоять на нижних.</p><div class="qty-fields"><div class="field"><label for="chest-x">X</label><input id="chest-x" type="number" min="-16" max="15" value="${c?.x ?? 0}" required></div><div class="field"><label for="chest-z">Z</label><input id="chest-z" type="number" min="-16" max="15" value="${c?.z ?? 0}" required></div></div><div class="qty-fields"><div class="field"><label for="chest-y">Этаж (Y)</label><select id="chest-y">${[0, 1, 2, 3].map((y) => `<option value="${y}">${y + 1} · Y ${y}</option>`).join("")}</select></div><div class="field"><label for="chest-facing">Поворот</label><select id="chest-facing">${[0, 1, 2, 3].map((r) => `<option value="${r}">${r * 90}°</option>`).join("")}</select></div></div><div class="field"><label for="chest-size">Размер</label><select id="chest-size"><option value="single">Обычный · 27 слотов</option><option value="double">Двойной · 54 слота</option></select></div><p id="chest-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button type="button" class="btn" data-do="close">Отмена</button>${c ? '<button type="button" class="btn" data-chest-tool="move">Выбрать в 3D</button>' : ""}<button type="submit" class="btn primary">${c ? "Переместить" : "Поставить"}</button></div></form>`,
  );
  $("#chest-y").value = c?.y ?? chestLevel;
  $("#chest-facing").value = c?.rotation ?? chestRotation;
  $("#chest-size").value = c?.kind ?? chestKind;
}
let chestFillDraft = null;
function chestFill(materialId = null, slot = null, chestId = chestSelected) {
  const c = chestWarehouse().chests.find((c) => c.id === chestId);
  if (!c) return toast("Сначала поставьте или выберите сундук");
  chestFillDraft = { chestId, slot };
  const existing = slot === null ? null : c.slots.find((s) => s.slot === slot);
  materialId =
    existing?.material_id ||
    materialId ||
    state.data.materials.find(
      (m) => m.delivered - (chestWarehouse().allocated[m.id] || 0) > 0,
    )?.id ||
    state.data.materials[0]?.id;
  showDialog(
    "Наполнить сундук",
    `<form id="chest-fill-form" class="form"><p>${esc(c.name)} · ${slot === null ? "автоматически по свободным слотам" : "слот " + (slot + 1)}</p><div class="field"><label for="chest-fill-material">Материал</label><select id="chest-fill-material" ${existing ? "disabled" : ""}>${chestOptions(materialId)}</select></div><div class="field"><label for="chest-fill-source">Откуда ресурсы</label><select id="chest-fill-source"></select></div><div class="notice" id="chest-fill-limit"></div><div class="field"><label for="chest-quantity">Количество</label><input id="chest-quantity" type="text" inputmode="text" autocomplete="off" required placeholder="64 или 2ст 12"><small>Можно вводить стаки и шалкеры: 2ш 5ст 12</small></div><div class="presets"><button class="btn small" type="button" data-chest-amount="stack">Один стак</button><button class="btn small" type="button" data-chest-amount="max">Всё, что помещается</button></div><p id="chest-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button class="btn" type="button" data-do="close">Отмена</button><button class="btn primary" id="chest-fill-submit" type="submit">Положить в сундук</button></div></form>`,
  );
  chestFillSources();
}
function chestFillSources() {
  const m = chestMaterial($("#chest-fill-material").value);
  if (!m) return;
  const available = Math.max(
      0,
      m.delivered - (chestWarehouse().allocated[m.id] || 0),
    ),
    free = Math.max(0, m.required - m.delivered - m.reserved);
  $("#chest-fill-source").innerHTML =
    `<option value="allocate" ${available ? "" : "disabled"}>Разложить уже сданное · ${fmt(available)}</option><option value="collect" ${free ? "" : "disabled"}>Новая сдача без резерва · ${fmt(free)}</option>` +
    state.data.reservations
      .filter((r) => r.material_id === m.id && r.status === "active")
      .map(
        (r) =>
          `<option value="deliver:${esc(r.id)}">Сдать из резерва ${esc(r.nickname)} · ${fmt(r.quantity - r.delivered)}</option>`,
      )
      .join("");
  const first = [...$("#chest-fill-source").options].find((o) => !o.disabled);
  $("#chest-fill-source").value = first?.value || "";
  chestFillLimit();
}
function chestFillMax() {
  const d = chestFillDraft,
    m = chestMaterial($("#chest-fill-material")?.value),
    c = chestWarehouse().chests.find((c) => c.id === d?.chestId);
  if (!m || !c) return 0;
  const size = stackSize(m.block_id);
  let capacity = 0;
  for (let i = 0; i < c.capacity; i++) {
    if (d.slot !== null && d.slot !== i) continue;
    const s = c.slots.find((s) => s.slot === i);
    if (!s || s.material_id === m.id) capacity += size - (s?.quantity || 0);
  }
  const source = $("#chest-fill-source").value;
  const r = state.data.reservations.find((r) => "deliver:" + r.id === source);
  const max =
    source === "allocate"
      ? m.delivered - (chestWarehouse().allocated[m.id] || 0)
      : source === "collect"
        ? m.required - m.delivered - m.reserved
        : r
          ? r.quantity - r.delivered
          : 0;
  return Math.max(0, Math.min(capacity, max, 3456));
}
function chestFillLimit() {
  const m = chestMaterial($("#chest-fill-material").value),
    max = chestFillMax();
  $("#chest-fill-limit").textContent =
    `Можно положить: ${quantityText(max, m.block_id)} ${$("#chest-fill-source").value === "allocate" ? "Прогресс сбора останется прежним." : "Сдача увеличит прогресс сбора."}`;
  $("#chest-quantity").value = Math.min(max, stackSize(m.block_id));
  $("#chest-fill-submit").disabled = !max;
}
function chestTransfer(slot) {
  const c = chestCurrent(),
    s = c?.slots.find((s) => s.slot === slot),
    m = s && chestMaterial(s.material_id);
  if (!s) return;
  showDialog(
    "Перенести ресурсы",
    `<form id="chest-transfer-form" class="form" data-source="${esc(c.id)}" data-slot="${slot}"><div class="ident"><img src="${icon(m.block_id)}" width="40" height="40" alt=""><div><b>${esc(m.label)}</b><p>${esc(c.name)} · слот ${slot + 1} · ${s.quantity} шт.</p></div></div><div class="field"><label for="chest-target">Куда перенести</label><select id="chest-target"><option value="">В неразложенное</option>${chestWarehouse()
      .chests.filter((x) => x.id !== c.id)
      .map(
        (x) =>
          `<option value="${esc(x.id)}">${esc(x.name)} · (${x.x}, ${x.y}, ${x.z})</option>`,
      )
      .join(
        "",
      )}</select></div><div class="field"><label for="chest-transfer-qty">Количество</label><input id="chest-transfer-qty" type="number" min="1" max="${s.quantity}" value="${s.quantity}" required></div><p class="helper">Общее количество сданных ресурсов не изменится. Для перестановки внутри сундука перетащите стак в другой слот.</p><p id="chest-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button type="button" class="btn" data-chest-topup="${slot}">Добавить сюда</button><button class="btn primary" type="submit">Перенести</button></div></form>`,
  );
}
function chestDrop(id, slotRaw, materialRaw, targetSlot = null) {
  try {
    if (slotRaw) {
      const s = JSON.parse(slotRaw);
      if (s.project !== state.id) return;
      return chestMutate(
        "chest-transfer",
        {
          chest_id: s.chest,
          slot: s.slot,
          quantity: s.quantity,
          target_chest_id: id,
          target_slot: targetSlot,
        },
        "Ресурсы перенесены",
      );
    }
    if (materialRaw) {
      const m = JSON.parse(materialRaw);
      if (m.project !== state.id) return;
      chestSelected = id;
      chestUpdate();
      chestFill(m.id, targetSlot, id);
    }
  } catch {
    toast("Не удалось перенести материал");
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.chestSelect) return chestSelect(b.dataset.chestSelect);
  if (b.dataset.chestMaterial) {
    const m = chestMaterial(b.dataset.chestMaterial);
    chestHighlight = m.block_id;
    chestScene?.update(chestSceneData());
    if (chestCurrent()) chestFill(m.id);
    else toast("Выберите сундук: подходящие сундуки подсвечены");
    return;
  }
  if (b.dataset.chestSlot !== undefined) {
    const i = Number(b.dataset.chestSlot);
    return chestCurrent()?.slots.some((s) => s.slot === i)
      ? chestTransfer(i)
      : chestFill(null, i);
  }
  if (b.dataset.chestTopup !== undefined)
    return chestFill(null, Number(b.dataset.chestTopup));
  if (b.dataset.chestAmount) {
    const m = chestMaterial($("#chest-fill-material").value);
    $("#chest-quantity").value =
      b.dataset.chestAmount === "max"
        ? chestFillMax()
        : Math.min(chestFillMax(), stackSize(m.block_id));
    return;
  }
  if (b.dataset.chestConfirmDelete)
    return chestMutate(
      "chest",
      { op: "delete", chest_id: b.dataset.chestConfirmDelete },
      "Сундук убран, ресурсы возвращены в неразложенное",
      b,
    );
  const tool = b.dataset.chestTool,
    c = chestCurrent();
  if (!tool) return;
  if (tool === "select" || tool === "place") {
    chestMode = tool;
    chestSyncMode();
    $("#chest-workbench")?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  }
  if (tool === "turn") {
    chestRotation = (chestRotation + 1) % 4;
    chestSyncMode();
  }
  if (tool === "camera") chestScene?.reset();
  if (tool === "back-to-scene")
    $("#chest-workbench")?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  if (tool === "coordinates") chestCoordinates();
  if (tool === "position") chestCoordinates(true);
  if (tool === "move") {
    closeDialog();
    chestMode = "move";
    chestRotation = c.rotation;
    chestLevel = c.y;
    $("#chest-level").value = chestLevel;
    chestSyncMode();
  }
  if (tool === "slots-size") {
    prefs.chestLargeSlots = !prefs.chestLargeSlots;
    write("sklad:prefs", prefs);
    chestInspector();
    $('[data-chest-tool="slots-size"]')?.focus({ preventScroll: true });
  }
  if (tool === "labels") chestLabels();
  if (tool === "fill") chestFill();
  if (tool === "rotate" && c)
    chestMutate(
      "chest",
      { op: "update", chest_id: c.id, rotation: (c.rotation + 1) % 4 },
      "Сундук повёрнут",
      b,
    );
  if (tool === "delete" && c)
    showDialog(
      "Убрать сундук?",
      `<p>«${esc(c.name)}» исчезнет со склада. Все его ресурсы вернутся в неразложенное; сданное количество сохранится.</p><p id="chest-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button class="btn" data-do="close">Отмена</button><button class="btn danger" data-chest-confirm-delete="${esc(c.id)}">Убрать сундук</button></div>`,
    );
});
document.addEventListener("change", (e) => {
  if (e.target.id === "chest-kind") {
    chestKind = e.target.value;
    chestSyncMode();
  }
  if (e.target.id === "chest-level") {
    chestLevel = Number(e.target.value);
    chestSyncMode();
  }
  if (e.target.id === "chest-label-mode") chestLabelFields();
  if (e.target.id === "chest-fill-material") chestFillSources();
  if (e.target.id === "chest-fill-source") chestFillLimit();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "chest-search") {
    chestQuery = e.target.value;
    chestPalette();
  }
});
document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!f.id.startsWith("chest-")) return;
  e.preventDefault();
  const button = f.querySelector('[type="submit"]'),
    c = chestCurrent();
  if (f.id === "chest-label-form")
    chestMutate(
      "chest",
      {
        op: "update",
        chest_id: c.id,
        name: $("#chest-name").value,
        label_mode: $("#chest-label-mode").value,
        label_material: $("#chest-frame-material").value,
        sign_text: $("#chest-sign-text").value,
      },
      "Рамка и табличка сохранены",
      button,
    );
  if (f.id === "chest-coordinate-form")
    chestMutate(
      "chest",
      {
        op: f.dataset.edit ? "update" : "create",
        chest_id: f.dataset.edit,
        x: Number($("#chest-x").value),
        y: Number($("#chest-y").value),
        z: Number($("#chest-z").value),
        rotation: Number($("#chest-facing").value),
        kind: $("#chest-size").value,
      },
      "Положение сундука сохранено",
      button,
    );
  if (f.id === "chest-fill-form") {
    try {
      const m = chestMaterial($("#chest-fill-material").value),
        quantity = parseAmount($("#chest-quantity").value, m.block_id),
        source = $("#chest-fill-source").value;
      if (quantity < 1 || quantity > chestFillMax())
        throw Error("Количество должно быть от 1 до " + chestFillMax());
      chestMutate(
        "chest-fill",
        {
          chest_id: chestFillDraft.chestId,
          slot: chestFillDraft.slot,
          material_id: m.id,
          quantity,
          mode: source.startsWith("deliver:") ? "deliver" : source,
          reservation_id: source.split(":")[1] || "",
        },
        "Ресурсы в сундуке",
        button,
      );
    } catch (err) {
      $("#chest-error").textContent = err.message;
    }
  }
  if (f.id === "chest-transfer-form")
    chestMutate(
      "chest-transfer",
      {
        chest_id: f.dataset.source,
        slot: Number(f.dataset.slot),
        quantity: Number($("#chest-transfer-qty").value),
        target_chest_id: $("#chest-target").value,
      },
      "Ресурсы перенесены",
      button,
    );
});
document.addEventListener("dragstart", (e) => {
  const slot = e.target.closest("[data-chest-slot]"),
    material = e.target.closest("[data-chest-material]");
  if (slot) {
    const c = chestCurrent(),
      s = c?.slots.find((s) => s.slot === Number(slot.dataset.chestSlot));
    if (!s) return;
    e.dataTransfer.setData(
      "application/x-sklad-slot",
      JSON.stringify({
        project: state.id,
        chest: c.id,
        slot: s.slot,
        quantity: s.quantity,
      }),
    );
    e.dataTransfer.effectAllowed = "move";
  } else if (material) {
    e.dataTransfer.setData(
      "application/x-sklad-material",
      JSON.stringify({
        project: state.id,
        id: Number(material.dataset.chestMaterial),
      }),
    );
    e.dataTransfer.effectAllowed = "copy";
  }
});
document.addEventListener("dragover", (e) => {
  if (e.target.closest("[data-chest-slot]")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const slot = e.target.closest("[data-chest-slot]");
  if (!slot) return;
  e.preventDefault();
  chestDrop(
    chestSelected,
    e.dataTransfer.getData("application/x-sklad-slot"),
    e.dataTransfer.getData("application/x-sklad-material"),
    Number(slot.dataset.chestSlot),
  );
});

document.addEventListener("keydown", (e) => {
  if (
    !e.target.closest("#chest-world") ||
    /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)
  )
    return;
  if (e.key === "Escape") {
    chestMode = "select";
    chestSyncMode();
  }
  if (e.key.toLowerCase() === "r" && chestMode !== "select") {
    e.preventDefault();
    chestRotation = (chestRotation + 1) % 4;
    chestSyncMode();
  }
});
