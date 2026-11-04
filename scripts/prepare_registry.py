#!/usr/bin/env python3
"""Build a local editor registry from pinned upstream data; the upstream dataset is not vendored."""
import json
from pathlib import Path
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
REVISION='9b995542ab4a17837dee785439954e43d031b33e'
URL=f'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/{REVISION}/data/pc/26.1/blocks.json'


def prepare():
    with urllib.request.urlopen(URL,timeout=30) as response:
        blocks=json.load(response)
    result={}
    for block in blocks:
        offset=block['defaultState']-block['minStateId']
        defaults={};states={}
        for state in reversed(block.get('states',[])):
            values=state.get('values') or (['true','false'] if state['type']=='bool' else [str(i) for i in range(state['num_values'])])
            values=[str(value) for value in values]
            defaults[state['name']]=values[offset%len(values)]
            states[state['name']]=values
            offset//=len(values)
        result['minecraft:'+block['name']]={'default':defaults,'states':states}
    target=ROOT/'data/editor-blocks.json';target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(result,separators=(',',':')))
    print(f'Prepared {len(result)} block definitions from pinned minecraft-data {REVISION[:12]}')


if __name__=='__main__':
    prepare()
