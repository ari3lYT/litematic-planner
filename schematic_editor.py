"""Lossless Litematica edits; uploads are processed in memory, never persisted."""
from __future__ import annotations

import gzip
import io
import json
import math
import re
import time
from collections import Counter
from pathlib import Path

import nbtlib
import numpy as np
from nbtlib import Compound, Int, List, Long, LongArray, String

AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void'}
MAX_RAW = 96 * 1024 * 1024
MAX_VOLUME = 16_000_000
PREVIEW_LIMIT = 80_000
BLOCKS = json.loads((Path(__file__).parent / 'data/editor-blocks.json').read_text())
VERSIONS = json.loads((Path(__file__).parent / 'data/editor-versions.json').read_text())


def read_schematic(payload):
    try:
        if payload[:2] == b'\x1f\x8b':
            with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
                raw = stream.read(MAX_RAW + 1)
        else:
            raw = payload
        if len(raw) > MAX_RAW:
            raise ValueError('Распакованная схема превышает 96 МБ')
        schematic = nbtlib.File.parse(io.BytesIO(raw))
        regions = schematic.get('Regions')
        if not isinstance(regions, Compound) or not 1 <= len(regions) <= 512:
            raise ValueError('В файле нет регионов Litematica или их слишком много')
        if int(schematic.get('Version', 0)) not in (4, 5, 6, 7):
            raise ValueError('Поддерживаются версии формата Litematica 4–7')
        volume = 0
        for region in regions.values():
            size = [int(region['Size'][a]) for a in 'xyz']
            if any(v == 0 or abs(v) > 1_000_000 for v in size):
                raise ValueError('Некорректные размеры региона')
            volume += math.prod(abs(v) for v in size)
            if volume > MAX_VOLUME:
                raise ValueError('Объём схемы превышает 16 млн ячеек')
            palette = region['BlockStatePalette']
            if not 1 <= len(palette) <= 65536:
                raise ValueError('Некорректная палитра блоков')
            for state in palette:
                if not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+', str(state['Name'])):
                    raise ValueError('Некорректное имя блока')
        return schematic
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Не удалось прочитать NBT. Выберите корректный .litematic') from exc


def decode(region):
    size = [abs(int(region['Size'][a])) for a in 'xyz']
    volume = math.prod(size)
    bits = max(2, (len(region['BlockStatePalette']) - 1).bit_length())
    words = np.asarray(region['BlockStates'], dtype=np.int64).view(np.uint64)
    if len(words) < (volume * bits + 63) // 64:
        raise ValueError('Повреждённый массив BlockStates')
    output = np.empty(volume, dtype=np.uint32)
    for start in range(0, volume, 262144):
        end = min(volume, start + 262144)
        bit = np.arange(start, end, dtype=np.uint64) * bits
        wi, offset = bit // 64, bit % 64
        values = words[wi] >> offset
        cross = offset + bits > 64
        values[cross] |= words[wi[cross] + 1] << (64 - offset[cross])
        output[start:end] = values & ((1 << bits) - 1)
    if int(output.max()) >= len(region['BlockStatePalette']):
        raise ValueError('Некорректный индекс палитры')
    return output


