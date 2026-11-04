import * as THREE from 'three';
import {loadMinecraftModels,bakeBlockModel} from './block-models.js';
const status=document.querySelector('#status');
document.querySelector('#build').onclick=async()=>{
 try {
  status.textContent='Загружаем модели…';
  const {pack,texture}=await loadMinecraftModels();
  const entries=Object.entries(pack.defaults),tile=64,cols=48,rows=Math.ceil(entries.length/cols);
  const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(tile*cols,tile*rows);renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.setScissorTest(true);
  const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight('#ffffff','#8a8f9a',2.8));const sun=new THREE.DirectionalLight('#ffffff',2.4);sun.position.set(-3,8,5);scene.add(sun);
  const camera=new THREE.OrthographicCamera(-.9,.9,.9,-.9,.01,30);camera.position.set(4,3.3,5);camera.lookAt(0,0,0);
  const material=new THREE.MeshLambertMaterial({map:texture,vertexColors:true,alphaTest:.12,side:THREE.DoubleSide});
  const index={width:cols*tile,height:rows*tile,tile,blocks:{}};
  for(let i=0;i<entries.length;i++){
   const [raw,properties]=entries[i],id='minecraft:'+raw,geometry=bakeBlockModel(pack,{id,properties});
   const x=(i%cols)*tile,y=Math.floor(i/cols)*tile;
   renderer.setViewport(x,index.height-y-tile,tile,tile);renderer.setScissor(x,index.height-y-tile,tile,tile);renderer.clear();
   if(geometry){
    const mesh=new THREE.Mesh(geometry,material),bounds=geometry.boundingBox,center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),scale=.95/Math.max(size.x,size.y,size.z,1);
    mesh.position.copy(center).multiplyScalar(-scale);mesh.scale.setScalar(scale);scene.add(mesh);renderer.render(scene,camera);scene.remove(mesh);geometry.dispose();index.blocks[id]=[x,y];
   }
   if(i%32===0){status.textContent=`Рендер ${i} / ${entries.length}`;await new Promise(requestAnimationFrame);}
  }
  const blob=await new Promise(resolve=>renderer.domElement.toBlob(resolve,'image/png'));
  let result=await fetch('/save-icons',{method:'POST',body:blob});if(!result.ok)throw new Error('Не удалось сохранить иконки');
  result=await fetch('/save-index',{method:'POST',body:JSON.stringify(index)});if(!result.ok)throw new Error('Не удалось сохранить индекс');
  renderer.dispose();material.dispose();status.textContent='Готово: '+Object.keys(index.blocks).length+' иконок';
 }catch(error){status.textContent='Ошибка: '+error.message;}
};
