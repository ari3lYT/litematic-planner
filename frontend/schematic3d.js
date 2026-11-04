import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadMinecraftModels, bakeBlockModel } from './block-models.js';

export async function mountSchematic(container, data, options = {}) {
  const {pack, texture} = await loadMinecraftModels();
  const scene = new THREE.Scene();
  const dark = document.documentElement.dataset.theme !== 'light';
  scene.background = new THREE.Color(dark ? '#12151b' : '#e9edf4');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', '3D-схема. Мышь: вращение, правая кнопка: перемещение, колесо: масштаб. Стрелки: вращение, плюс и минус: масштаб, 0: весь объект.');
  canvas.tabIndex = 0;
  container.append(canvas);
  const camera = new THREE.PerspectiveCamera(42, 1, .05, 10000000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = .12;
  controls.zoomToCursor = true;
  scene.add(new THREE.HemisphereLight('#ffffff', '#68758d', 2.5));
  const light = new THREE.DirectionalLight('#ffffff', 2.1);
  light.position.set(-1, 3, 2);
  scene.add(light);
  const bounds = data.bounds;
  const center = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(.5);
  const span = new THREE.Vector3(...bounds.max).sub(new THREE.Vector3(...bounds.min));
  const radius = Math.max(span.length() / 2, 2);
  const group = new THREE.Group();
  group.position.copy(center).multiplyScalar(-1);
  scene.add(group);
  const meshes = [], resources = [], missingModels = [];
  const matrix = new THREE.Matrix4();
  let disposed = false, raf, filter = { region: -1, layer: Infinity, material: '' };
  const byPalette = new Map();
  data.voxels.forEach(v => {
    if (!byPalette.has(v[3])) byPalette.set(v[3], []);
    byPalette.get(v[3]).push(v);
  });
  for (const [pi, voxels] of byPalette) {
    const entry = data.palette[pi];
    const raw = entry.id.split(':').pop();
    const geometry = bakeBlockModel(pack, entry);
    if (!geometry) { missingModels.push(entry.id); continue; }
    const transparent = /glass|water|ice|portal/.test(raw);
    const mat = new THREE.MeshLambertMaterial({map: texture, vertexColors: true,
      transparent, opacity: /water/.test(raw) ? .8 : 1, alphaTest: .1,
      side: THREE.DoubleSide, depthWrite: !transparent});
    resources.push(mat, geometry);
    const mesh = new THREE.InstancedMesh(geometry, mat, voxels.length);
    mesh.userData = {voxels, visibleVoxels: [], entry};
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  const extent = Math.max(span.x, span.z, 10);
  const grid = new THREE.GridHelper(extent * 1.25, Math.min(100, Math.ceil(extent)), dark ? '#3b485d' : '#9daec1', dark ? '#242c3a' : '#cad2df');
  grid.position.set(0, bounds.min[1] - center.y - .1, 0);
  scene.add(grid);
  const regionBoxes = new THREE.Group();
  data.regions.forEach((r, i) => {
    const min = new THREE.Vector3(...r.min).sub(center);
    const max = min.clone().add(new THREE.Vector3(...r.size.map(Math.abs)));
    const helper = new THREE.Box3Helper(new THREE.Box3(min, max), new THREE.Color().setHSL((i * .19 + .56) % 1, .65, .65));
    regionBoxes.add(helper);
  });
  regionBoxes.visible = false;
  scene.add(regionBoxes);
  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x76a7ff);
  selection.visible = false;
  scene.add(selection);
  function update(next = {}) {
    filter = { ...filter, ...next };
    let n = 0;
    for (const mesh of meshes) {
      const { voxels, entry } = mesh.userData;
      const visible = [];
      for (const v of voxels) {
        if (filter.region >= 0 && v[4] !== filter.region || v[1] > filter.layer || filter.material && entry.id !== filter.material) continue;
        matrix.makeTranslation(v[0], v[1], v[2]);
        mesh.setMatrixAt(visible.length, matrix);
        visible.push(v);
      }
      mesh.count = visible.length;
      mesh.userData.visibleVoxels = visible;
      mesh.instanceMatrix.needsUpdate = true;
      n += visible.length;
    }
    selection.visible = false;
    options.onCount?.(n);
  }
  function view(kind = 'iso') {
    const vector = kind === 'top' ? new THREE.Vector3(.001, 1, .001) : kind === 'front' ? new THREE.Vector3(0, .12, 1) : new THREE.Vector3(1, .8, 1);
    const aspect = Math.max(.25, camera.aspect);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(21)) * Math.max(1, 1 / aspect) * 1.1;
    controls.target.set(0, 0, 0);
    camera.position.copy(vector.normalize().multiplyScalar(distance));
    camera.near = Math.max(.02, distance / 10000);
    camera.far = distance * 20 + 1000;
    camera.updateProjectionMatrix();
    controls.minDistance = .3;
    controls.maxDistance = distance * 10;
    controls.update();
  }
  const resize = new ResizeObserver(() => {
    if (disposed) return;
    const { width, height } = container.getBoundingClientRect();
    renderer.setSize(Math.max(width, 1), Math.max(height, 1));
    camera.aspect = Math.max(width, 1) / Math.max(height, 1);
    camera.updateProjectionMatrix();
  });
  resize.observe(container);
  const raycaster = new THREE.Raycaster();
  let down;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(meshes)[0];
    if (!hit) { selection.visible = false; options.onPick?.(null); return; }
    const v = hit.object.userData.visibleVoxels[hit.instanceId];
    const min = new THREE.Vector3(v[0], v[1], v[2]).sub(center);
    selection.box.set(min, min.clone().addScalar(1));
    selection.visible = true;
    options.onPick?.({ ...hit.object.userData.entry, position: v.slice(0, 3), region: data.regions[v[4]].name });
  });
  canvas.addEventListener('keydown', e => {
    if (e.key === '0') view();
    else if (['+', '=', '-'].includes(e.key)) camera.position.sub(controls.target).multiplyScalar(e.key === '-' ? 1.15 : .85).add(controls.target);
    else if (e.key.startsWith('Arrow')) {
      const delta = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(delta);
      if (e.key === 'ArrowLeft') spherical.theta -= .12;
      if (e.key === 'ArrowRight') spherical.theta += .12;
      if (e.key === 'ArrowUp') spherical.phi -= .12;
      if (e.key === 'ArrowDown') spherical.phi += .12;
      spherical.makeSafe();
      camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(controls.target));
    } else return;
    e.preventDefault(); controls.update();
  });
  function animate() { if (disposed) return; raf = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
  update();
  const rect = container.getBoundingClientRect();
  camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
  view();
  if (options.pose) {
    camera.position.fromArray(options.pose.position);
    controls.target.fromArray(options.pose.target);
    controls.update();
  }
  animate();
  return {
    update, view,
    modelInfo: {version:pack.version, missing:[...new Set(missingModels)]},
    pose() { return {position: camera.position.toArray(), target: controls.target.toArray()}; },
    boxes(value) { regionBoxes.visible = value; },
    theme(dark) { scene.background.set(dark ? '#12151b' : '#e9edf4'); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); resize.disconnect(); controls.dispose();
      for (const m of meshes) m.dispose();
      resources.forEach(x => x.dispose());
      for (const obj of [...regionBoxes.children, grid, selection]) { obj.geometry?.dispose(); obj.material?.dispose(); }
      renderer.dispose(); canvas.remove();
    },
  };
}
