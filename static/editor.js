'use strict';
// Editor state stays in this tab. Files are never saved in collection storage.
const schematicEditor = {
  file: null, original: null, preview: null, rules: [], metadata: {}, region: '',
  preserve: true, before: false, pendingRules: null, busy: false, request: 0,
  dirty: false, scene: null, catalog: null, filterRegion: -1, layer: Infinity, material: '',
};
// Files are shared between modes only after the visitor chooses to transfer them.
const collectionDraft = {file: null, title: '', origin: ''};
const collectionSources = new Map();
const transferFileIds = new WeakMap();
let transferFileSequence = 0, pendingSchematicTransfer = null;
function transferFileId(file) {
  if (!transferFileIds.has(file)) transferFileIds.set(file, 'file-' + ++transferFileSequence);
  return transferFileIds.get(file);
}
function rememberCollectionDraft() {
  const input = $('#schematic'), title = $('#collection-title');
  if (input?.files[0] && input.files[0] !== collectionDraft.file) {
    collectionDraft.file = input.files[0];
    collectionDraft.origin = transferFileId(input.files[0]);
  }
  if (title) collectionDraft.title = title.value;
}
function restoreCollectionDraft() {
  const input = $('#schematic'), title = $('#collection-title');
  if (!input) return;
  if (title) title.value = collectionDraft.title;
  if (!collectionDraft.file) return;
  const files = new DataTransfer();
  files.items.add(collectionDraft.file);
  input.files = files.files;
  $('#file-label').textContent = collectionDraft.file.name;
}
function editorHasChanges() {
  const e = schematicEditor;
  return !!e.file && (e.rules.length > 0 || ['Name','Author','Description'].some(k => (e.metadata[k] || '') !== (e.original?.metadata[k] || '')));
}
function editorFileOrigin() {
  const e = schematicEditor;
  if (!e.file) return '';
  return editorHasChanges() ? transferFileId(e.file) + ':' + JSON.stringify(editorOptions()) : (e.fileOrigin || transferFileId(e.file));
}
function collectionSource() {
  rememberCollectionDraft();
  if (state.id) return collectionSources.get(state.id) || null;
  return collectionDraft.file ? {...collectionDraft} : null;
}
function suggestSchematicTransfer(target, navigate) {
  if (schematicEditor.busy || busy) {
    toast('Дождитесь обработки схемы');
    return;
  }
  let candidate;
  if (target === 'editor') {
    candidate = collectionSource();
    if (!candidate || candidate.origin === editorFileOrigin()) return navigate();
  } else {
    const e = schematicEditor;
    if (!e.file || !($('#editor-root') || state.tab === 'editor')) return navigate();
    const edited = editorHasChanges();
    candidate = {file: e.file, origin: editorFileOrigin(), edited,
      title: e.metadata.Name || e.file.name.replace(/\.litematic$/i, ''),
      name: edited ? e.file.name.replace(/\.litematic$/i, '') + '-edited.litematic' : e.file.name,
      options: edited ? structuredClone(editorOptions()) : null};
    if (candidate.origin === collectionDraft.origin) return navigate();
  }
  const destination = target === 'editor' ? 'редактор лайтматики' : 'новый сбор ресурсов';
  const currentFile = target === 'editor' ? schematicEditor.file : collectionDraft.file;
  pendingSchematicTransfer = {target, candidate, navigate};
  showDialog('Перенести схему?', `<p>Использовать <b>${esc(candidate.name || candidate.file.name)}</b> в разделе «${destination}»?</p>${candidate.edited ? '<p class="helper">В сбор попадёт схема со всеми текущими заменами блоков и метаданными из редактора.</p>' : '<p class="helper">Повторно выбирать файл не потребуется.</p>'}${currentFile ? `<div class="notice">В этом разделе уже есть «${esc(currentFile.name)}». При переносе откроется выбранная схема.</div>` : ''}<p class="error-inline" id="transfer-error" role="alert"></p><div class="dialog-actions"><button class="btn" data-transfer-skip>Без переноса</button><button class="btn primary" data-transfer-accept>${uiIcon('arrow-right')} Перенести схему</button></div>`);
}
async function acceptSchematicTransfer(button) {
  const transfer = pendingSchematicTransfer;
  if (!transfer) return;
  const {target, candidate, navigate} = transfer;
  dialog.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    let file = candidate.file;
    if (candidate.edited) {
      button.textContent = 'Собираем схему…';
      const blob = await editorRequest('export', file, candidate.options);
      if (!dialog.open || pendingSchematicTransfer !== transfer) {
        if (pendingSchematicTransfer === transfer) pendingSchematicTransfer = null;
        return;
      }
      file = new File([blob], candidate.name, {type: 'application/octet-stream', lastModified: Date.now()});
    }
    if (target === 'editor') {
      schematicEditor.pendingFile = file;
      schematicEditor.pendingFileOrigin = candidate.origin;
    } else {
      Object.assign(collectionDraft, {file, origin: candidate.origin, title: candidate.title.slice(0,80)});
    }
    pendingSchematicTransfer = null;
    closeDialog();
    navigate();
  } catch (err) {
    const error = $('#transfer-error'); if (error) error.textContent = err.message;
    button.innerHTML = `${uiIcon('arrow-right')} Перенести схему`;
    dialog.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}
