import * as THREE from 'three';

let packPromise;
export function loadMinecraftModels() {
  if (!packPromise) packPromise = Promise.all([
    fetch('./mc-assets/models.json?v=8').then(r => { if (!r.ok) throw new Error('Не удалось загрузить модели Minecraft'); return r.json(); }),
    new THREE.TextureLoader().loadAsync('./mc-assets/atlas.png?v=8'),
  ]).then(([pack, texture]) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return {pack, texture};
  }).catch(error => {packPromise = null; throw error;});
  return packPromise;
}
const strip = value => value.replace(/^minecraft:/, '');
const radians = degrees => degrees * Math.PI / 180;
function matches(condition, properties) {
  if (!condition) return true;
  return Object.entries(condition).every(([key, value]) => {
    if (key === 'OR') return value.some(c => matches(c, properties));
    if (key === 'AND') return value.every(c => matches(c, properties));
    return String(value).split('|').includes(String(properties[key]));
  });
}
export function resolveStateModels(pack, entry) {
  if (!entry.id.startsWith('minecraft:')) return [];
  const raw = strip(entry.id), state = pack.states[raw];
  if (!state) return [];
  const props = {...pack.defaults?.[raw], ...entry.properties};
  const choose = value => Array.isArray(value) ? value[0] : value;
  const selected = [];
  for (const [key, value] of Object.entries(state.variants || {})) {
    const expected = Object.fromEntries(key ? key.split(',').map(v => v.split('=')) : []);
    if (matches(expected, props)) { selected.push(choose(value)); break; }
  }
  for (const part of state.multipart || []) if (matches(part.when, props)) selected.push(choose(part.apply));
  return selected.map(v => ({...v, definition:pack.models[strip(v.model)]})).filter(v => v.definition);
}
const faceNormals = {north:[0,0,-1], south:[0,0,1], west:[-1,0,0], east:[1,0,0], up:[0,1,0], down:[0,-1,0]};
function facePoints(name, from, to) {
  const [x,y,z]=from, [X,Y,Z]=to;
  return {
    north:[[X,Y,z],[X,y,z],[x,y,z],[x,Y,z]],
    south:[[x,Y,Z],[x,y,Z],[X,y,Z],[X,Y,Z]],
    east:[[X,Y,Z],[X,y,Z],[X,y,z],[X,Y,z]],
    west:[[x,Y,z],[x,y,z],[x,y,Z],[x,Y,Z]],
    up:[[x,Y,z],[x,Y,Z],[X,Y,Z],[X,Y,z]],
    down:[[x,y,Z],[x,y,z],[X,y,z],[X,y,Z]],
  }[name];
}
function projectedUV(face, p) {
  const [x,y,z]=p;
  return {north:[16-x,16-y],south:[x,16-y],east:[16-z,16-y],west:[z,16-y],up:[x,z],down:[x,16-z]}[face];
}
function directionOf(vector) {
  return Object.keys(faceNormals).find(name => new THREE.Vector3(...faceNormals[name]).dot(vector) > .99);
}
function defaultUV(face, from, to) {
  const [x,y,z]=from,[X,Y,Z]=to;
  return {north:[16-X,16-Y,16-x,16-y],south:[x,16-Y,X,16-y],east:[16-Z,16-Y,16-z,16-y],west:[z,16-Y,Z,16-y],up:[x,z,X,Z],down:[x,16-Z,X,16-z]}[face];
}
function tintFor(entry) {
  const raw=strip(entry.id), p=entry.properties || {};
  if (raw === 'redstone_wire') {
    const power=Number(p.power || 0)/15;
    return new THREE.Color().setRGB(power*.6+.4,Math.max(0,power*power*.7-.5),Math.max(0,power*power*.6-.7));
  }
  if (/spruce_leaves/.test(raw)) return new THREE.Color('#619961');
  if (/birch_leaves/.test(raw)) return new THREE.Color('#80a755');
  if (/lily_pad/.test(raw)) return new THREE.Color('#208030');
  if (/water|bubble_column/.test(raw)) return new THREE.Color('#3f76e4');
  if (/leaves|vine|grass|fern|sugar_cane|stem|moss/.test(raw)) return new THREE.Color('#79ad42');
  return new THREE.Color('#ffffff');
}
function resolvedTexture(reference, textures) {
  let value=reference;
  const visited=new Set();
  for(let depth=0;depth<32;depth++) {
    if (value && typeof value === 'object') value=value.sprite || value.texture;
    if (typeof value !== 'string') return null;
    if (!value.startsWith('#') && !textures[value]) return strip(value);
    if (visited.has(value)) return null;
    visited.add(value); value=textures[value.startsWith('#') ? value.slice(1) : value];
  }
  return null;
}
function entityBox(from, to, texture, offset=[0,0], textureSize=[64,64]) {
  const [u,v]=offset,w=to[0]-from[0],h=to[1]-from[1],d=to[2]-from[2];
  const uv={west:[u,v+d,u+d,v+d+h],north:[u+d,v+d,u+d+w,v+d+h],east:[u+d+w,v+d,u+2*d+w,v+d+h],south:[u+2*d+w,v+d,u+2*d+2*w,v+d+h],up:[u+d,v,u+d+w,v+d],down:[u+d+w,v,u+d+2*w,v+d]};
  return {from,to,faces:Object.fromEntries(Object.entries(uv).map(([f,values]) => [f,{texture,uv:values.map((n,i)=>n/textureSize[i%2]*16)}]))};
}
function specialModel(pack, entry) {
  const raw=strip(entry.id),p=entry.properties || {};
  const model = (elements, y=0, x=0) => [{definition:{elements,textures:{}},y,x}];
  if (/^(water|lava|bubble_column)$/.test(raw)) {
    const fluid=raw==='lava'?'lava':'water',height=Number(p.level || 0)>=8?16:Math.max(2,(8-Number(p.level || 0))*16/9);
    const elem={from:[0,0,0],to:[16,height,16],faces:Object.fromEntries(Object.keys(faceNormals).map(f=>[f,{texture:'block/'+fluid+'_still',tintindex:fluid==='water'?0:undefined}]))};
    return model([elem]);
  }
  if (/chest$/.test(raw)) {
    let kind=raw==='ender_chest'?'ender':raw==='trapped_chest'?'trapped':'normal';
    if (/copper/.test(raw)) kind=raw.includes('oxidized')?'copper_oxidized':raw.includes('weathered')?'copper_weathered':raw.includes('exposed')?'copper_exposed':'copper';
    const type=p.type || 'single',texture='entity/chest/'+kind+(type==='single'?'':'_'+type);
    const left=type==='left'?0:1,right=type==='right'?16:15;
    const parts=[entityBox([left,0,1],[right,10,15],texture,[0,19]),entityBox([left,9,1],[right,14,15],texture,[0,0])];
    if(type==='single') parts.push(entityBox([7,7,15],[9,11,16],texture,[0,0]));
    else parts.push(entityBox(type==='left'?[0,7,15]:[15,7,15],type==='left'?[1,11,16]:[16,11,16],texture,[0,0]));
    return model(parts,{south:0,west:90,north:180,east:270}[p.facing] || 0);
  }
  if (/shulker_box$/.test(raw)) {
    const color=raw==='shulker_box'?'shulker': 'shulker_'+raw.replace('_shulker_box','');
    const texture='entity/shulker/'+color;
    const parts=[entityBox([0,0,0],[16,8,16],texture,[0,28]),entityBox([0,4,0],[16,16,16],texture,[0,0])];
    const direction={up:[0,0],down:[0,180],north:[0,90],south:[180,90],east:[90,90],west:[270,90]}[p.facing] || [0,0];
    return model(parts,...direction);
  }
  if (raw==='conduit') return model([entityBox([5,5,5],[11,11,11],'entity/conduit/base',[0,0],[32,16])]);
  if (/banner$/.test(raw)) {
    const color=raw.replace('_wall_banner','').replace('_banner','');
    const colors={white:'#f9fffe',orange:'#f9801d',magenta:'#c74ebd',light_blue:'#3ab3da',yellow:'#fed83d',lime:'#80c71f',pink:'#f38baa',gray:'#474f52',light_gray:'#9d9d97',cyan:'#169c9c',purple:'#8932b8',blue:'#3c44aa',brown:'#835432',green:'#5e7c16',red:'#b02e26',black:'#1d1d21'};
    const wall=raw.includes('_wall_');
    const parts=[entityBox([1,wall?-4:8,7],[15,wall?16:28,8],'entity/banner/base',[0,0])];
    parts[0].color=colors[color] || '#ffffff';
    if(!wall)parts.push(entityBox([7,0,7],[9,28,9],'block/oak_planks',[0,0],[16,16]));
    return model(parts,wall?({south:0,west:90,north:180,east:270}[p.facing] || 0):Number(p.rotation || 0)*22.5);
  }
  if (/(?:head|skull)$/.test(raw) && !/piston/.test(raw)) {
    const type=raw.replace('_wall','');
    const textures={skeleton_skull:'entity/skeleton/skeleton',wither_skeleton_skull:'entity/skeleton/wither_skeleton',zombie_head:'entity/zombie/zombie',creeper_head:'entity/creeper/creeper',player_head:'entity/player/wide/steve'};
    const texture=textures[type];if(!texture)return [];
    const wall=raw.includes('_wall_'),parts=[entityBox([4,wall?4:0,4],[12,wall?12:8,12],texture,[0,0],[64,type==='creeper_head'?32:64])];
    return model(parts,wall?({south:0,west:90,north:180,east:270}[p.facing] || 0):Number(p.rotation || 0)*22.5);
  }
  return [];
}
export function bakeBlockModel(pack, entry) {
  const raw=strip(entry.id);
  let models=resolveStateModels(pack,entry);
  if (!models.some(m=>m.definition.elements?.length)) models=specialModel(pack,entry);
  const positions=[],uvs=[],colors=[],normals=[];
  const tint=tintFor(entry);
  for (const model of models) {
    const variant=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(radians(-(model.x || 0)),radians(-(model.y || 0)),0,'YXZ'));
    for(const element of model.definition.elements || []) {
      const from=element.from,to=element.to,rotation=element.rotation;
      const elementMatrix=new THREE.Matrix4();
      if(rotation) {
        const origin=new THREE.Vector3(...(rotation.origin || [8,8,8]));
        const r=new THREE.Matrix4();
        if(rotation.axis) r.makeRotationAxis(new THREE.Vector3(...{x:[1,0,0],y:[0,1,0],z:[0,0,1]}[rotation.axis]),radians(rotation.angle));
        else r.makeRotationFromEuler(new THREE.Euler(radians(rotation.x||0),radians(rotation.y||0),radians(rotation.z||0),'XYZ'));
        if(rotation.rescale) {
          const scale=1/Math.cos(radians(rotation.angle));
          r.scale(new THREE.Vector3(rotation.axis==='x'?1:scale,rotation.axis==='y'?1:scale,rotation.axis==='z'?1:scale));
        }
        elementMatrix.makeTranslation(...origin.toArray()).multiply(r).multiply(new THREE.Matrix4().makeTranslation(...origin.clone().multiplyScalar(-1).toArray()));
      }
      for(const [face,definition] of Object.entries(element.faces || {})) {
        const textureName=resolvedTexture(definition.texture,model.definition.textures || {}),tile=pack.atlas.textures[textureName];
        if(!tile)continue;
        const corners=facePoints(face,from,to);if(!corners)continue;
        const transformed=corners.map(p=>new THREE.Vector3(...p).applyMatrix4(elementMatrix).subScalar(8).applyMatrix4(variant).addScalar(8));
        const normal=new THREE.Vector3(...faceNormals[face]).transformDirection(elementMatrix).transformDirection(variant);
        const worldFace=directionOf(normal);
        const uv=definition.uv || defaultUV(face,from,to);
        let coords=[[uv[0],uv[1]],[uv[0],uv[3]],[uv[2],uv[3]],[uv[2],uv[1]]];
        if(model.uvlock && worldFace && !rotation) coords=transformed.map(p=>projectedUV(worldFace,p.toArray()));
        if(definition.rotation) {
          const shift=((definition.rotation/90)%4+4)%4;
          coords=coords.map((_,i)=>coords[(i+shift)%4]);
        }
        const color=element.color?new THREE.Color(element.color):definition.tintindex!==undefined?tint:new THREE.Color('#ffffff');
        for(const index of [0,1,2,0,2,3]) {
          const vertex=transformed[index];positions.push(vertex.x/16,vertex.y/16,vertex.z/16);
          const [u,v]=coords[index];
          uvs.push((tile[0]+u/16*tile[2])/pack.atlas.width,1-(tile[1]+v/16*tile[3])/pack.atlas.height);
          normals.push(normal.x,normal.y,normal.z);colors.push(color.r,color.g,color.b);
        }
      }
    }
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={models:models.map(m=>m.model || 'entity'),id:entry.id};
  return geometry;
}
