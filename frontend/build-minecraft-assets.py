"""Prepare vanilla block models/atlas from a locally installed Java client."""
import gzip, hashlib, io, json, math, sys
from pathlib import Path
from zipfile import ZipFile
from PIL import Image
jar=Path(sys.argv[1]);output=Path(__file__).resolve().parent.parent/'static/minecraft'
output.mkdir(parents=True,exist_ok=True)
with ZipFile(jar) as archive:
 names=set(archive.namelist()); prefix='assets/minecraft/'
 states={Path(n).stem:json.loads(archive.read(n)) for n in names if n.startswith(prefix+'blockstates/') and n.endswith('.json')}
 raw_models={n[len(prefix+'models/'): -5]:json.loads(archive.read(n)) for n in names if n.startswith(prefix+'models/block/') and n.endswith('.json')}
 def normalize(name):return name.removeprefix('minecraft:')
 resolved={}
 def resolve(name,seen=()):
  name=normalize(name)
  if name in resolved:return resolved[name]
  if name in seen or name not in raw_models:return {}
  raw=raw_models[name];parent=resolve(raw.get('parent',''),seen+(name,))
  m={**parent,**raw,'textures':{**parent.get('textures',{}),**raw.get('textures',{})}}
  m.pop('parent',None);m.pop('display',None);m.pop('gui_light',None)
  resolved[name]=m;return m
 for name in raw_models:resolve(name)
 textures={}
 for name in sorted(names):
  relative=name[len(prefix+'textures/'):-4]
  if not name.startswith(prefix+'textures/') or not name.endswith('.png'):continue
  if not (relative.startswith('block/') or relative.startswith(('entity/chest/','entity/shulker/','entity/bed/','entity/signs/','entity/banner/','entity/decorated_pot/','entity/conduit/','entity/player/wide/')) or relative in ['entity/banner_base','entity/skeleton/skeleton','entity/skeleton/wither_skeleton','entity/zombie/zombie','entity/creeper/creeper','entity/bell/bell_body','entity/enchanting_table_book','entity/end_portal']):continue
  im=Image.open(io.BytesIO(archive.read(name))).convert('RGBA')
  w,h=im.size
  # Block animations are vertical strips; entity textures use their full sheet.
  if relative.startswith('block/') and h>w and h%w==0:im=im.crop((0,0,w,w))
  textures[relative]=im
 cell,tile,pad,cols=68,64,2,60
 width=4096;height=2**math.ceil(math.log2(math.ceil(len(textures)/cols)*cell))
 atlas=Image.new('RGBA',(width,height));uv={}
 for i,(name,im) in enumerate(textures.items()):
  x,y=(i%cols)*cell+pad,(i//cols)*cell+pad
  tex=im.resize((tile,tile),Image.Resampling.NEAREST)
  atlas.paste(tex,(x,y));atlas.paste(tex.crop((0,0,1,tile)).resize((pad,tile)),(x-pad,y));atlas.paste(tex.crop((tile-1,0,tile,tile)).resize((pad,tile)),(x+tile,y))
  atlas.paste(tex.crop((0,0,tile,1)).resize((tile,pad)),(x,y-pad));atlas.paste(tex.crop((0,tile-1,tile,tile)).resize((tile,pad)),(x,y+tile))
  uv[name]=[x,y,tile,tile,im.width,im.height]
 atlas.save(output/'atlas.png',optimize=True)
 version=json.loads(archive.read('version.json'))['id']
 defaults=json.loads((output.parent.parent/'data/editor-blocks.json').read_text())
 pack={'defaults':{k.removeprefix('minecraft:'):v['default'] for k,v in defaults.items()},'version':version,'atlas':{'width':width,'height':height,'textures':uv},'states':states,'models':resolved}
 encoded=json.dumps(pack,separators=(',',':'),ensure_ascii=False).encode()
 (output/'models.json.gz').write_bytes(gzip.compress(encoded,compresslevel=9,mtime=0))
 (output/'source.json').write_text(json.dumps({'version':version,'source':'Minecraft Java client assets','client_sha256':hashlib.sha256(jar.read_bytes()).hexdigest(),'models':len(resolved),'blockstates':len(states),'textures':len(textures)},indent=2)+'\n')
 empty=[]
 for name,bs in states.items():
  variants=list(bs.get('variants',{}).values())+[p['apply'] for p in bs.get('multipart',[])]
  models=[v[0] if isinstance(v,list) else v for v in variants]
  if models and all(not resolve(v['model']).get('elements') for v in models):empty.append(name)
 print(json.dumps({'version':version,'models':len(resolved),'states':len(states),'textures':len(textures),'atlas':[width,height],'empty':empty},ensure_ascii=False))
