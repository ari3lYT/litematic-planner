#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import traceback
from collections import Counter
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.parse import quote

import nbtlib
import schematic_editor


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("LITEMATIC_DB", BASE_DIR / "planner.sqlite3"))
INDEX_PATH = BASE_DIR / "static" / "index.html"
TEXTURES_PATH = BASE_DIR / "static" / "textures"
RENDERS_PATH = BASE_DIR / "static" / "renders"
LANG_PATH = BASE_DIR / "data" / "ru_ru_blocks.json"
MAX_UPLOAD = 40 * 1024 * 1024
DB_LOCK = threading.RLock()
EDITOR_SLOTS = threading.BoundedSemaphore(2)
RU_BLOCKS = json.loads(LANG_PATH.read_text("utf-8")) if LANG_PATH.exists() else {}

RU_NAMES = {
    "stone": "Камень", "cobblestone": "Булыжник", "dirt": "Земля",
    "glass": "Стекло", "sand": "Песок", "gravel": "Гравий",
    "oak_planks": "Дубовые доски", "spruce_planks": "Еловые доски",
    "birch_planks": "Берёзовые доски", "stone_bricks": "Каменные кирпичи",
    "deepslate_bricks": "Глубинносланцевые кирпичи", "smooth_stone": "Гладкий камень",
    "redstone": "Редстоун", "redstone_wire": "Редстоун", "redstone_torch": "Редстоуновый факел",
    "repeater": "Повторитель", "comparator": "Компаратор", "observer": "Наблюдатель",
    "piston": "Поршень", "sticky_piston": "Липкий поршень", "hopper": "Воронка",
    "chest": "Сундук", "barrel": "Бочка", "rail": "Рельсы",
    "powered_rail": "Энергорельсы", "sea_lantern": "Морской фонарь",
    "shroomlight": "Грибосвет", "torch": "Факел", "scaffolding": "Строительные леса",
    "white_concrete": "Белый бетон", "light_blue_concrete": "Голубой бетон",
    "pink_concrete": "Розовый бетон", "white_stained_glass": "Белое стекло",
    "light_blue_stained_glass": "Голубое стекло", "pink_stained_glass": "Розовое стекло",
    "water": "Вода", "lava": "Лава", "slime_block": "Блок слизи",
    "honey_block": "Блок мёда", "iron_block": "Железный блок",
}


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with DB_LOCK, db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL,
          total_blocks INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS materials (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          block_id TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL, required INTEGER NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0, placed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          nickname TEXT NOT NULL, token_hash TEXT NOT NULL, joined_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          quantity INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          participant_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_materials_project ON materials(project_id);
        CREATE INDEX IF NOT EXISTS idx_reservations_project ON reservations(project_id);
        CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, id DESC);
        CREATE TABLE IF NOT EXISTS resource_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL,
          created_at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_changes_project ON resource_changes(project_id,id DESC);
        CREATE TABLE IF NOT EXISTS warehouse_state (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS warehouse_chests (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
          rotation INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'single',
          label_mode TEXT NOT NULL DEFAULT 'frame', label_material TEXT NOT NULL DEFAULT '',
          sign_text TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_chests_project ON warehouse_chests(project_id,deleted);
        CREATE TABLE IF NOT EXISTS warehouse_slots (
          chest_id TEXT NOT NULL REFERENCES warehouse_chests(id) ON DELETE CASCADE,
          slot INTEGER NOT NULL, material_id INTEGER NOT NULL REFERENCES materials(id),
          quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(chest_id,slot)
        );
        """)

        columns = {row[1] for row in conn.execute("PRAGMA table_info(projects)")}
        if "key_hash" not in columns:
            conn.execute("ALTER TABLE projects ADD COLUMN key_hash TEXT NOT NULL DEFAULT ''")
        if "notes" not in columns:
            conn.execute("ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT ''")


def require_access(conn, project_id, key):
    row = conn.execute("SELECT key_hash FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row or not row[0] or not secrets.compare_digest(row[0], token_hash(key)):
        raise PermissionError("Сбор недоступен. Откройте полную секретную ссылку.")


def clean_name(block_id: str) -> str:
    raw = block_id.split(":", 1)[-1]
    return RU_BLOCKS.get(
        f"block.minecraft.{raw}",
        RU_BLOCKS.get(f"item.minecraft.{raw}", RU_NAMES.get(raw, raw.replace("_", " ").capitalize())),
    )


NON_MATERIALS = {
    "minecraft:piston_head", "minecraft:moving_piston", "minecraft:water", "minecraft:lava",
    "minecraft:bubble_column", "minecraft:fire", "minecraft:soul_fire", "minecraft:nether_portal",
    "minecraft:end_portal", "minecraft:end_gateway", "minecraft:structure_void", "minecraft:light",
}
MATERIAL_ALIASES = {
    "minecraft:redstone_wire": "minecraft:redstone",
    "minecraft:tripwire": "minecraft:string",
    "minecraft:wall_torch": "minecraft:torch",
    "minecraft:soul_wall_torch": "minecraft:soul_torch",
    "minecraft:redstone_wall_torch": "minecraft:redstone_torch",
}


def material_id_for(block_id: str) -> str | None:
    if block_id in NON_MATERIALS:
        return None
    if block_id in MATERIAL_ALIASES:
        return MATERIAL_ALIASES[block_id]
    namespace, raw = block_id.split(":", 1)
    if raw.endswith("_wall_hanging_sign"):
        raw = raw.replace("_wall_hanging_sign", "_hanging_sign")
    elif raw.endswith("_wall_sign"):
        raw = raw.replace("_wall_sign", "_sign")
    elif raw.endswith("_wall_banner"):
        raw = raw.replace("_wall_banner", "_banner")
    return f"{namespace}:{raw}"


ICON_ALIASES = {
    "observer": "observer_front", "piston": "piston_side", "sticky_piston": "piston_top_sticky",
    "hopper": "hopper_outside", "dispenser": "dispenser_front", "dropper": "dropper_front",
    "furnace": "furnace_front", "blast_furnace": "blast_furnace_front", "smoker": "smoker_front",
    "crafter": "crafter_front", "command_block": "command_block_front", "target": "target_top",
}


def icon_path(raw: str) -> Path:
    if not re.fullmatch(r"[a-z0-9_]+", raw):
        return RENDERS_PATH / "BARRIER.png"
    rendered = RENDERS_PATH / f"{raw.upper()}.png"
    if rendered.is_file():
        return rendered
    item = TEXTURES_PATH / "item" / f"{raw}.png"
    if item.is_file():
        return item
    candidates = [raw, ICON_ALIASES.get(raw, "")]
    for suffix in ("_stairs", "_slab", "_wall"):
        if raw.endswith(suffix):
            base = raw.removesuffix(suffix)
            candidates.extend([base, f"{base}s"])
    if raw.endswith("_door"):
        candidates.append(f"{raw}_bottom")
    if raw.endswith("_trapdoor"):
        candidates.append(raw)
    if raw.endswith("_pane"):
        candidates.append(raw.removesuffix("_pane"))
    for candidate in candidates:
        if candidate:
            path = TEXTURES_PATH / "block" / f"{candidate}.png"
            if path.is_file():
                return path
    fallback = RENDERS_PATH / "BARRIER.png"
    return fallback if fallback.is_file() else TEXTURES_PATH / "item" / "barrier.png"


COLOR_WORDS = (
    "white_", "light_gray_", "gray_", "black_", "brown_", "red_", "orange_", "yellow_",
    "lime_", "green_", "cyan_", "light_blue_", "blue_", "purple_", "magenta_", "pink_",
)
COLOR_MATERIALS = ("wool", "carpet", "concrete", "terracotta", "stained_glass", "candle", "banner", "bed", "shulker_box")
REDSTONE_WORDS = (
    "redstone", "piston", "observer", "repeater", "comparator", "dispenser", "dropper", "hopper",
    "target", "lever", "button", "pressure_plate", "tripwire", "daylight_detector", "lightning_rod",
    "rail", "sculk_sensor", "calibrated_sculk_sensor", "crafter", "tnt", "note_block", "slime_block", "honey_block",
)
FUNCTIONAL_WORDS = (
    "chest", "barrel", "furnace", "smoker", "blast_furnace", "crafting_table", "stonecutter",
    "grindstone", "loom", "cartography_table", "smithing_table", "fletching_table", "enchanting_table",
    "anvil", "bookshelf", "lectern", "beacon", "bell", "ladder", "scaffolding", "torch", "lantern",
    "campfire", "cauldron", "composter", "jukebox", "respawn_anchor", "lodestone", "end_portal",
    "door", "trapdoor", "fence_gate", "sign", "hanging_sign", "chain", "iron_bars", "flower_pot",
)
NATURAL_WORDS = (
    "stone", "deepslate", "granite", "diorite", "andesite", "tuff", "calcite", "dripstone", "ore",
    "dirt", "grass", "podzol", "mycelium", "mud", "sand", "gravel", "clay", "snow", "ice",
    "water", "lava", "log", "wood", "stem", "hyphae", "leaves", "sapling", "mushroom", "flower",
    "bamboo", "cactus", "vine", "moss", "azalea", "coral", "kelp", "seagrass", "lily", "cocoa",
    "netherrack", "soul_sand", "soul_soil", "basalt", "blackstone", "end_stone", "obsidian",
    "amethyst", "sculk", "bone_block", "sponge", "pumpkin", "melon", "hay_block",
)


FLOWER_BLOCKS = {
    "blue_orchid", "allium", "azure_bluet", "dandelion", "poppy", "cornflower",
    "oxeye_daisy", "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony",
    "pink_tulip", "red_tulip", "orange_tulip", "white_tulip", "wither_rose",
    "open_eyeblossom", "closed_eyeblossom", "pink_petals", "wildflowers",
}


def category_for(block_id: str) -> str:
    raw = block_id.split(":", 1)[-1]
    if raw in FLOWER_BLOCKS:
        return "Природные блоки"
    if raw in {"glass", "tinted_glass", "terracotta"} or (
        any(raw.startswith(color) for color in COLOR_WORDS) and any(kind in raw for kind in COLOR_MATERIALS)
    ):
        return "Цветные блоки"
    if any(word in raw for word in REDSTONE_WORDS):
        return "Редстоун"
    if any(word in raw for word in FUNCTIONAL_WORDS):
        return "Функциональные блоки"
    if any(word in raw for word in NATURAL_WORDS):
        return "Природные блоки"
    return "Строительные блоки"


def parse_litematic(path: Path) -> Counter[str]:
    schematic = nbtlib.load(path)
    regions = schematic.get("Regions")
    if not regions:
        raise ValueError("В файле нет регионов Litematica")
    counts: Counter[str] = Counter()
    air = {"minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:structure_void"}
    for region in regions.values():
        palette = [str(state["Name"]) for state in region["BlockStatePalette"]]
        if not palette:
            continue
        size = region["Size"]
        volume = abs(int(size["x"])) * abs(int(size["y"])) * abs(int(size["z"]))
        bits = max(2, math.ceil(math.log2(len(palette))))
        mask = (1 << bits) - 1
        words = [int(value) & ((1 << 64) - 1) for value in region["BlockStates"]]
        for index in range(volume):
            bit = index * bits
            word_index, offset = divmod(bit, 64)
            if word_index >= len(words):
                raise ValueError("Повреждённый массив BlockStates")
            palette_index = (words[word_index] >> offset) & mask
            if offset + bits > 64:
                if word_index + 1 >= len(words):
                    raise ValueError("Повреждённый массив BlockStates")
                palette_index |= (words[word_index + 1] << (64 - offset)) & mask
            if palette_index >= len(palette):
                raise ValueError("Некорректный индекс палитры")
            block_id = palette[palette_index]
            if block_id not in air:
                material_id = material_id_for(block_id)
                if material_id:
                    counts[material_id] += 1
    if not counts:
        raise ValueError("В схеме не найдено блоков")
    return counts


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def actor(conn: sqlite3.Connection, project_id: str, participant_id: str, token: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM participants WHERE id=? AND project_id=? AND token_hash=?",
        (participant_id, project_id, token_hash(token)),
    ).fetchone()
    if not row:
        raise PermissionError("Сессия участника не найдена. Войдите снова.")
    return row


def add_activity(conn: sqlite3.Connection, project_id: str, participant_id: str | None, text: str) -> None:
    conn.execute(
        "INSERT INTO activity(project_id, participant_id, text, created_at) VALUES(?,?,?,?)",
        (project_id, participant_id, text, int(time.time())),
    )


CHEST_FIELDS = ('id','name','x','y','z','rotation','kind','label_mode','label_material','sign_text')


def stack_limit(block_id):
    raw = block_id.split(':')[-1]
    if raw.endswith('shulker_box') or raw.endswith('_bed'):
        return 1
    return 16 if 'banner' in raw or raw.endswith('sign') else 64


def integer(value, low, high, label):
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ValueError(f'{label}: нужно целое число от {low} до {high}')
    return value


def warehouse_snapshot(conn, project_id):
    chests = [dict(r) for r in conn.execute('SELECT '+','.join(CHEST_FIELDS)+' FROM warehouse_chests WHERE project_id=? AND deleted=0 ORDER BY id', (project_id,))]
    slots = [dict(r) for r in conn.execute('SELECT s.chest_id,s.slot,s.material_id,s.quantity FROM warehouse_slots s JOIN warehouse_chests c ON c.id=s.chest_id WHERE c.project_id=? AND c.deleted=0 ORDER BY s.chest_id,s.slot', (project_id,))]
    return {'chests': chests, 'slots': slots}


def warehouse_data(conn, project_id):
    snapshot = warehouse_snapshot(conn, project_id)
    revision = conn.execute('SELECT revision FROM warehouse_state WHERE project_id=?', (project_id,)).fetchone()
    allocated = Counter()
    for slot in snapshot['slots']:
        allocated[slot['material_id']] += slot['quantity']
    for chest in snapshot['chests']:
        chest['slots'] = [s for s in snapshot['slots'] if s['chest_id'] == chest['id']]
        chest['capacity'] = 54 if chest['kind'] == 'double' else 27
    return {'revision': revision[0] if revision else 0, 'chests': snapshot['chests'],
            'allocated': dict(allocated), 'bounds': 16, 'max_chests': 128}


def warehouse_bump(conn, project_id):
    conn.execute('INSERT OR IGNORE INTO warehouse_state(project_id,revision) VALUES(?,0)', (project_id,))
    conn.execute('UPDATE warehouse_state SET revision=revision+1 WHERE project_id=?', (project_id,))


def require_warehouse_revision(conn, project_id, revision):
    integer(revision, 0, 2**53-1, 'Версия склада')
    row = conn.execute('SELECT revision FROM warehouse_state WHERE project_id=?', (project_id,)).fetchone()
    if revision != (row[0] if row else 0):
        raise ValueError('Склад уже изменён командой. Обновите состояние и повторите действие.')


def chest_cells(chest):
    x,y,z,rotation=chest['x'],chest['y'],chest['z'],chest['rotation']
    result=[(x,y,z)]
    if chest['kind']=='double':
        result.append((x+(rotation%2==0),y,z+(rotation%2==1)))
    return result


def check_chest_layout(chests):
    occupied={}
    for chest in chests:
        integer(chest['x'],-16,15,'Координата X')
        integer(chest['z'],-16,15,'Координата Z')
        integer(chest['y'],0,3,'Высота')
        integer(chest['rotation'],0,3,'Поворот')
        if chest['kind'] not in ('single','double'):
            raise ValueError('Выберите обычный или двойной сундук')
        for cell in chest_cells(chest):
            if not -16<=cell[0]<=15 or not -16<=cell[2]<=15:
                raise ValueError('Сундук выходит за границы площадки')
            if cell in occupied:
                raise ValueError('Это место уже занято сундуком')
            occupied[cell]=chest['id']
    for x,y,z in occupied:
        if y>0 and (x,y-1,z) not in occupied:
            raise ValueError('Сверху нужна опора. Сначала поставьте сундук ниже или переместите верхние сундуки.')


def require_chest(conn, project_id, chest_id):
    row=conn.execute('SELECT * FROM warehouse_chests WHERE id=? AND project_id=? AND deleted=0',(chest_id,project_id)).fetchone()
    if not row:
        raise ValueError('Сундук недоступен')
    return dict(row)


def chest_capacity(conn, chest, material, slot=None):
    limit=stack_limit(material['block_id'])
    count=54 if chest['kind']=='double' else 27
    slots={r['slot']:dict(r) for r in conn.execute('SELECT * FROM warehouse_slots WHERE chest_id=?',(chest['id'],))}
    if slot is not None:
        integer(slot,0,count-1,'Слот')
        item=slots.get(slot)
        return (limit-item['quantity']) if item and item['material_id']==material['id'] else (limit if not item else 0)
    return sum(limit-slots[i]['quantity'] if i in slots and slots[i]['material_id']==material['id'] else limit if i not in slots else 0 for i in range(count))


def put_in_chest(conn, chest, material, quantity, slot=None):
    if chest_capacity(conn,chest,material,slot)<quantity:
        raise ValueError('В сундуке или выбранном слоте недостаточно места')
    limit=stack_limit(material['block_id']); count=54 if chest['kind']=='double' else 27
    slots={r['slot']:dict(r) for r in conn.execute('SELECT * FROM warehouse_slots WHERE chest_id=?',(chest['id'],))}
    order=[slot] if slot is not None else sorted(range(count),key=lambda i:0 if i in slots and slots[i]['material_id']==material['id'] else 1)
    left=quantity
    for i in order:
        item=slots.get(i)
        if item and item['material_id']!=material['id']:continue
        existing=item['quantity'] if item else 0
        amount=min(left,limit-existing)
        if amount:
            conn.execute('INSERT INTO warehouse_slots(chest_id,slot,material_id,quantity) VALUES(?,?,?,?) ON CONFLICT(chest_id,slot) DO UPDATE SET quantity=excluded.quantity',(chest['id'],i,material['id'],existing+amount))
            left-=amount
        if not left:break


def restore_warehouse(conn, project_id, snapshot):
    before = snapshot.get('warehouse', {'chests': [], 'slots': []})
    conn.execute('DELETE FROM warehouse_slots WHERE chest_id IN (SELECT id FROM warehouse_chests WHERE project_id=?)',(project_id,))
    conn.execute('UPDATE warehouse_chests SET deleted=1 WHERE project_id=?',(project_id,))
    for chest in before['chests']:
        fields=CHEST_FIELDS+('project_id','deleted')
        values=[chest[f] for f in CHEST_FIELDS]+[project_id,0]
        assignments=','.join(f'{f}=excluded.{f}' for f in fields if f!='id')
        conn.execute('INSERT INTO warehouse_chests('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+') ON CONFLICT(id) DO UPDATE SET '+assignments,values)
    for slot in before['slots']:
        conn.execute('INSERT INTO warehouse_slots(chest_id,slot,material_id,quantity) VALUES(?,?,?,?)',(slot['chest_id'],slot['slot'],slot['material_id'],slot['quantity']))
    warehouse_bump(conn,project_id)


def inventory_snapshot(conn, project_id):
    materials = [dict(r) for r in conn.execute("""
        SELECT id,block_id,label,category,required,delivered,placed FROM materials
        WHERE project_id=? AND (required>0 OR delivered>0)
        ORDER BY id
    """, (project_id,))]
    reservations = [dict(r) for r in conn.execute("""
        SELECT id,material_id,participant_id,quantity,delivered,status FROM reservations
        WHERE project_id=? AND (status='active' OR delivered>0) ORDER BY id
    """, (project_id,))]
    result = {"materials": materials, "reservations": reservations}
    warehouse = warehouse_snapshot(conn, project_id)
    if warehouse['chests']:
        result['warehouse'] = warehouse
    return result


def inventory_revision(snapshot):
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def record_change(conn, project_id, kind, label, before):
    payload = {"before": before, "after_revision": inventory_revision(inventory_snapshot(conn, project_id))}
    return conn.execute(
        "INSERT INTO resource_changes(project_id,kind,label,payload,created_at) VALUES(?,?,?,?,?)",
        (project_id, kind, label, json.dumps(payload, ensure_ascii=False), int(time.time())),
    ).lastrowid


def block_catalog():
    result = {}
    for key in RU_BLOCKS:
        if key.startswith('block.minecraft.'):
            raw = key.removeprefix('block.minecraft.')
            if not re.fullmatch(r'[a-z0-9_]+', raw):
                continue
            block_id = material_id_for('minecraft:' + raw)
            if not block_id or block_id in {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}:
                continue
            result[block_id] = {'block_id': block_id, 'label': clean_name(block_id), 'category': category_for(block_id)}
    return result


BLOCK_CATALOG = block_catalog()


def replacement_plan(conn, project_id, rules):
    if not isinstance(rules, list) or not 1 <= len(rules) <= 64:
        raise ValueError('Добавьте от 1 до 64 замен')
    snapshot = inventory_snapshot(conn, project_id)
    current = {m['block_id']: dict(m) for m in snapshot['materials']}
    by_id = {m['id']: m for m in snapshot['materials']}
    deltas, outgoing, incoming, normalized = Counter(), Counter(), Counter(), []
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError('Некорректная замена')
        source = by_id.get(int(rule.get('source_id', 0)))
        target = str(rule.get('target_block_id', ''))
        quantity = rule.get('quantity')
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise ValueError('Количество замены должно быть целым числом больше нуля')
        if not source or target not in BLOCK_CATALOG or source['block_id'] == target:
            raise ValueError('Выберите разные материалы из каталога')
        outgoing[source['block_id']] += quantity
        if outgoing[source['block_id']] > source['required']:
            raise ValueError(f"Можно заменить не больше {source['required']} × {source['label']}")
        deltas[source['block_id']] -= quantity
        deltas[target] += quantity
        incoming[target] += quantity
        normalized.append({'source_id': source['id'], 'source_block_id': source['block_id'], 'source_label': source['label'],
                           'target_block_id': target, 'target_label': BLOCK_CATALOG[target]['label'], 'quantity': quantity})
    if not any(deltas.values()):
        raise ValueError('Эти замены не меняют список материалов')
    pending = Counter()
    for r in snapshot['reservations']:
        if r['status'] == 'active':
            pending[r['material_id']] += r['quantity'] - r['delivered']
    changes = []
    for block_id, delta in deltas.items():
        if not delta:
            continue
        old = current.get(block_id, {'id': None, 'block_id': block_id, 'label': clean_name(block_id),
                                     'category': category_for(block_id), 'required': 0, 'delivered': 0})
        new_required = old['required'] + delta
        reserved = pending[old['id']]
        new_reserved = min(reserved, max(0, new_required - old['delivered']))
        changes.append({'block_id': block_id, 'material_id': old['id'], 'label': old['label'], 'category': old['category'],
                        'before_required': old['required'], 'after_required': new_required, 'delivered': old['delivered'],
                        'before_reserved': reserved, 'after_reserved': new_reserved, 'released': reserved - new_reserved,
                        'surplus': max(0, old['delivered'] - new_required), 'delta': delta})
    after_required = sum(m['required'] for m in snapshot['materials'])
    counted = sum(min(m['required'], m['delivered']) for m in snapshot['materials'])
    counted += sum(min(c['after_required'], c['delivered']) - min(c['before_required'], c['delivered']) for c in changes)
    return {'revision': inventory_revision(snapshot), 'rules': normalized, 'changes': changes,
            'total_required': after_required, 'counted_after': counted, 'released': sum(c['released'] for c in changes),
            'surplus_after': sum(max(0, m['delivered']-m['required']) for m in snapshot['materials']) +
                            sum(c['surplus']-max(0,c['delivered']-c['before_required']) for c in changes)}


class App(BaseHTTPRequestHandler):
    server_version = "BuildTogether/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        try:
            print(f"{self.address_string()} {fmt % args}")
        except OSError:
            pass

    def json_response(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, message: str, status: int = 400) -> None:
        self.json_response({"error": message}, status)

    def body_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Слишком большой запрос")
        if length < 0:
            raise ValueError("Некорректный запрос")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("Некорректный запрос")
        return data

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                return self.json_response({"ok": True})
            if parsed.path in {"/assets/editor.js", "/assets/editor.css", "/assets/schematic3d.js", "/assets/schematic3d.js.LEGAL.txt", "/assets/app.js", "/assets/app.css", "/assets/chest-ui.js", "/assets/chests3d.js", "/assets/chests.css", "/assets/chests3d.js.LEGAL.txt", "/assets/three-LICENSE.txt", "/assets/ui.js", "/assets/ui-icons.svg", "/assets/lucide-LICENSE.txt", "/assets/ui-icons-source.json"}:
                path = BASE_DIR / "static" / Path(parsed.path).name
                body = path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8" if path.suffix == ".js" else ("text/css; charset=utf-8" if path.suffix == ".css" else "image/svg+xml" if path.suffix == ".svg" else "application/json; charset=utf-8" if path.suffix == ".json" else "text/plain; charset=utf-8"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                return self.wfile.write(body)
            if parsed.path in {'/mc-assets/models.json', '/mc-assets/atlas.png', '/mc-assets/block-icons.png'}:
                compressed = parsed.path.endswith('models.json')
                path = BASE_DIR / 'static/minecraft' / ('models.json.gz' if compressed else Path(parsed.path).name)
                body = path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json' if compressed else 'image/png')
                if compressed:
                    self.send_header('Content-Encoding', 'gzip')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                return self.wfile.write(body)
            if parsed.path == "/api/catalog":
                return self.json_response({"blocks": sorted(BLOCK_CATALOG.values(), key=lambda b: b["label"])})
            if parsed.path == "/api/editor-catalog":
                index_path = BASE_DIR / 'static/minecraft/block-icons.json'
                icons = json.loads(index_path.read_text()) if index_path.exists() else {}
                return self.json_response({"blocks": [{'block_id': k, 'label': clean_name(k), 'category': category_for(k), 'icon': icons.get('blocks', {}).get(k)} for k in schematic_editor.BLOCKS], "version": "26.1", "icons": {k:icons[k] for k in ('width','height','tile') if k in icons}})
            if parsed.path.startswith('/block-texture/'):
                raw = parsed.path.removeprefix('/block-texture/')
                if not re.fullmatch(r'[a-z0-9_]+', raw):
                    return self.error_json('Текстура не найдена', 404)
                candidates = [raw, ICON_ALIASES.get(raw, ''), raw + '_side', raw + '_top']
                for suffix in ('_stairs', '_slab', '_wall'):
                    if raw.endswith(suffix):
                        base = raw.removesuffix(suffix)
                        candidates.extend([base, base + 's'])
                if raw.endswith('_pane'):
                    candidates.append(raw.removesuffix('_pane'))
                if raw.endswith('_door'):
                    candidates.append(raw + '_bottom')
                path = next((TEXTURES_PATH / 'block' / (c + '.png') for c in candidates if c and (TEXTURES_PATH / 'block' / (c + '.png')).is_file()), icon_path(raw))
                body = path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                return self.wfile.write(body)
            if parsed.path == "/api/projects":
                return self.json_response({"projects": []})
            if parsed.path == "/api/state":
                project_id = parse_qs(parsed.query).get("project", [""])[0]
                return self.project_state(project_id)
            if parsed.path.startswith("/icon/"):
                path = icon_path(parsed.path.removeprefix("/icon/"))
                body = path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=604800, immutable")
                self.end_headers()
                return self.wfile.write(body)
            if parsed.path == "/" or not parsed.path.startswith("/api/"):
                body = INDEX_PATH.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                return self.wfile.write(body)
            self.error_json("Маршрут не найден", 404)
        except PermissionError as exc:
            self.error_json(str(exc), 403)
        except Exception:
            traceback.print_exc()
            self.error_json("Не удалось загрузить сбор", 500)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if parsed.path == "/" or not parsed.path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            handlers = {
                "/api/projects": self.create_project,
                "/api/schematic-preview": self.schematic_preview,
                "/api/schematic-export": self.schematic_export,
                "/api/join": self.join_project,
                "/api/reserve": self.reserve,
                "/api/deliver": self.deliver,
                "/api/cancel": self.cancel_reservation,
                "/api/collect": self.collect,
                "/api/settings": self.settings,
                "/api/profile": self.profile,
                "/api/replace-preview": self.replace_preview,
                "/api/replace": self.replace_materials,
                "/api/undo": self.undo_change,
                "/api/chest": self.chest_edit,
                "/api/chest-fill": self.chest_fill,
                "/api/chest-transfer": self.chest_transfer,
            }
            handler = handlers.get(parsed.path)
            if not handler:
                return self.error_json("Маршрут не найден", 404)
            handler()
        except PermissionError as exc:
            self.error_json(str(exc), 403)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self.error_json(str(exc) or "Проверьте данные", 400)
        except Exception as exc:
            traceback.print_exc()
            self.error_json("Не удалось выполнить действие", 500)

    def schematic_request(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_UPLOAD + 1_000_000:
            raise ValueError('Файл должен быть не больше 40 МБ')
        raw = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {self.headers.get('Content-Type', '')}\r\nMIME-Version: 1.0\r\n\r\n".encode() + raw)
        if not message.is_multipart():
            raise ValueError('Выберите файл .litematic')
        payload, filename, options = None, '', {}
        for part in message.iter_parts():
            name = part.get_param('name', header='content-disposition')
            if name == 'file':
                payload = part.get_payload(decode=True)
                filename = Path(part.get_filename() or '').name[:180]
            elif name == 'options':
                value = part.get_payload(decode=True) or b'{}'
                if len(value) > 100_000:
                    raise ValueError('Слишком много правил')
                options = json.loads(value)
        if not payload or len(payload) > MAX_UPLOAD or not filename.lower().endswith('.litematic'):
            raise ValueError('Выберите .litematic размером до 40 МБ')
        if not isinstance(options, dict):
            raise ValueError('Некорректные настройки редактора')
        schematic = schematic_editor.read_schematic(payload)
        changes = schematic_editor.edit_schematic(schematic, options)
        return schematic, filename, changes

    def schematic_preview(self):
        if not EDITOR_SLOTS.acquire(blocking=False):
            return self.error_json('Редактор занят. Повторите через несколько секунд', 429)
        try:
            schematic, filename, changes = self.schematic_request()
            data = schematic_editor.preview(schematic, clean_name)
            data.update(filename=filename, changes=changes)
            self.json_response(data)
        finally:
            EDITOR_SLOTS.release()

    def schematic_export(self):
        if not EDITOR_SLOTS.acquire(blocking=False):
            return self.error_json('Редактор занят. Повторите через несколько секунд', 429)
        try:
            schematic, filename, changes = self.schematic_request()
            schematic_editor.preview(schematic, clean_name)
            body = schematic_editor.write_schematic(schematic)
            filename = Path(filename).stem + '-edited.litematic'
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', "attachment; filename=schematic-edited.litematic; filename*=UTF-8''" + quote(filename))
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        finally:
            EDITOR_SLOTS.release()

    def create_project(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD:
            raise ValueError("Файл должен быть не больше 40 МБ")
        raw = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + raw
        )
        fields: dict[str, object] = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name == "file":
                fields["file"] = (part.get_filename(), part.get_payload(decode=True))
            elif name:
                fields[name] = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
        title = str(fields.get("title", "")).strip()[:80]
        upload = fields.get("file")
        if not title:
            raise ValueError("Укажите название проекта")
        if not upload or not isinstance(upload, tuple) or not upload[0]:
            raise ValueError("Выберите файл .litematic")
        filename = Path(str(upload[0])).name[:180]
        if not filename.lower().endswith(".litematic"):
            raise ValueError("Нужен файл с расширением .litematic")
        temp = BASE_DIR / f".upload-{secrets.token_hex(8)}.litematic"
        try:
            with temp.open("wb") as target:
                target.write(upload[1])
            counts = parse_litematic(temp)
        finally:
            temp.unlink(missing_ok=True)
        share_key = secrets.token_urlsafe(32)
        project_id = secrets.token_urlsafe(6).replace("-", "a").replace("_", "b")[:8]
        now = int(time.time())
        with DB_LOCK, db() as conn:
            conn.execute("INSERT INTO projects(id,title,filename,total_blocks,created_at,key_hash) VALUES(?,?,?,?,?,?)", (project_id, title, filename, sum(counts.values()), now, token_hash(share_key)))
            conn.executemany(
                "INSERT INTO materials(project_id, block_id, label, category, required) VALUES(?,?,?,?,?)",
                [(project_id, block_id, clean_name(block_id), category_for(block_id), qty) for block_id, qty in counts.most_common()],
            )
            add_activity(conn, project_id, None, f"Создан проект «{title}»")
        self.json_response({"project_id": project_id, "share_key": share_key}, 201)

    def join_project(self) -> None:
        data = self.body_json()
        project_id = str(data.get("project_id", ""))
        nickname = str(data.get("nickname", "")).strip()[:32] or "Гость " + secrets.token_hex(2)
        if len(nickname) < 2:
            raise ValueError("Введите ник: минимум 2 символа")
        participant_id, token = secrets.token_urlsafe(9), secrets.token_urlsafe(24)
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("Проект не найден")
            conn.execute(
                "INSERT INTO participants VALUES(?,?,?,?,?)",
                (participant_id, project_id, nickname, token_hash(token), int(time.time())),
            )
            add_activity(conn, project_id, participant_id, f"{nickname} присоединился к проекту")
        self.json_response({"participant_id": participant_id, "token": token, "nickname": nickname})

    def reserve(self) -> None:
        data = self.body_json()
        project_id = str(data["project_id"])
        material_id, quantity = int(data["material_id"]), int(data["quantity"])
        if quantity <= 0:
            raise ValueError("Количество должно быть больше нуля")
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            person = actor(conn, project_id, str(data["participant_id"]), str(data["token"]))
            material = conn.execute("SELECT * FROM materials WHERE id=? AND project_id=?", (material_id, project_id)).fetchone()
            if not material:
                raise ValueError("Материал не найден")
            reserved = conn.execute(
                "SELECT COALESCE(SUM(quantity-delivered),0) FROM reservations WHERE material_id=? AND status='active'",
                (material_id,),
            ).fetchone()[0]
            available = material["required"] - material["delivered"] - reserved
            if quantity > available:
                raise ValueError(f"Можно взять не больше {max(0, available)}")
            before = inventory_snapshot(conn, project_id)
            reservation_id = secrets.token_urlsafe(9)
            conn.execute(
                "INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?)",
                (reservation_id, project_id, material_id, person["id"], quantity, 0, "active", int(time.time())),
            )
            add_activity(conn, project_id, person["id"], f"{person['nickname']} взял {quantity} × {material['label']}")
            change_id = record_change(conn, project_id, "reserve", f"Взято: {quantity} × {material['label']}", before)
        self.json_response({"ok": True, "change_id": change_id}, 201)

    def deliver(self) -> None:
        data = self.body_json()
        quantity = int(data["quantity"])
        if quantity <= 0:
            raise ValueError("Количество должно быть больше нуля")
        with DB_LOCK, db() as conn:
            reservation = conn.execute("SELECT * FROM reservations WHERE id=?", (str(data["reservation_id"]),)).fetchone()
            if not reservation:
                raise PermissionError("Сбор недоступен")
            require_access(conn, reservation["project_id"], self.headers.get("X-Collection-Key", ""))
            person = actor(conn, reservation["project_id"], str(data["participant_id"]), str(data["token"]))
            outstanding = reservation["quantity"] - reservation["delivered"]
            if reservation["status"] != "active" or quantity > outstanding:
                raise ValueError(f"Можно сдать не больше {max(0, outstanding)}")
            material = conn.execute("SELECT * FROM materials WHERE id=?", (reservation["material_id"],)).fetchone()
            before = inventory_snapshot(conn, reservation["project_id"])
            new_delivered = reservation["delivered"] + quantity
            status = "done" if new_delivered == reservation["quantity"] else "active"
            conn.execute("UPDATE reservations SET delivered=?, status=? WHERE id=?", (new_delivered, status, reservation["id"]))
            conn.execute("UPDATE materials SET delivered=delivered+? WHERE id=?", (quantity, material["id"]))
            owner = conn.execute("SELECT nickname FROM participants WHERE id=?", (reservation["participant_id"],)).fetchone()
            on_behalf = f" (за {owner['nickname']})" if reservation["participant_id"] != person["id"] else ""
            add_activity(conn, reservation["project_id"], person["id"], f"{person['nickname']} сдал {quantity} × {material['label']}{on_behalf}")
            change_id = record_change(conn, reservation["project_id"], "deliver", f"Сдано: {quantity} × {material['label']}", before)
        self.json_response({"ok": True, "change_id": change_id})

    def cancel_reservation(self) -> None:
        data = self.body_json()
        with DB_LOCK, db() as conn:
            reservation = conn.execute("SELECT * FROM reservations WHERE id=?", (str(data["reservation_id"]),)).fetchone()
            if not reservation:
                raise PermissionError("Сбор недоступен")
            require_access(conn, reservation["project_id"], self.headers.get("X-Collection-Key", ""))
            person = actor(conn, reservation["project_id"], str(data["participant_id"]), str(data["token"]))
            if reservation["status"] != "active":
                raise ValueError("Резерв уже закрыт")
            material = conn.execute("SELECT label FROM materials WHERE id=?", (reservation["material_id"],)).fetchone()
            before = inventory_snapshot(conn, reservation["project_id"])
            conn.execute("UPDATE reservations SET status='cancelled' WHERE id=?", (reservation["id"],))
            add_activity(conn, reservation["project_id"], person["id"], f"{person['nickname']} освободил резерв: {material['label']}")
            change_id = record_change(conn, reservation["project_id"], "cancel", f"Освобождён резерв: {material['label']}", before)
        self.json_response({"ok": True, "change_id": change_id})

    def settings(self):
        data = self.body_json()
        project_id = str(data.get("project_id", ""))
        title = str(data.get("title", "")).strip()[:80]
        notes = str(data.get("notes", "")).strip()[:500]
        if not title:
            raise ValueError("Укажите название сбора")
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            conn.execute("UPDATE projects SET title=?,notes=? WHERE id=?", (title, notes, project_id))
        self.json_response({"ok": True})

    def profile(self):
        data = self.body_json()
        project_id = str(data.get("project_id", ""))
        nickname = str(data.get("nickname", "")).strip()[:32]
        if len(nickname) < 2:
            raise ValueError("Имя должно содержать минимум 2 символа")
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            person = actor(conn, project_id, str(data.get("participant_id", "")), str(data.get("token", "")))
            conn.execute("UPDATE participants SET nickname=? WHERE id=?", (nickname, person["id"]))
        self.json_response({"ok": True})

    def collect(self):
        data = self.body_json()
        project_id = str(data.get("project_id", ""))
        quantity = int(data.get("quantity", 0))
        if quantity <= 0:
            raise ValueError("Количество должно быть больше нуля")
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            person = actor(conn, project_id, str(data.get("participant_id", "")), str(data.get("token", "")))
            material = conn.execute("SELECT * FROM materials WHERE id=? AND project_id=?", (int(data["material_id"]), project_id)).fetchone()
            if not material:
                raise ValueError("Материал не найден")
            reserved = conn.execute("SELECT COALESCE(SUM(quantity-delivered),0) FROM reservations WHERE material_id=? AND status='active'", (material["id"],)).fetchone()[0]
            available = material["required"] - material["delivered"] - reserved
            if quantity > available:
                raise ValueError(f"Можно сдать не больше {max(0, available)}. Часть материалов уже взята командой.")
            before = inventory_snapshot(conn, project_id)
            conn.execute("INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?)", (secrets.token_urlsafe(9), project_id, material["id"], person["id"], quantity, quantity, "done", int(time.time())))
            conn.execute("UPDATE materials SET delivered=delivered+? WHERE id=?", (quantity, material["id"]))
            add_activity(conn, project_id, person["id"], f"{person['nickname']} сдал {quantity} × {material['label']}")
            change_id = record_change(conn, project_id, "collect", f"Сдано: {quantity} × {material['label']}", before)
        self.json_response({"ok": True, "change_id": change_id})

    def replace_preview(self):
        data = self.body_json()
        project_id = str(data.get('project_id', ''))
        with DB_LOCK, db() as conn:
            require_access(conn, project_id, self.headers.get('X-Collection-Key', ''))
            plan = replacement_plan(conn, project_id, data.get('rules'))
        self.json_response(plan)

    def replace_materials(self):
        data = self.body_json()
        project_id = str(data.get('project_id', ''))
        with DB_LOCK, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_access(conn, project_id, self.headers.get('X-Collection-Key', ''))
            person = actor(conn, project_id, str(data.get('participant_id', '')), str(data.get('token', '')))
            plan = replacement_plan(conn, project_id, data.get('rules'))
            if not secrets.compare_digest(plan['revision'], str(data.get('revision', ''))):
                raise ValueError('Команда уже изменила ресурсы. Обновите предварительный расчёт.')
            before = inventory_snapshot(conn, project_id)
            for change in plan['changes']:
                material = conn.execute('SELECT id FROM materials WHERE project_id=? AND block_id=?', (project_id, change['block_id'])).fetchone()
                if material:
                    material_id = material['id']
                    conn.execute('UPDATE materials SET required=? WHERE id=?', (change['after_required'], material_id))
                else:
                    material_id = conn.execute('INSERT INTO materials(project_id,block_id,label,category,required) VALUES(?,?,?,?,?)',
                        (project_id, change['block_id'], clean_name(change['block_id']), category_for(change['block_id']), change['after_required'])).lastrowid
                release = change['released']
                for reservation in conn.execute("SELECT * FROM reservations WHERE material_id=? AND status='active' ORDER BY created_at DESC,id DESC", (material_id,)).fetchall():
                    if release <= 0:
                        break
                    outstanding = reservation['quantity'] - reservation['delivered']
                    drop = min(release, outstanding)
                    keep = outstanding - drop
                    status = 'active' if keep else ('done' if reservation['delivered'] else 'cancelled')
                    conn.execute('UPDATE reservations SET quantity=?,status=? WHERE id=?', (reservation['delivered'] + keep, status, reservation['id']))
                    release -= drop
            conn.execute('UPDATE projects SET total_blocks=(SELECT SUM(required) FROM materials WHERE project_id=?) WHERE id=?', (project_id, project_id))
            label = 'Замена: ' + '; '.join(f"{r['source_label']} → {r['target_label']} × {r['quantity']}" for r in plan['rules'])
            add_activity(conn, project_id, person['id'], f"{person['nickname']}: {label}")
            change_id = record_change(conn, project_id, 'replace', label, before)
        self.json_response({'ok': True, 'change_id': change_id})

    def undo_change(self):
        data = self.body_json()
        project_id = str(data.get('project_id', ''))
        with DB_LOCK, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_access(conn, project_id, self.headers.get('X-Collection-Key', ''))
            person = actor(conn, project_id, str(data.get('participant_id', '')), str(data.get('token', '')))
            change = conn.execute('SELECT * FROM resource_changes WHERE id=? AND project_id=?', (int(data.get('change_id', 0)), project_id)).fetchone()
            if not change or change['undone']:
                raise ValueError('Это действие уже отменено или недоступно')
            payload = json.loads(change['payload'])
            current = inventory_snapshot(conn, project_id)
            if not secrets.compare_digest(payload['after_revision'], inventory_revision(current)):
                raise ValueError('Отмена недоступна: после этого ресурсы изменились. Новые действия команды сохранены.')
            before = payload['before']
            before_ids = {m['id'] for m in before['materials']}
            for material in current['materials']:
                if material['id'] not in before_ids:
                    conn.execute('UPDATE materials SET required=0,delivered=0,placed=0 WHERE id=? AND project_id=?', (material['id'], project_id))
            for material in before['materials']:
                conn.execute('UPDATE materials SET required=?,delivered=?,placed=? WHERE id=? AND project_id=?',
                    (material['required'], material['delivered'], material['placed'], material['id'], project_id))
            old_reservations = {r['id'] for r in before['reservations']}
            for reservation in current['reservations']:
                if reservation['id'] not in old_reservations:
                    conn.execute("UPDATE reservations SET delivered=0,status='cancelled' WHERE id=? AND project_id=?", (reservation['id'], project_id))
            for reservation in before['reservations']:
                conn.execute('UPDATE reservations SET quantity=?,delivered=?,status=? WHERE id=? AND project_id=?',
                    (reservation['quantity'], reservation['delivered'], reservation['status'], reservation['id'], project_id))
            conn.execute('UPDATE projects SET total_blocks=(SELECT SUM(required) FROM materials WHERE project_id=?) WHERE id=?', (project_id, project_id))
            restore_warehouse(conn, project_id, before)
            conn.execute('UPDATE resource_changes SET undone=1 WHERE id=?', (change['id'],))
            add_activity(conn, project_id, person['id'], f"{person['nickname']} отменил действие «{change['label']}»")
        self.json_response({'ok': True})

    def chest_edit(self):
        data=self.body_json();project_id=str(data.get('project_id',''));op=data.get('op','create')
        with DB_LOCK,db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_access(conn,project_id,self.headers.get('X-Collection-Key',''))
            person=actor(conn,project_id,str(data.get('participant_id','')),str(data.get('token','')))
            require_warehouse_revision(conn,project_id,data.get('revision'))
            before=inventory_snapshot(conn,project_id)
            chests=warehouse_snapshot(conn,project_id)['chests']
            if op=='create':
                if len(chests)>=128:raise ValueError('На складе уже 128 сундуков')
                chest={'id':secrets.token_urlsafe(9),'name':f'Сундук {len(chests)+1}','x':0,'y':0,'z':0,'rotation':0,'kind':'single','label_mode':'frame','label_material':'','sign_text':''}
            elif op in ('update','delete'):
                chest=require_chest(conn,project_id,str(data.get('chest_id','')))
            else:raise ValueError('Неизвестное действие с сундуком')
            if op=='delete':
                check_chest_layout([c for c in chests if c['id']!=chest['id']])
                conn.execute('DELETE FROM warehouse_slots WHERE chest_id=?',(chest['id'],))
                conn.execute('UPDATE warehouse_chests SET deleted=1 WHERE id=?',(chest['id'],))
                label=f"Убран сундук «{chest['name']}». Содержимое возвращено в неразложенное."
            else:
                for field in ('x','y','z','rotation','kind','label_mode','label_material','sign_text','name'):
                    if field in data:chest[field]=data[field]
                chest['name']=str(chest['name']).strip()[:40] or 'Сундук'
                chest['sign_text']=str(chest['sign_text']).strip()[:64]
                chest['label_material']=str(chest['label_material'])
                if chest['label_mode'] not in ('none','frame','sign','both'):raise ValueError('Выберите рамку или табличку')
                if chest['label_material'] and chest['label_material'] not in BLOCK_CATALOG and not conn.execute('SELECT 1 FROM materials WHERE project_id=? AND block_id=?',(project_id,chest['label_material'])).fetchone():raise ValueError('Материал для рамки не найден')
                check_chest_layout([c for c in chests if c['id']!=chest['id']]+[chest])
                if chest['kind']=='single' and conn.execute('SELECT 1 FROM warehouse_slots WHERE chest_id=? AND slot>=27',(chest['id'],)).fetchone():raise ValueError('Сначала освободите нижние 27 слотов двойного сундука')
                if op=='create':
                    fields=CHEST_FIELDS+('project_id',)
                    conn.execute('INSERT INTO warehouse_chests('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+')',[chest[f] for f in CHEST_FIELDS]+[project_id])
                else:
                    fields=CHEST_FIELDS[1:]
                    conn.execute('UPDATE warehouse_chests SET '+','.join(f+'=?' for f in fields)+' WHERE id=?',[chest[f] for f in fields]+[chest['id']])
                label=('Поставлен' if op=='create' else 'Изменён')+f" сундук «{chest['name']}»"
            warehouse_bump(conn,project_id)
            add_activity(conn,project_id,person['id'],person['nickname']+': '+label)
            change_id=record_change(conn,project_id,'chest_'+op,label,before)
            warehouse=warehouse_data(conn,project_id)
        self.json_response({'ok':True,'chest_id':chest['id'],'warehouse':warehouse,'change_id':change_id})

    def chest_fill(self):
        data=self.body_json();project_id=str(data.get('project_id',''))
        with DB_LOCK,db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_access(conn,project_id,self.headers.get('X-Collection-Key',''))
            person=actor(conn,project_id,str(data.get('participant_id','')),str(data.get('token','')))
            require_warehouse_revision(conn,project_id,data.get('revision'))
            chest=require_chest(conn,project_id,str(data.get('chest_id','')))
            material=conn.execute('SELECT * FROM materials WHERE project_id=? AND id=?',(project_id,data.get('material_id'))).fetchone()
            if not material:raise ValueError('Материал не найден в сборе')
            quantity=integer(data.get('quantity'),1,3456,'Количество')
            slot=data.get('slot');mode=data.get('mode','allocate')
            if chest_capacity(conn,chest,material,slot)<quantity:raise ValueError('В сундуке или слоте недостаточно места')
            before=inventory_snapshot(conn,project_id)
            if mode=='allocate':
                allocated=conn.execute('SELECT COALESCE(SUM(s.quantity),0) FROM warehouse_slots s JOIN warehouse_chests c ON c.id=s.chest_id WHERE c.project_id=? AND c.deleted=0 AND s.material_id=?',(project_id,material['id'])).fetchone()[0]
                if quantity>material['delivered']-allocated:raise ValueError('Столько сданных ресурсов больше нет в неразложенном')
            elif mode=='collect':
                reserved=conn.execute("SELECT COALESCE(SUM(quantity-delivered),0) FROM reservations WHERE material_id=? AND status='active'",(material['id'],)).fetchone()[0]
                if quantity>material['required']-material['delivered']-reserved:raise ValueError('Часть ресурсов уже собрана или находится в резерве. Выберите сдачу из резерва.')
                conn.execute('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?)',(secrets.token_urlsafe(9),project_id,material['id'],person['id'],quantity,quantity,'done',int(time.time())))
                conn.execute('UPDATE materials SET delivered=delivered+? WHERE id=?',(quantity,material['id']))
            elif mode=='deliver':
                r=conn.execute("SELECT * FROM reservations WHERE id=? AND project_id=? AND material_id=? AND status='active'",(str(data.get('reservation_id','')),project_id,material['id'])).fetchone()
                if not r or quantity>r['quantity']-r['delivered']:raise ValueError('В этом резерве недостаточно ресурсов для сдачи')
                done=r['delivered']+quantity
                conn.execute('UPDATE reservations SET delivered=?,status=? WHERE id=?',(done,'done' if done==r['quantity'] else 'active',r['id']))
                conn.execute('UPDATE materials SET delivered=delivered+? WHERE id=?',(quantity,material['id']))
            else:raise ValueError('Выберите источник ресурсов')
            put_in_chest(conn,chest,material,quantity,slot)
            warehouse_bump(conn,project_id)
            label=f"{'Разложено' if mode=='allocate' else 'Сдано в сундук'}: {quantity} × {material['label']} → {chest['name']}"
            add_activity(conn,project_id,person['id'],person['nickname']+': '+label)
            change_id=record_change(conn,project_id,'chest_fill',label,before)
            warehouse=warehouse_data(conn,project_id)
        self.json_response({'ok':True,'warehouse':warehouse,'change_id':change_id})

    def chest_transfer(self):
        data=self.body_json();project_id=str(data.get('project_id',''))
        with DB_LOCK,db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_access(conn,project_id,self.headers.get('X-Collection-Key',''))
            person=actor(conn,project_id,str(data.get('participant_id','')),str(data.get('token','')))
            require_warehouse_revision(conn,project_id,data.get('revision'))
            source=require_chest(conn,project_id,str(data.get('chest_id','')))
            slot=integer(data.get('slot'),0,(54 if source['kind']=='double' else 27)-1,'Слот')
            item=conn.execute('SELECT * FROM warehouse_slots WHERE chest_id=? AND slot=?',(source['id'],slot)).fetchone()
            if not item:raise ValueError('Этот слот уже пуст')
            quantity=integer(data.get('quantity'),1,item['quantity'],'Количество')
            material=conn.execute('SELECT * FROM materials WHERE id=?',(item['material_id'],)).fetchone()
            target_id=str(data.get('target_chest_id',''));target_slot=data.get('target_slot')
            before=inventory_snapshot(conn,project_id)
            target=require_chest(conn,project_id,target_id) if target_id else None
            if target and target['id']==source['id'] and (target_slot is None or target_slot==slot):raise ValueError('Выберите другой слот или сундук')
            swap=None
            if target and target_slot is not None:
                integer(target_slot,0,(54 if target['kind']=='double' else 27)-1,'Целевой слот')
                swap=conn.execute('SELECT * FROM warehouse_slots WHERE chest_id=? AND slot=?',(target_id,target_slot)).fetchone()
                if swap and swap['material_id']==material['id']:swap=None
            if swap:
                if quantity!=item['quantity']:raise ValueError('Для обмена разных материалов перенесите весь стак')
                conn.execute('UPDATE warehouse_slots SET material_id=?,quantity=? WHERE chest_id=? AND slot=?',(swap['material_id'],swap['quantity'],source['id'],slot))
                conn.execute('UPDATE warehouse_slots SET material_id=?,quantity=? WHERE chest_id=? AND slot=?',(item['material_id'],item['quantity'],target_id,target_slot))
            else:
                if target and chest_capacity(conn,target,material,target_slot)<quantity:raise ValueError('В целевом сундуке или слоте недостаточно места')
                left=item['quantity']-quantity
                if left:conn.execute('UPDATE warehouse_slots SET quantity=? WHERE chest_id=? AND slot=?',(left,source['id'],slot))
                else:conn.execute('DELETE FROM warehouse_slots WHERE chest_id=? AND slot=?',(source['id'],slot))
                if target:put_in_chest(conn,target,material,quantity,target_slot)
            warehouse_bump(conn,project_id)
            label=f"{quantity} × {material['label']}: {source['name']} → "+(target['name'] if target else 'неразложенное')
            add_activity(conn,project_id,person['id'],person['nickname']+': '+label)
            change_id=record_change(conn,project_id,'chest_transfer',label,before)
            warehouse=warehouse_data(conn,project_id)
        self.json_response({'ok':True,'warehouse':warehouse,'change_id':change_id})

    def project_state(self, project_id: str) -> None:
        with db() as conn:
            conn.execute('BEGIN')
            require_access(conn, project_id, self.headers.get("X-Collection-Key", ""))
            project = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if not project:
                return self.error_json("Проект не найден", 404)
            materials = [dict(row) for row in conn.execute("""
                SELECT m.*, COALESCE(SUM(CASE WHEN r.status='active' THEN r.quantity-r.delivered ELSE 0 END),0) reserved
                FROM materials m LEFT JOIN reservations r ON r.material_id=m.id
                WHERE m.project_id=? AND (m.required>0 OR m.delivered>0) GROUP BY m.id ORDER BY m.required DESC, m.label
            """, (project_id,)).fetchall()]
            for material in materials:
                if material['block_id'].split(':', 1)[-1] in FLOWER_BLOCKS:
                    material['category'] = "Природные блоки"
            reservations = [dict(row) for row in conn.execute("""
                SELECT r.*, p.nickname, m.label, m.block_id
                FROM reservations r JOIN participants p ON p.id=r.participant_id JOIN materials m ON m.id=r.material_id
                WHERE r.project_id=? ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END, r.created_at DESC
            """, (project_id,)).fetchall()]
            activity = [dict(row) for row in conn.execute(
                "SELECT * FROM activity WHERE project_id=? AND text NOT LIKE '%отметил установку%' ORDER BY id DESC LIMIT 40", (project_id,)
            ).fetchall()]
            people = [dict(row) for row in conn.execute("""
                SELECT p.id, p.nickname, p.joined_at, COALESCE(SUM(r.delivered), 0) contribution
                FROM participants p LEFT JOIN reservations r ON r.participant_id=p.id
                WHERE p.project_id=? GROUP BY p.id ORDER BY p.joined_at
            """, (project_id,)).fetchall()]
            total_contribution = sum(person["contribution"] for person in people)
            for person in people:
                person["contribution_percent"] = round(
                    person["contribution"] * 100 / total_contribution, 1
                ) if total_contribution else 0
            warehouse = warehouse_data(conn, project_id)
            current_revision = inventory_revision(inventory_snapshot(conn, project_id))
            changes = []
            for change in conn.execute("SELECT * FROM resource_changes WHERE project_id=? ORDER BY id DESC LIMIT 15", (project_id,)):
                payload = json.loads(change['payload'])
                changes.append({'id': change['id'], 'kind': change['kind'], 'label': change['label'], 'created_at': change['created_at'],
                                'undone': bool(change['undone']), 'can_undo': not change['undone'] and secrets.compare_digest(payload['after_revision'], current_revision)})
        public_project = {k: v for k, v in dict(project).items() if k != "key_hash"}
        self.json_response({"project": public_project, "materials": materials, "reservations": reservations, "activity": activity, "people": people, "changes": changes, "warehouse": warehouse})


class PlannerServer(ThreadingHTTPServer):
    # HTTP/2 proxies fan out icon requests into concurrent upstream connections.
    request_queue_size = 256



if __name__ == "__main__":
    init_db()
    host, port = os.environ.get("LITEMATIC_HOST", "127.0.0.1"), int(os.environ.get("LITEMATIC_PORT", "8874"))
    print(f"Build Together listening on http://{host}:{port}")
    PlannerServer((host, port), App).serve_forever()
