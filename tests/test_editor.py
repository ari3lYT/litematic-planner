import sys, io, json, gzip, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from litemapy import Schematic, Region, BlockState
from nbtlib import Compound, List, String, Int, Long
import schematic_editor as editor

import tempfile
_TEMP = tempfile.TemporaryDirectory()
ROOT=Path(_TEMP.name)

def fixture():
 r=Region(10, 4, -3, 19, 3, 5)
 for x in range(19):
  for y in range(3):
   for z in range(5):
    r[x,y,z]=BlockState('minecraft:oak_stairs',facing='east',half='top',shape='straight',waterlogged='false') if (x+y+z)%3==0 else BlockState('minecraft:stone') if (x+y+z)%3==1 else BlockState('minecraft:dirt')
 n=Region(-5, 0, 8, -4, -2, -3)
 for x in range(-3,1):
  for y in range(-1,1):
   for z in range(-2,1):n[x,y,z]=BlockState('minecraft:stone')
 s=Schematic(name='Проверка', author='Тест', description='Несколько регионов', regions={'Main':r,'Negative':n}, mc_version=3955)
 p=ROOT/'fixture.litematic';s.save(str(p));return p

def transformed(path, options, name='out.litematic'):
 s=editor.read_schematic(path.read_bytes());changes=editor.edit_schematic(s,options);d=editor.preview(s,lambda x:x)
 out=ROOT/name;out.write_bytes(editor.write_schematic(s));return Schematic.load(str(out)),d,changes

class Tests(unittest.TestCase):
 def setUp(self):self.path=fixture()
 def test_roundtrip_and_negative_preview(self):
  original=Schematic.load(str(self.path));result,data,_=transformed(self.path,{})
  for name,r in original.regions.items():
   for pos in r.block_positions():self.assertEqual(r[pos],result.regions[name][pos])
  neg=[v for v in data['voxels'] if v[4]==1]
  self.assertEqual([min(v[i] for v in neg) for i in range(3)],[-8,-1,6])
  self.assertEqual([max(v[i] for v in neg) for i in range(3)],[-5,0,8])
 def test_partial_simultaneous_properties(self):
  result,data,changes=transformed(self.path,{'rules':[{'source':'minecraft:stone','target':'minecraft:dirt','quantity':17},{'source':'minecraft:dirt','target':'minecraft:glass','quantity':None},{'source':'minecraft:oak_stairs','target':'minecraft:spruce_stairs','quantity':None}], 'metadata':{'Author':'Другой автор'}})
  self.assertEqual(changes[0]['changed'],17);self.assertEqual(changes[1]['changed'],95)
  self.assertEqual(result.author,'Другой автор')
  original=Schematic.load(str(self.path))
  for name,r in original.regions.items():
   for pos in r.block_positions():
    if r[pos].id=='minecraft:oak_stairs':self.assertEqual(result.regions[name][pos].properties(),r[pos].properties())
  self.assertEqual(sum(m['count'] for m in data['materials']),309)
 def test_region_scope_and_custom_tags(self):
  s=editor.read_schematic(self.path.read_bytes());s['UnknownExtension']=Compound({'value':Long(1234567)})
  self.path.write_bytes(editor.write_schematic(s))
  result,d,c=transformed(self.path,{'region':'Negative','rules':[{'source':'minecraft:stone','target':'minecraft:glass','quantity':None}]})
  self.assertEqual(c[0]['changed'],24)
  s2=editor.read_schematic((ROOT/'out.litematic').read_bytes());self.assertEqual(int(s2['UnknownExtension']['value']),1234567)
  self.assertEqual(result.regions['Main'][1,0,0].id,'minecraft:stone')
 def test_palette_growth_and_cross_word(self):
  r=Region(0,0,0,137,1,1)
  names=['stone','dirt','glass','sand','gravel','oak_planks','spruce_planks']
  for x in range(137):r[x,0,0]=BlockState('minecraft:'+names[x%len(names)])
  s=Schematic(regions={'r':r});p=ROOT/'bits.litematic';s.save(str(p))
  result,_,_=transformed(p,{'rules':[{'source':'minecraft:stone','target':'minecraft:gold_block','quantity':3}]})
  for x in range(137):self.assertEqual(result.regions['r'][x,0,0].id, 'minecraft:gold_block' if x in [0,7,14] else 'minecraft:'+names[x%7])
 def test_reject_invalid(self):
  with self.assertRaises(ValueError):editor.read_schematic(b'not nbt')
  for rules in [[{'source':'minecraft:stone','target':'minecraft:stick'}],[{'source':'minecraft:stone','target':'minecraft:glass','quantity':100000}],[{'source':'minecraft:stone','target':'minecraft:glass','quantity':1.5}]]:
   with self.assertRaises(ValueError):transformed(self.path,{'rules':rules})
 def test_tile_entity_replacement(self):
  s=editor.read_schematic(self.path.read_bytes());r=s['Regions']['Negative'];r['TileEntities']=List[Compound]([Compound({'x':Int(-3),'y':Int(-1),'z':Int(-2),'id':String('minecraft:chest')})]);self.path.write_bytes(editor.write_schematic(s))
  transformed(self.path,{'region':'Negative','rules':[{'source':'minecraft:stone','target':'minecraft:glass'}]})
  after=editor.read_schematic((ROOT/'out.litematic').read_bytes());self.assertEqual(len(after['Regions']['Negative']['TileEntities']),0)

if __name__=='__main__':unittest.main(verbosity=2)
