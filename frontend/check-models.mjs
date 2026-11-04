import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {bakeBlockModel,resolveStateModels} from './block-models.js';
const pack=JSON.parse(zlib.gunzipSync(fs.readFileSync('../static/minecraft/models.json.gz')));
function bake(id,properties={}){const g=bakeBlockModel(pack,{id:'minecraft:'+id,properties});assert(g,id+' has no geometry');return g;}
function volume(g){const p=g.attributes.position.array;let v=0;for(let i=0;i<p.length;i+=9)v+=(p[i]*(p[i+4]*p[i+8]-p[i+5]*p[i+7])-p[i+1]*(p[i+3]*p[i+8]-p[i+5]*p[i+6])+p[i+2]*(p[i+3]*p[i+7]-p[i+4]*p[i+6]))/6;return Math.abs(v);}
assert(Math.abs(volume(bake('stone'))-1)<1e-5);
for (const [shape,area] of [['straight',.5],['inner_left',.75],['outer_right',.25]]) {
 const g=bake('oak_stairs',{facing:'east',half:'bottom',shape,waterlogged:'false'});
 const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
 let high=0;for(let x=0;x<4;x++)for(let z=0;z<4;z++){
  const hit=new THREE.Raycaster(new THREE.Vector3((x+.5)/4,2,(z+.5)/4),new THREE.Vector3(0,-1,0)).intersectObject(mesh)[0];
  assert(hit,shape+' has a hole');if(hit.point.y>.9)high++;
 }
 assert.equal(high/16,area,shape+' top silhouette');
}
const slab=bake('oak_slab',{type:'top',waterlogged:'false'});assert.equal(slab.boundingBox.min.y,.5);assert.equal(slab.boundingBox.max.y,1);
const connected=resolveStateModels(pack,{id:'minecraft:oak_fence',properties:{east:'true',west:'true',north:'false',south:'false',waterlogged:'false'}});assert.equal(connected.length,3);
const openDoor=bake('oak_door',{facing:'north',half:'lower',hinge:'left',open:'true',powered:'false'});assert(Math.min(openDoor.boundingBox.max.x-openDoor.boundingBox.min.x,openDoor.boundingBox.max.z-openDoor.boundingBox.min.z)<.2);
const hopper=bake('hopper',{facing:'east',enabled:'true'});assert(hopper.attributes.position.count>36);
const chest=bake('chest',{facing:'north',type:'single'});assert.equal(chest.boundingBox.max.y,14/16);assert.equal(chest.boundingBox.min.x,1/16);
const grass=bake('grass_block',{snowy:'false'});assert([...grass.attributes.color.array].some(v=>v<.9));
let supported=0,missing=[];for(const [id,properties] of Object.entries(pack.defaults)){const g=bakeBlockModel(pack,{id:'minecraft:'+id,properties});if(g){supported++;g.dispose();}else missing.push(id);}
console.log(JSON.stringify({version:pack.version,supported,missing,verified:['stairs: straight/inner/outer silhouettes','top slab','multipart fence','open door','hopper','chest body/lid/lock','face tint']}));