function goHomeMode(mode) {
  const target = mode === 'editor' ? '#editor' : '';
  if (location.hash === target) mode === 'editor' ? standaloneEditor() : home();
  else location.hash = target;
}
function switchHomeMode(mode) {
  rememberCollectionDraft();
  const current = $('#editor-root') || state.id && state.tab === 'editor' ? 'editor' : 'collection';
  if (mode === current && !state.id) return;
  suggestSchematicTransfer(mode, () => goHomeMode(mode));
}
document.addEventListener('click', ev => {
  const link = ev.target.closest('a[data-home-mode]');
  if (link && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault(); switchHomeMode(link.dataset.homeMode); return;
  }
  const button = ev.target.closest('button');
  if (!button || button.disabled) return;
  if (button.hasAttribute('data-transfer-accept')) acceptSchematicTransfer(button);
  if (button.hasAttribute('data-transfer-skip') && pendingSchematicTransfer) {
    const navigate = pendingSchematicTransfer.navigate;
    pendingSchematicTransfer = null; closeDialog(); navigate();
  }
  if (button.hasAttribute('data-editor-to-collection')) switchHomeMode('collection');
});
function disposeEditor() {
  if (schematicEditor.scene) schematicEditor.cameraPose = schematicEditor.scene.pose();
  schematicEditor.scene?.dispose();
  schematicEditor.scene = null;
}
function homeTools(active = 'collection') {
  return `<nav class="home-tools" aria-label="Инструменты Litematica"><a href="./" data-home-mode="collection" class="${active === 'collection' ? 'active' : ''}" ${active === 'collection' ? 'aria-current="page"' : ''}>${uiIcon('users')} Сбор ресурсов</a><a href="#editor" data-home-mode="editor" class="${active === 'editor' ? 'active' : ''}" ${active === 'editor' ? 'aria-current="page"' : ''}>${uiIcon('layers')} <span>Редактор <span class="editor-mode-word">лайтматики</span></span> <small class="feature-new">NEW!</small></a></nav>`;
}
function standaloneEditor() {
  home();
  document.title = 'Редактор .litematic · Склад';
  main.innerHTML = `${homeTools('editor')}<header class="editor-intro"><div><span class="eyebrow">Litematica Studio</span><h1>Посмотреть. Заменить. Построить.</h1><p>Ваша схема в 3D — с заменой блоков, метаданными и готовым файлом на выходе.</p></div><span class="editor-intro-icon">${uiIcon('layers')}</span></header><div id="editor-root"></div>`;
  renderEditor();
}
function openSchematicEditor(rules = null) {
  if (dialog.open) closeDialog();
  if (rules) {
    schematicEditor.pendingRules = rules.map(r => ({source: r.source_block_id, target: r.target_block_id, quantity: r.quantity}));
  }
  if (state.id && state.data) navigateSection('editor');
  else if (location.hash === '#editor') standaloneEditor();
  else location.hash = 'editor';
}
function importCollectionRules() {
  const e = schematicEditor;
  if (!e.pendingRules) return;
  const aliases = { 'minecraft:redstone': 'minecraft:redstone_wire', 'minecraft:string': 'minecraft:tripwire' };
  e.rules = e.pendingRules.map(r => ({ ...r, source: aliases[r.source] || r.source, target: aliases[r.target] || r.target }));
  e.pendingRules = null;
  e.dirty = true;
}
function editorSourceOptions(selected = '') {
  const missing = selected && !(schematicEditor.original?.materials || []).some(m => m.id === selected) ? `<option selected value="${esc(selected)}">Не найден в схеме: ${esc(selected)}</option>` : '';
  return missing + (schematicEditor.original?.materials || []).map(m => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)} · ${fmt(m.count)}</option>`).join('');
}
function renderEditor() {
  disposeEditor();
  const root = $('#editor-root') || $('#tab-content');
  if (!root) return;
  const e = schematicEditor;
  if (e.pendingRules && e.original && !e.pendingFile) importCollectionRules();
  root.innerHTML = `<div class="editor-workspace"><div class="editor-topline"><div><h2>Редактор лайтматики <span class="feature-new">NEW!</span></h2><p>${e.file ? esc(e.file.name) : 'Откройте .litematic, чтобы начать'}</p></div><label class="btn small editor-file-label">${uiIcon('upload')} ${e.file ? 'Открыть другой файл' : 'Выбрать файл'}<input type="file" id="editor-file" accept=".litematic" aria-label="Открыть файл .litematic"></label></div><div id="editor-error" class="error-inline" role="alert"></div><div id="editor-status" class="helper" role="status" aria-live="polite"></div>${!e.original ? `<label class="editor-drop" id="editor-drop" for="editor-file"><span>${uiIcon('file-box')}</span><h3>Перетащите вашу постройку сюда</h3><p>или выберите файл .litematic</p><small>До 40 МБ · без регистрации · исходный файл сохранится у вас</small></label>${state.id ? '<p class="notice">Выберите исходную схему этого сбора. Раньше файлы после подсчёта материалов не сохранялись.</p>' : ''}<div class="editor-feature-grid"><div>${uiIcon('move-3d')}<h3>Рассмотрите со всех сторон</h3><p>Вращение, масштаб, регионы и слои.</p></div><div>${uiIcon('arrow-left-right')}<h3>Подберите новые блоки</h3><p>Несколько замен с сохранением подходящих свойств.</p></div><div>${uiIcon('download')}<h3>Заберите готовую схему</h3><p>Скачайте .litematic и откройте в игре.</p></div></div>` : `<div class="editor-layout"><section class="editor-visual"><div class="editor-viewbar"><div class="status-switch" role="group" aria-label="Вариант схемы"><button data-editor-compare="after" aria-pressed="${!e.before}">После</button><button data-editor-compare="before" aria-pressed="${e.before}">Исходная</button></div><div class="actions"><button class="btn small icon-button" data-editor-view="iso" title="Изометрия" aria-label="Изометрический вид">${uiIcon('move-3d')}</button><button class="btn small" data-editor-view="top">Сверху</button><button class="btn small" data-editor-view="front">Спереди</button><button class="btn small icon-button" data-editor-fullscreen title="На весь экран" aria-label="Развернуть 3D на весь экран">${uiIcon('maximize-2')}</button></div></div><div class="editor-canvas" id="editor-canvas"><div class="editor-canvas-loading">Открываем 3D…</div></div><div class="editor-view-controls"><label>Регион<select id="editor-view-region"><option value="-1">Все регионы</option>${e.original.regions.map((r, i) => `<option value="${i}" ${i === e.filterRegion ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label><label class="editor-layer-label">Слой Y <output id="editor-layer-value">${e.layer === Infinity ? 'Все' : e.layer}</output><input id="editor-layer" type="range" min="${e.original.bounds.min[1]}" max="${e.original.bounds.max[1] - 1}" value="${e.layer === Infinity ? e.original.bounds.max[1] - 1 : e.layer}" aria-label="Показать слои до выбранной высоты"></label><label class="check"><input id="editor-region-boxes" type="checkbox" ${e.showBoxes ? 'checked' : ''}>Границы</label></div><div class="editor-caption"><span id="editor-render-count"></span><span>ЛКМ / касание — вращать · ПКМ — двигать · колесо / щипок — масштаб</span></div><div id="editor-picked" class="editor-picked">Нажмите на блок, чтобы посмотреть его свойства и координаты.</div><div id="editor-model-note" class="helper"></div></section><aside class="editor-inspector"><div class="editor-inspector-tabs" role="tablist" aria-label="Панели редактора"><button data-editor-panel="replace" role="tab" id="editor-tab-replace" aria-controls="editor-panel-replace" aria-selected="true">Замены</button><button data-editor-panel="metadata" role="tab" id="editor-tab-metadata" aria-controls="editor-panel-metadata" aria-selected="false" tabindex="-1">Данные</button><button data-editor-panel="palette" role="tab" id="editor-tab-palette" aria-controls="editor-panel-palette" aria-selected="false" tabindex="-1">Палитра</button></div><section id="editor-panel-replace" role="tabpanel" aria-labelledby="editor-tab-replace"><div class="editor-panel-head"><h3>Новые материалы</h3><span class="badge" id="editor-rule-count">${e.rules.length} / 64</span></div><p class="helper">Все правила применяются одновременно к исходному файлу.</p><div id="editor-rules"></div><button class="btn small" data-editor-add>${uiIcon('plus')} Добавить замену</button><div class="field editor-scope"><label for="editor-scope">Область замены</label><select id="editor-scope"><option value="">Вся схема</option>${e.original.regions.map(r => `<option value="${esc(r.name)}" ${r.name === e.region ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div><label class="check"><input id="editor-preserve" type="checkbox" ${e.preserve ? 'checked' : ''}>Сохранять совместимые свойства</label><p class="helper">Направление, ось, половина блока и другие допустимые для нового блока свойства. Данные блок-сущностей на заменённых позициях удаляются.</p><p class="helper">Каталог Java 26.1. Версия Minecraft в файле сохраняется; выбирайте блоки, доступные в вашей игре.</p><div class="editor-rule-actions"><button class="btn" data-editor-reset>Сбросить</button><button class="btn primary" data-editor-preview>${uiIcon('circle-check')} Проверить в 3D</button></div><div id="editor-change-summary" aria-live="polite"></div></section><section id="editor-panel-metadata" role="tabpanel" aria-labelledby="editor-tab-metadata" hidden><h3>О схеме</h3><div class="field"><label for="editor-name">Название</label><input id="editor-name" maxlength="160" value="${esc(e.metadata.Name || '')}"></div><div class="field"><label for="editor-author">Автор</label><input id="editor-author" maxlength="160" value="${esc(e.metadata.Author || '')}"></div><div class="field"><label for="editor-description">Описание</label><textarea id="editor-description" rows="3" maxlength="4000">${esc(e.metadata.Description || '')}</textarea></div><div id="editor-facts"></div><details class="editor-region-details"><summary>Регионы · ${e.original.regions.length}</summary>${e.original.regions.map(r => `<article><b>${esc(r.name)}</b><small>Размер ${r.size.map(Math.abs).join(' × ')} · ${fmt(r.blocks)} блоков</small><code>Позиция: ${r.position.join(', ')}</code><small>${r.entities} сущностей · ${r.tile_entities} блок-сущностей</small></article>`).join('')}</details></section><section id="editor-panel-palette" role="tabpanel" aria-labelledby="editor-tab-palette" hidden><h3>Блоки схемы</h3><label class="visually-hidden" for="editor-palette-search">Найти блок</label><input id="editor-palette-search" type="search" placeholder="Название или ID блока…"><button class="btn small editor-show-all" data-editor-isolate="">Показать все блоки</button><div id="editor-palette-list"></div></section></aside></div><div class="editor-exportbar"><div><b id="editor-ready-label">${e.dirty ? 'Есть непроверенные изменения' : 'Схема готова'}</b><small>Скачивается отдельный файл. ${state.id ? 'Список ресурсов сбора меняется через «Замены блоков».' : 'Загруженный файл не сохраняется на сервере.'}</small></div><button class="btn" data-editor-to-collection>${uiIcon('users')} В сбор ресурсов</button><button class="btn primary" data-editor-download>${uiIcon('download')} Скачать .litematic</button></div>`}</div>`;
  if (e.original) {
    renderEditorRules(); renderEditorFacts(); renderEditorPalette();
    fillEditorCatalog(); mountEditorScene();
  }
  const drop = $('#editor-drop');
  if (drop) {
    for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, ev => { ev.preventDefault(); drop.classList.add('drag'); });
    for (const type of ['drop', 'dragleave']) drop.addEventListener(type, ev => { ev.preventDefault(); drop.classList.remove('drag'); });
    drop.addEventListener('drop', ev => { if (ev.dataTransfer.files[0]) loadEditorFile(ev.dataTransfer.files[0]); });
  }
  setEditorBusy();
  if (e.pendingFile && !e.busy) {
    const file = e.pendingFile;
    e.pendingFile = null;
    const origin = e.pendingFileOrigin;
    e.pendingFileOrigin = null;
    loadEditorFile(file, true, origin);
  }
}
function editorBlockLabel(id) {
  return schematicEditor.catalog?.find(b => b.block_id === id)?.label || schematicEditor.original?.materials.find(b => b.id === id)?.label || id.replace('minecraft:','').replaceAll('_',' ');
}
function editorBlockIcon(id, size = 40) {
  if (['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(id)) return `<span class="block-air-icon" aria-hidden="true">${uiIcon('x')}</span>`;
  const e=schematicEditor,position=e.catalogById?.get(id)?.icon,atlas=e.iconAtlas;
  if(position && atlas?.tile) {
    const scale=size/atlas.tile;
    return `<span class="block-model-icon" aria-hidden="true" style="width:${size}px;height:${size}px;background-size:${atlas.width*scale}px ${atlas.height*scale}px;background-position:-${position[0]*scale}px -${position[1]*scale}px"></span>`;
  }
  const alias=id.replace('_wall_hanging_sign','_hanging_sign').replace('_wall_sign','_sign').replace('_wall_banner','_banner').replace('minecraft:potted_','minecraft:').replace('azalea_bush','azalea');
  return `<img src="${icon(alias)}" width="${size}" height="${size}" alt="" loading="lazy">`;
}
function renderEditorRules() {
  const e = schematicEditor, root = $('#editor-rules');
  if (!root) return;
  const count = $('#editor-rule-count'); if (count) count.textContent = e.rules.length + ' / 64';
  root.innerHTML = e.rules.map((r, i) => `<article class="editor-rule"><div class="editor-rule-number"><b>Замена ${i + 1}</b><button class="btn small icon-button" data-editor-remove="${i}" aria-label="Удалить замену ${i + 1}">${uiIcon('x')}</button></div><span class="editor-block-label">Исходный блок</span><button class="editor-block-choice" data-block-picker="source" data-picker-rule="${i}" aria-label="Выбрать исходный блок для замены ${i+1}">${editorBlockIcon(r.source)}<span><b>${esc(editorBlockLabel(r.source))}</b><small>${fmt(e.original.materials.find(m => m.id === r.source)?.count || 0)} в схеме</small></span>${uiIcon('chevron-right')}</button><div class="editor-rule-arrow">${uiIcon('arrow-right')}</div><span class="editor-block-label">Новый блок</span><button class="editor-block-choice ${r.target ? '' : 'empty-choice'}" data-block-picker="target" data-picker-rule="${i}" aria-label="Выбрать новый блок для замены ${i+1}">${r.target ? editorBlockIcon(r.target) : uiIcon('plus')}<span><b>${r.target ? esc(editorBlockLabel(r.target)) : 'Выбрать блок'}</b><small>${r.target ? 'Нажмите, чтобы изменить' : 'Каталог с иконками и поиском'}</small></span>${uiIcon('chevron-right')}</button><label>Количество<input data-editor-quantity="${i}" type="number" min="1" step="1" placeholder="Все блоки" value="${r.quantity ?? ''}"></label></article>`).join('') || '<div class="editor-no-rules">Добавьте замену или скачайте схему с новыми метаданными.</div>';
}
async function getEditorCatalog() {
  const e = schematicEditor;
  if (!e.catalog) {
    const data = await api('editor-catalog');
    e.catalog=data.blocks; e.iconAtlas=data.icons; e.catalogById=new Map(data.blocks.map(block=>[block.block_id,block]));
  }
  return e.catalog;
}
async function fillEditorCatalog() {
  try { await getEditorCatalog(); if ($('#editor-rules')) renderEditorRules(); }
  catch (err) { editorError(err.message); }
}
let blockPicker = null;
const pickerCategories = [
  ['all','layout-grid','Все блоки'],['scheme','file-box','В этой схеме'],['recent','history','Недавние'],['favorites','star','Избранное'],
  ['wood','layers','Древесина'],['stone','box','Камень и кирпичи'],['shapes','boxes','Ступени и плиты'],['glass','layers','Стекло'],
  ['colors','image','Цветные блоки'],['redstone','settings-2','Редстоун'],['functional','package','Механизмы и утилиты'],['nature','sun','Природа'],['other','box','Остальное'],
];
function blockPickerGroup(id) {
  const raw=id.replace('minecraft:','');
  if (/stairs|slab|_wall$|_fence$/.test(raw)) return 'shapes';
  if (/glass|pane/.test(raw)) return 'glass';
  if (/redstone|repeater|comparator|piston|observer|dispenser|dropper|hopper|rail|lever|button|pressure_plate|daylight|target|sculk_sensor|crafter|lightning_rod/.test(raw)) return 'redstone';
  if (/concrete|terracotta|wool|carpet|candle|stained|banner|bed$/.test(raw)) return 'colors';
  if (/chest|barrel|shulker|furnace|smoker|table|bookshelf|brewing|anvil|beacon|bell|campfire|lantern|sign|door|trapdoor|grindstone|composter|stonecutter|loom|cauldron/.test(raw)) return 'functional';
  if (/planks|log|wood|stem|hyphae|bamboo_block|bamboo_mosaic/.test(raw)) return 'wood';
  if (/stone|brick|tuff|quartz|granite|andesite|diorite|basalt|calcite|deepslate|prismarine|copper|iron_block|gold_block|netherite_block/.test(raw)) return 'stone';
  if (/grass|dirt|mud|sand|clay|ore|leaves|sapling|flower|tulip|rose|poppy|dandelion|mushroom|moss|vine|fern|water|lava|ice|snow|cactus|coral|kelp|dripleaf|sugar_cane|cocoa|crop|wheat|carrot|potato|melon|pumpkin/.test(raw)) return 'nature';
  return 'other';
}
async function openBlockPicker(index, kind, trigger) {
  try {
    const catalog=await getEditorCatalog(),e=schematicEditor,rule=e.rules[index];
    if (!rule) return;
    const source=kind==='source',counts=new Map(e.original.materials.map(m=>[m.id,m.count]));
    const entries=source ? e.original.materials.map(m=>({block_id:m.id,label:m.label,category:blockPickerGroup(m.id)})) : catalog;
    blockPicker={index,kind,trigger,query:'',category:'all',selected:source?rule.source:rule.target,limit:240,entries,counts,
      favorites:read('sklad:editor-block-favorites',[]),recent:read('sklad:editor-block-recent',[])};
    showDialog(source?'Исходный блок':'Новый блок',`<div class="block-browser-subtitle">Замена ${index+1} · ${source?'Блоки из загруженной схемы':'Выберите материал для постройки'}</div><div class="block-browser-search">${uiIcon('search')}<label class="visually-hidden" for="block-browser-query">Поиск блоков</label><input id="block-browser-query" type="search" placeholder="Найти блок по названию или ID…" autocomplete="off"><span id="block-browser-total"></span></div><div class="block-browser-body"><nav id="block-browser-categories" class="block-browser-categories" aria-label="Категории блоков"></nav><section class="block-browser-results"><div id="block-browser-results-label" class="block-browser-results-label"></div><div id="block-browser-grid" class="block-browser-grid" role="listbox" aria-label="Блоки Minecraft"></div><button class="btn block-browser-more" id="block-browser-more" data-picker-more>Показать ещё</button></section><aside id="block-browser-preview" class="block-browser-preview"></aside></div><div class="block-browser-footer"><span>Нажмите на блок, чтобы рассмотреть его. Двойной щелчок — выбрать.</span><div class="actions"><button class="btn" data-do="close">Отмена</button><button class="btn primary" id="block-browser-apply" data-picker-apply>Выбрать блок</button></div></div>`,true);
    dialog.classList.add('block-browser');
    dialog.addEventListener('close',()=>{dialog.classList.remove('block-browser');blockPicker=null;if(trigger?.isConnected)trigger.focus();},{once:true});
    renderBlockPickerCategories();renderBlockPickerResults();renderBlockPickerSelection();
    $('#block-browser-query').focus();
  } catch(err) { editorError(err.message); }
}
function pickerAvailable(block) {
  const p=blockPicker,r=schematicEditor.rules[p.index];
  if(p.kind==='target')return block.block_id!==r.source;
  return block.block_id!==r.target&&!schematicEditor.rules.some((rule,i)=>i!==p.index&&rule.source===block.block_id);
}
function pickerCategoryMatch(block, category) {
  const p=blockPicker,id=block.block_id;
  if(category==='all')return true;
  if(category==='scheme')return p.counts.has(id);
  if(category==='recent')return p.recent.includes(id);
  if(category==='favorites')return p.favorites.includes(id);
  return blockPickerGroup(id)===category;
}
function renderBlockPickerCategories() {
  const p=blockPicker;if(!p)return;
  $('#block-browser-categories').innerHTML=pickerCategories.filter(([id])=>p.kind!=='source'||!['recent','favorites','scheme'].includes(id)).map(([id,icon,label])=>{
    const count=p.entries.filter(b=>pickerCategoryMatch(b,id)).length;
    return `<button data-picker-category="${id}" aria-current="${p.category===id?'true':'false'}">${uiIcon(icon)}<span>${label}</span><small>${fmt(count)}</small></button>`;
  }).join('');
  $('#block-browser-total').textContent=fmt(p.entries.length)+' блоков';
}
function renderBlockPickerResults() {
  const p=blockPicker;if(!p)return;
  const normalize=text=>text.toLowerCase().replaceAll('ё','е');
  const q=normalize(p.query.trim()),items=p.entries.filter(b=>pickerCategoryMatch(b,p.category)&&(!q||normalize(b.label+' '+b.block_id).includes(q)));
  if(p.category==='recent')items.sort((a,b)=>p.recent.indexOf(a.block_id)-p.recent.indexOf(b.block_id));
  else items.sort((a,b)=>a.label.localeCompare(b.label,'ru'));
  $('#block-browser-results-label').textContent=(p.query?'Найдено: ':'')+fmt(items.length)+' блоков';
  $('#block-browser-grid').innerHTML=items.slice(0,p.limit).map(b=>{
    const available=pickerAvailable(b),selected=p.selected===b.block_id;
    return `<button class="block-browser-card ${selected?'selected':''}" role="option" aria-selected="${selected}" data-picker-id="${esc(b.block_id)}" ${available?'':'disabled'} title="${esc(b.label)} · ${esc(b.block_id)}">${editorBlockIcon(b.block_id,56)}<b>${esc(b.label)}</b><small>${available?(p.kind==='source'?fmt(p.counts.get(b.block_id))+' в схеме':''): 'Уже используется'}</small></button>`;
  }).join('')||'<div class="block-browser-empty">Ничего не найдено. Попробуйте другое название или категорию.</div>';
  $('#block-browser-more').hidden=items.length<=p.limit;
}
function renderBlockPickerSelection() {
  const p=blockPicker;if(!p)return;
  const selected=p.entries.find(b=>b.block_id===p.selected),available=selected&&pickerAvailable(selected);
  $('#block-browser-apply').disabled=!available;
  $('#block-browser-preview').innerHTML=selected?`<div class="block-browser-preview-image">${editorBlockIcon(selected.block_id,128)}</div><span class="eyebrow">Выбранный блок</span><h3>${esc(selected.label)}</h3><code>${esc(selected.block_id)}</code><dl><div><dt>Категория</dt><dd>${pickerCategories.find(c=>c[0]===blockPickerGroup(selected.block_id))?.[2]||'Блоки'}</dd></div>${p.counts.has(selected.block_id)?`<div><dt>В схеме</dt><dd>${fmt(p.counts.get(selected.block_id))} шт.</dd></div>`:''}</dl><button class="btn small" data-picker-favorite aria-pressed="${p.favorites.includes(selected.block_id)}">${uiIcon('star')} ${p.favorites.includes(selected.block_id)?'В избранном':'В избранное'}</button>`:'<div class="block-browser-empty">Нажмите на блок в каталоге, чтобы выбрать его.</div>';
}
function applyBlockPicker() {
  const p=blockPicker;if(!p)return;
  const selected=p.entries.find(b=>b.block_id===p.selected);
  if(!selected||!pickerAvailable(selected))return;
  const rule=schematicEditor.rules[p.index];if(!rule)return;
  rule[p.kind]=selected.block_id;
  if(p.kind==='source')rule.quantity=null;
  write('sklad:editor-block-recent',[selected.block_id,...p.recent.filter(id=>id!==selected.block_id)].slice(0,48));
  const index=p.index,kind=p.kind;
  closeDialog();editorDirty();renderEditorRules();
  document.querySelector(`[data-block-picker="${kind}"][data-picker-rule="${index}"]`)?.focus();
}
document.addEventListener('click',ev=>{
  const b=ev.target.closest('button');if(!b||b.disabled)return;
  if(b.dataset.blockPicker)return openBlockPicker(Number(b.dataset.pickerRule),b.dataset.blockPicker,b);
  const p=blockPicker;if(!p)return;
  if(b.dataset.pickerCategory){p.category=b.dataset.pickerCategory;p.limit=240;renderBlockPickerCategories();renderBlockPickerResults();}
  if(b.dataset.pickerId){p.selected=b.dataset.pickerId;document.querySelectorAll('[data-picker-id]').forEach(card=>{const selected=card.dataset.pickerId===p.selected;card.classList.toggle('selected',selected);card.setAttribute('aria-selected',String(selected));});renderBlockPickerSelection();}
  if(b.hasAttribute('data-picker-more')){p.limit+=240;renderBlockPickerResults();}
  if(b.hasAttribute('data-picker-apply'))applyBlockPicker();
  if(b.hasAttribute('data-picker-favorite')){p.favorites=p.favorites.includes(p.selected)?p.favorites.filter(id=>id!==p.selected):[p.selected,...p.favorites];write('sklad:editor-block-favorites',p.favorites);renderBlockPickerCategories();renderBlockPickerSelection();if(p.category==='favorites')renderBlockPickerResults();}
});
document.addEventListener('dblclick',ev=>{if(ev.target.closest('[data-picker-id]')&&!ev.target.closest('[data-picker-id]').disabled)applyBlockPicker();});
document.addEventListener('input',ev=>{if(ev.target.id==='block-browser-query'&&blockPicker){blockPicker.query=ev.target.value;blockPicker.limit=240;renderBlockPickerResults();}});
document.addEventListener('keydown',ev=>{
  if(!blockPicker)return;
  if(ev.target.id==='block-browser-query'&&ev.key==='ArrowDown'){$('#block-browser-grid button:not(:disabled)')?.focus();ev.preventDefault();}
  const card=ev.target.closest('[data-picker-id]');if(!card)return;
  if(ev.key==='Enter'){blockPicker.selected=card.dataset.pickerId;applyBlockPicker();ev.preventDefault();return;}
  const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];if(!keys.includes(ev.key))return;
  const cards=[...document.querySelectorAll('#block-browser-grid button:not(:disabled)')],i=cards.indexOf(card),columns=getComputedStyle($('#block-browser-grid')).gridTemplateColumns.split(' ').length;
  const next=ev.key==='Home'?0:ev.key==='End'?cards.length-1:i+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[ev.key]);
  cards[Math.max(0,Math.min(cards.length-1,next))]?.focus();ev.preventDefault();
});
function renderEditorFacts() {
  const e = schematicEditor, d = e.before ? e.original : e.preview;
  const root = $('#editor-facts');
  if (!root || !d) return;
  const date = value => value ? new Date(value).toLocaleString('ru-RU') : 'Не указано';
  const version = d.minecraft_version;
  root.innerHTML = `<dl class="editor-facts">${[['Размер', d.bounds.max.map((v, i) => v - d.bounds.min[i]).join(' × ')], ['Блоков без воздуха', fmt(d.blocks)], ['Объём', fmt(d.volume) + ' ячеек'], ['Регионов', d.regions.length], ['Состояний в палитре', d.palette.length], ['Формат Litematica', d.format_version], ['Minecraft', (version ? 'Java ' + version + ' · ' : '') + 'DataVersion ' + d.data_version], ['Создано', date(d.created)], ['Изменено', date(d.modified)]].map(([k,v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}
function renderEditorPalette() {
  const e = schematicEditor, d = e.before ? e.original : e.preview;
  const root = $('#editor-palette-list');
  if (!root || !d) return;
  const q = ($('#editor-palette-search')?.value || '').trim().toLowerCase();
  root.innerHTML = d.materials.filter(m => !q || (m.id + m.label).toLowerCase().includes(q)).map(m => `<button class="editor-palette-item ${e.material === m.id ? 'selected' : ''}" data-editor-isolate="${esc(m.id)}">${editorBlockIcon(m.id,28)}<span><b>${esc(m.label)}</b><small>${esc(m.id)}</small></span><strong>${fmt(m.count)}</strong></button>`).join('') || '<p class="helper">Ничего не найдено</p>';
}
async function mountEditorScene() {
  disposeEditor();
  const e = schematicEditor, container = $('#editor-canvas');
  if (!container) return;
  const d = e.before ? e.original : e.preview;
  if (!d) return;
  const current = ++mountEditorScene.version;
  try {
    const { mountSchematic } = await import('./schematic3d.js?v=8');
    if (current !== mountEditorScene.version || !container.isConnected) return;
    container.innerHTML = '';
    const mountedScene = await mountSchematic(container, d, {
      pose: e.cameraPose,
      onCount(n) { const node = $('#editor-render-count'); if (node) node.textContent = fmt(n) + ' блоков в 3D'; },
      onPick(block) {
        const node = $('#editor-picked'); if (!node) return;
        node.innerHTML = block ? `<b>${esc(block.label)}</b> <code>${esc(block.id)}</code><span>XYZ ${block.position.join(' · ')} · ${esc(block.region)}</span><small>${Object.entries(block.properties).map(([k,v]) => `${esc(k)}=${esc(v)}`).join(' · ') || 'Без дополнительных свойств'}</small>` : 'Нажмите на блок, чтобы посмотреть его свойства и координаты.';
      },
    });
    if (current !== mountEditorScene.version || !container.isConnected) { mountedScene.dispose(); return; }
    e.scene = mountedScene;
    e.scene.update({region: e.filterRegion, layer: e.layer, material: e.material});
    e.scene.boxes(!!e.showBoxes);
    const note = $('#editor-model-note');
    if (note) note.textContent = (d.sampled ? `Показана выборка ${fmt(d.voxels.length)} из ${fmt(d.surface_blocks)} внешних блоков. ` : d.surface_only ? 'Для этой схемы показаны внешние блоки. Внутренние слои скрыты. ' : '') + `Модели и текстуры Minecraft Java ${e.scene.modelInfo.version}.` + (e.scene.modelInfo.missing.length ? ` Нет моделей для ${e.scene.modelInfo.missing.length} типов: ${e.scene.modelInfo.missing.slice(0,5).join(', ')}. Экспорт содержит все блоки.` : '');
  } catch (err) {
    if (container.isConnected) container.innerHTML = '<div class="empty"><h3>Не удалось открыть 3D</h3><p>Проверьте подключение и поддержку WebGL. Замены, метаданные и скачивание доступны.</p></div>';
  }
}
mountEditorScene.version = 0;
function editorError(message = '') { const node = $('#editor-error'); if (node) node.textContent = message; }
function setEditorBusy(message = '') {
  const e = schematicEditor;
  document.querySelectorAll('.editor-workspace button, .editor-workspace input, .editor-workspace select, .editor-workspace textarea').forEach(el => el.disabled = e.busy);
  const node = $('#editor-status'); if (node) node.textContent = message;
  const ready = $('#editor-ready-label'); if (ready) ready.textContent = e.dirty ? 'Есть непроверенные изменения' : 'Схема готова';
}
function editorOptions() {
  const e = schematicEditor;
  return {rules: e.rules, region: e.region, preserve_properties: e.preserve, metadata: e.metadata};
}
async function editorRequest(action, file, options) {
  const form = new FormData(); form.append('file', file); form.append('options', JSON.stringify(options));
  const res = await fetch('./api/schematic-' + action, {method: 'POST', body: form});
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Не удалось обработать схему. Попробуйте ещё раз.');
  }
  return action === 'export' ? res.blob() : res.json();
}
async function loadEditorFile(file, preservePending = true, origin = null) {
  const e = schematicEditor;
  if (e.busy) return;
  editorError();
  if (!file.name.toLowerCase().endsWith('.litematic') || file.size > 40 * 1024 * 1024) return editorError('Выберите .litematic размером до 40 МБ');
  e.busy = true; setEditorBusy('Читаем блоки, регионы и метаданные…');
  const request = ++e.request;
  try {
    const d = await editorRequest('preview', file, {});
    if (request !== e.request) return;
    Object.assign(e, {file, fileOrigin: origin || transferFileId(file), original: d, preview: d, metadata: {...d.metadata}, rules: [], region: '', before: false, dirty: false, filterRegion: -1, layer: Infinity, material: ''});
    if (preservePending) importCollectionRules();
    e.busy = false;
    disposeEditor(); e.cameraPose = null; e.showBoxes = false;
    if ($('#editor-root') || state.tab === 'editor') renderEditor();
  } catch (err) { editorError(err.message); }
  finally { e.busy = false; setEditorBusy(); }
}
async function checkEditor() {
  const e = schematicEditor;
  if (e.busy || !e.file) return;
  e.busy = true; editorError(); setEditorBusy('Применяем правила и обновляем 3D…');
  try {
    const d = await editorRequest('preview', e.file, editorOptions());
    e.preview = d; e.before = false; e.dirty = false;
    const summary = $('#editor-change-summary');
    if (summary) summary.innerHTML = d.changes.length ? `<div class="notice editor-checked">${uiIcon('circle-check')} Заменено ${fmt(d.changes.reduce((n, r) => n + r.changed, 0))} блоков. Можно скачать файл.</div>` : '<p class="helper">Метаданные проверены. Можно скачать файл.</p>';
    document.querySelectorAll('[data-editor-compare]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.editorCompare === 'after')));
    renderEditorFacts(); renderEditorPalette(); await mountEditorScene();
  } catch (err) { editorError(err.message); }
  finally { e.busy = false; setEditorBusy(); }
}
async function downloadEditor() {
  const e = schematicEditor;
  if (e.busy || !e.file) return;
  e.busy = true; editorError(); setEditorBusy('Собираем изменённый .litematic…');
  try {
    const blob = await editorRequest('export', e.file, editorOptions());
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = e.file.name.replace(/\.litematic$/i, '') + '-edited.litematic';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Изменённая схема скачана');
  } catch (err) { editorError(err.message); }
  finally { e.busy = false; setEditorBusy(); }
}
function editorDirty() {
  schematicEditor.dirty = true;
  const node = $('#editor-ready-label'); if (node) node.textContent = 'Есть непроверенные изменения';
  const summary = $('#editor-change-summary'); if (summary) summary.innerHTML = '';
}
document.addEventListener('change', ev => {
  const el = ev.target, e = schematicEditor;
  if (el.id === 'editor-file' && el.files[0]) return loadEditorFile(el.files[0]);
  if (el.dataset.editorSource !== undefined) { e.rules[Number(el.dataset.editorSource)].source = el.value; editorDirty(); }
  if (el.id === 'editor-scope') { e.region = el.value; editorDirty(); }
  if (el.id === 'editor-preserve') { e.preserve = el.checked; editorDirty(); }
  if (el.id === 'editor-view-region') { e.filterRegion = Number(el.value); e.scene?.update({region: e.filterRegion}); }
  if (el.id === 'editor-region-boxes') { e.showBoxes = el.checked; e.scene?.boxes(el.checked); }
});
document.addEventListener('input', ev => {
  const el = ev.target, e = schematicEditor;
  const metadataFields = {'editor-name': 'Name', 'editor-author': 'Author', 'editor-description': 'Description'};
  if (metadataFields[el.id]) { e.metadata[metadataFields[el.id]] = el.value; editorDirty(); }
  if (el.dataset.editorTarget !== undefined) { e.rules[Number(el.dataset.editorTarget)].target = el.value.trim(); editorDirty(); }
  if (el.dataset.editorQuantity !== undefined) { e.rules[Number(el.dataset.editorQuantity)].quantity = el.value === '' ? null : Number(el.value); editorDirty(); }
  if (el.id === 'editor-layer') {
    const top = e.original.bounds.max[1] - 1;
    e.layer = Number(el.value) >= top ? Infinity : Number(el.value);
    $('#editor-layer-value').textContent = e.layer === Infinity ? 'Все' : el.value;
    e.scene?.update({layer: e.layer});
  }
  if (el.id === 'editor-palette-search') renderEditorPalette();
});
document.addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b || b.disabled) return;
  const e = schematicEditor;
  if (b.dataset.do === 'schematic-editor') return openSchematicEditor();
  if (b.hasAttribute('data-editor-from-replacements')) return openSchematicEditor(replacementDraft?.plan?.rules || null);
  if (b.hasAttribute('data-editor-download')) return downloadEditor();
  if (b.hasAttribute('data-editor-preview')) return checkEditor();
  if (b.hasAttribute('data-editor-add')) {
    if (e.rules.length >= 64) return editorError('Допускается до 64 замен');
    const source = e.original.materials.find(m => !e.rules.some(r => r.source === m.id));
    if (!source) return editorError('Все исходные блоки уже добавлены');
    e.rules.push({source: source.id, target: '', quantity: null});
    editorDirty(); renderEditorRules();
  }
  if (b.dataset.editorRemove !== undefined) { e.rules.splice(Number(b.dataset.editorRemove), 1); editorDirty(); renderEditorRules(); }
  if (b.hasAttribute('data-editor-reset')) {
    Object.assign(e, {rules: [], preview: e.original, metadata: {...e.original.metadata}, region: '', preserve: true, dirty: false, before: false, filterRegion: -1, layer: Infinity, material: ''});
    renderEditor();
  }
  if (b.dataset.editorCompare) {
    e.before = b.dataset.editorCompare === 'before';
    document.querySelectorAll('[data-editor-compare]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderEditorFacts(); renderEditorPalette(); await mountEditorScene();
  }
  if (b.dataset.editorView) e.scene?.view(b.dataset.editorView);
  if (b.hasAttribute('data-editor-fullscreen')) {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('.editor-visual').requestFullscreen(); } catch { editorError('Полноэкранный режим недоступен в этом браузере'); }
  }
  if (b.dataset.editorIsolate !== undefined) { e.material = b.dataset.editorIsolate; e.scene?.update({material: e.material}); renderEditorPalette(); }
  if (b.dataset.editorPanel) {
    document.querySelectorAll('[data-editor-panel]').forEach(x => { x.setAttribute('aria-selected', String(x === b)); x.tabIndex = x === b ? 0 : -1; });
    for (const id of ['replace','metadata','palette']) $('#editor-panel-' + id).hidden = id !== b.dataset.editorPanel;
  }
});
document.addEventListener('keydown', ev => {
  const tab = ev.target.closest('[data-editor-panel]');
  if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)) return;
  const tabs = [...document.querySelectorAll('[data-editor-panel]')];
  const i = tabs.indexOf(tab), next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
  ev.preventDefault(); tabs[next].click(); tabs[next].focus();
});