def encode(values, palette_size):
    bits = max(2, (palette_size - 1).bit_length())
    words = np.zeros((len(values) * bits + 63) // 64, dtype=np.uint64)
    for start in range(0, len(values), 262144):
        end = min(len(values), start + 262144)
        bit = np.arange(start, end, dtype=np.uint64) * bits
        wi, offset = bit // 64, bit % 64
        val = values[start:end].astype(np.uint64)
        np.bitwise_or.at(words, wi, val << offset)
        cross = offset + bits > 64
        np.bitwise_or.at(words, wi[cross] + 1, val[cross] >> (64 - offset[cross]))
    return LongArray(words.view(np.int64))


def state_key(state):
    return str(state['Name']), tuple(sorted((str(k), str(v)) for k, v in state.get('Properties', {}).items()))


def target_state(source, target, preserve):
    definition = BLOCKS[target]
    properties = dict(definition['default'])
    if preserve:
        for k, v in source.get('Properties', {}).items():
            if str(v) in definition['states'].get(str(k), []):
                properties[str(k)] = str(v)
    result = Compound({'Name': String(target)})
    if properties:
        result['Properties'] = Compound({k: String(v) for k, v in properties.items()})
    return result


def edit_schematic(schematic, options):
    rules = options.get('rules', [])
    if not isinstance(rules, list) or len(rules) > 64:
        raise ValueError('Допускается до 64 правил замены')
    by_source, normalized = {}, []
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError('Некорректное правило замены')
        source, target = str(rule.get('source', '')), str(rule.get('target', ''))
        quantity = rule.get('quantity')
        if target not in BLOCKS or not source or source == target or source in by_source:
            raise ValueError('Выберите разные блоки. Для исходного блока разрешено одно правило')
        if quantity is not None and (type(quantity) is not int or quantity < 1):
            raise ValueError('Количество замены должно быть положительным целым числом')
        entry = {'source': source, 'target': target, 'quantity': quantity, 'changed': 0}
        by_source[source] = entry
        normalized.append(entry)
    region_filter = str(options.get('region', ''))
    if region_filter and region_filter not in schematic['Regions']:
        raise ValueError('Регион не найден')
    preserve = options.get('preserve_properties', True) is not False
    for name, region in schematic['Regions'].items():
        if region_filter and name != region_filter:
            continue
        palette = region['BlockStatePalette']
        original_palette = list(palette)
        values = decode(region)
        original = values.copy() if rules else values
        lookup = {state_key(s): i for i, s in enumerate(palette)}
        changed_positions = np.zeros(len(values), dtype=bool)
        for source, rule in by_source.items():
            source_indexes = [i for i, s in enumerate(original_palette) if str(s['Name']) == source]
            positions = np.flatnonzero(np.isin(original, source_indexes))
            if rule['quantity'] is not None:
                positions = positions[:max(0, rule['quantity'] - rule['changed'])]
            for index in source_indexes:
                selected = positions[original[positions] == index]
                if not len(selected):
                    continue
                target = target_state(original_palette[index], rule['target'], preserve)
                key = state_key(target)
                if key not in lookup:
                    lookup[key] = len(palette)
                    palette.append(target)
                values[selected] = lookup[key]
                changed_positions[selected] = True
                rule['changed'] += len(selected)
        if changed_positions.any():
            region['BlockStates'] = encode(values, len(palette))
            sx, sy, sz = [abs(int(region['Size'][a])) for a in 'xyz']
            # Tile entity coordinates are relative to the region origin, including negative sizes.
            mins = [min(0, int(region['Size'][a]) + 1) for a in 'xyz']
            def keep_record(record):
                try:
                    x, y, z = [int(record[a]) - mins[i] for i, a in enumerate('xyz')]
                    index = (y * sz + z) * sx + x
                    return not (0 <= x < sx and 0 <= y < sy and 0 <= z < sz and changed_positions[index])
                except (KeyError, ValueError, TypeError):
                    return True
            # Data for a replaced chest/furnace/etc must not attach to a different block.
            for key in ('TileEntities', 'PendingBlockTicks', 'PendingFluidTicks'):
                if key in region:
                    region[key] = type(region[key])([r for r in region[key] if keep_record(r)])
    for rule in normalized:
        if not rule['changed']:
            raise ValueError(f"Не найдены блоки для замены: {rule['source']}")
        if rule['quantity'] is not None and rule['changed'] != rule['quantity']:
            raise ValueError(f"В схеме недостаточно {rule['source']}: найдено {rule['changed']}")
    metadata = schematic.setdefault('Metadata', Compound())
    changes = options.get('metadata', {})
    if not isinstance(changes, dict):
        raise ValueError('Некорректные метаданные')
    for key, limit in [('Name', 160), ('Author', 160), ('Description', 4000)]:
        if key in changes:
            metadata[key] = String(str(changes[key])[:limit])
    if rules or changes:
        metadata['TimeModified'] = Long(int(time.time() * 1000))
    return normalized


def preview(schematic, label_for):
    regions, counts, palette, palette_lookup, voxels, decoded = [], Counter(), [], {}, [], []
    low, high = [math.inf] * 3, [-math.inf] * 3
    total_volume = non_air = 0
    for name, region in schematic['Regions'].items():
        size = [int(region['Size'][a]) for a in 'xyz']
        dims = [abs(v) for v in size]
        pos = [int(region['Position'][a]) for a in 'xyz']
        origin = [pos[i] + min(0, size[i] + 1) for i in range(3)]
        for i in range(3):
            low[i] = min(low[i], origin[i])
            high[i] = max(high[i], origin[i] + dims[i])
        states = region['BlockStatePalette']
        values = decode(region)
        totals = np.bincount(values, minlength=len(states))
        solid = 0
        mapping = []
        for index, state in enumerate(states):
            block_id = str(state['Name'])
            amount = int(totals[index])
            if block_id not in AIR:
                counts[block_id] += amount
                solid += amount
            key = state_key(state)
            if key not in palette_lookup:
                palette_lookup[key] = len(palette)
                palette.append({'id': block_id, 'properties': dict(key[1]), 'label': label_for(block_id)})
            mapping.append(palette_lookup[key])
        volume = math.prod(dims)
        regions.append({'name': str(name), 'size': size, 'position': pos, 'min': origin,
                        'blocks': solid, 'volume': volume, 'palette_size': len(states),
                        'entities': len(region.get('Entities', [])), 'tile_entities': len(region.get('TileEntities', []))})
        total_volume += volume
        non_air += solid
        decoded.append((values, dims, origin, mapping, states))
    # Surface extraction keeps solid builds readable and bounds GPU memory.
    surfaces = []
    total_surface = 0
    for ri, (values, dims, origin, mapping, states) in enumerate(decoded):
        sx, sy, sz = dims
        occupied = np.asarray([str(s['Name']) not in AIR for s in states])[values].reshape(sy, sz, sx)
        inside = occupied.copy()
        inside[0, :, :] = inside[-1, :, :] = False
        inside[:, 0, :] = inside[:, -1, :] = False
        inside[:, :, 0] = inside[:, :, -1] = False
        if min(dims) > 2:
            inside[1:-1, 1:-1, 1:-1] &= (occupied[:-2, 1:-1, 1:-1] & occupied[2:, 1:-1, 1:-1]
                & occupied[1:-1, :-2, 1:-1] & occupied[1:-1, 2:, 1:-1]
                & occupied[1:-1, 1:-1, :-2] & occupied[1:-1, 1:-1, 2:])
        indices = np.flatnonzero(occupied.ravel() if non_air <= PREVIEW_LIMIT else occupied.ravel() & ~inside.ravel())
        surfaces.append(indices)
        total_surface += len(indices)
    stride = max(1, math.ceil(total_surface / PREVIEW_LIMIT))
    offset = 0
    for ri, ((values, dims, origin, mapping, states), surface) in enumerate(zip(decoded, surfaces)):
        sx, sy, sz = dims
        selected = surface[(-offset) % stride::stride]
        for index in selected:
            index = int(index)
            voxels.append([origin[0] + index % sx, origin[1] + index // (sx * sz),
                           origin[2] + index // sx % sz, mapping[int(values[index])], ri])
        offset += len(surface)
    metadata = schematic.get('Metadata', {})
    # Keep exact non-air totals in exported metadata too.
    if isinstance(metadata, Compound):
        metadata['TotalBlocks'] = Int(non_air)
        metadata['TotalVolume'] = Int(total_volume)
        metadata['RegionCount'] = Int(len(regions))
    return {'metadata': {k: str(metadata.get(k, '')) for k in ('Name', 'Author', 'Description')},
            'created': int(metadata.get('TimeCreated', 0)), 'modified': int(metadata.get('TimeModified', 0)),
            'format_version': int(schematic.get('Version', 0)),
            'data_version': int(schematic.get('MinecraftDataVersion', 0)),
            'minecraft_version': VERSIONS.get(str(int(schematic.get('MinecraftDataVersion', 0))), ''),
            'regions': regions, 'bounds': {'min': low, 'max': high}, 'volume': total_volume,
            'blocks': non_air, 'palette': palette, 'voxels': voxels,
            'surface_blocks': total_surface, 'sampled': stride > 1, 'surface_only': non_air > PREVIEW_LIMIT,
            'materials': [{'id': k, 'label': label_for(k), 'count': v} for k, v in counts.most_common() if v]}


def write_schematic(schematic):
    raw = io.BytesIO()
    schematic.write(raw)
    return gzip.compress(raw.getvalue(), mtime=0)
