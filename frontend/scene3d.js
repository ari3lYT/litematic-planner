import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function mountChestScene(container, options) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e8ede3");
  scene.fog = new THREE.Fog("#e8ede3", 24, 52);
  const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 90);
  camera.position.set(7, 8, 10);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor("#e8ede3");
  renderer.domElement.setAttribute(
    "aria-label",
    "Трёхмерный склад. Нажмите на сундук, чтобы открыть. В режиме расстановки нажмите на свободную клетку.",
  );
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);
  const overlay = document.createElement("div");
  overlay.className = "world-labels";
  container.appendChild(overlay);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.minDistance = 2.3;
  controls.maxDistance = 35;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minPolarAngle = 0.12;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.update();
  scene.add(new THREE.HemisphereLight("#fffbe7", "#71846d", 2.3));
  const sun = new THREE.DirectionalLight("#fff1d0", 3.1);
  sun.position.set(5, 13, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -17,
    right: 17,
    top: 17,
    bottom: -17,
    near: 1,
    far: 45,
  });
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  function woodTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const c = canvas.getContext("2d");
    c.fillStyle = "#b98138";
    c.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 16) {
      c.fillStyle = y % 32 ? "#b77c31" : "#c48b40";
      c.fillRect(0, y, 128, 15);
      c.fillStyle = "#946022";
      c.fillRect(0, y + 14, 128, 2);
      for (let x = 0; x < 128; x += 8) {
        c.fillStyle = (x + y) % 24 ? "#a46d2a" : "#d59b4c";
        c.globalAlpha = 0.35;
        c.fillRect(x + ((y / 16) % 3) * 2, y + 5 + (x % 3), 7, 2);
        c.globalAlpha = 1;
      }
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    return t;
  }
  const wood = woodTexture();
  const materials = {
    wood: new THREE.MeshStandardMaterial({ map: wood, roughness: 1 }),
    trim: new THREE.MeshStandardMaterial({ color: "#593b1f", roughness: 1 }),
    inner: new THREE.MeshStandardMaterial({ color: "#332719", roughness: 1 }),
    metal: new THREE.MeshStandardMaterial({
      color: "#cbd0c5",
      roughness: 0.5,
      metalness: 0.2,
    }),
    frame: new THREE.MeshStandardMaterial({ color: "#8b5526", roughness: 1 }),
    floor: new THREE.MeshStandardMaterial({ color: "#b8c5aa", roughness: 1 }),
    edge: new THREE.MeshStandardMaterial({ color: "#788d6b", roughness: 1 }),
  };
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(32, 0.18, 32),
    materials.floor,
  );
  floor.position.y = -0.11;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(32, 32, "#819474", "#a1b491");
  grid.position.y = -0.011;
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  scene.add(grid);
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(32.15, 0.25, 32.15),
    materials.edge,
  );
  base.position.y = -0.31;
  scene.add(base);
  const ray = new THREE.Raycaster(),
    pointer = new THREE.Vector2(),
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let data = [],
    selected = null,
    highlight = null,
    mode = "select",
    kind = "single",
    rotation = 0,
    level = 0,
    hoverCell = null,
    ghost = null,
    raf = 0,
    disposed = false,
    lastTime = 0,
    showLabels = true;
  const groups = new Map(),
    labels = new Map(),
    textures = new Map();
  function theme(dark) {
    const bg = dark ? "#14161a" : "#f0f1f4";
    scene.background.set(bg);
    scene.fog.color.set(bg);
    renderer.setClearColor(bg);
    materials.floor.color.set(dark ? "#22262f" : "#cfd4dd");
    materials.edge.color.set(dark ? "#171a21" : "#b2bac7");
    const color = new THREE.Color(dark ? "#596174" : "#8793a7"),
      attribute = grid.geometry.attributes.color;
    for (let i = 0; i < attribute.count; i++)
      attribute.setXYZ(i, color.r, color.g, color.b);
    attribute.needsUpdate = true;
    grid.material.opacity = dark ? 0.3 : 0.35;
    requestRender();
  }
  const loader = new THREE.TextureLoader();
  function texture(block) {
    if (!textures.has(block)) {
      const t = loader.load(
        options.icon(block),
        () => requestRender(),
        undefined,
        () => requestRender(),
      );
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      textures.set(block, t);
    }
    return textures.get(block);
  }
  function box(parent, w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function privateMat(mat, map = false) {
    mat.userData.private = true;
    mat.userData.privateMap = map;
    return mat;
  }
  function signTexture(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const c = canvas.getContext("2d");
    c.fillStyle = "#c69a5d";
    c.fillRect(0, 0, 512, 256);
    c.strokeStyle = "#674322";
    c.lineWidth = 13;
    c.strokeRect(6, 6, 500, 244);
    for (let y = 64; y < 256; y += 64) {
      c.fillStyle = "#a7773f";
      c.globalAlpha = 0.5;
      c.fillRect(9, y, 494, 3);
      c.globalAlpha = 1;
    }
    c.fillStyle = "#302719";
    c.font = "bold 37px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const words = text.replace(/\n/g, " ").split(/\s+/),
      lines = [];
    let line = "";
    for (const word of words) {
      if (c.measureText((line + " " + word).trim()).width > 450 && line) {
        lines.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    if (line) lines.push(line);
    const used = lines.slice(0, 3);
    used.forEach((s, i) =>
      c.fillText(s, 256, 128 + (i - (used.length - 1) / 2) * 51, 450),
    );
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function buildChest(chest, preview = false) {
    const group = new THREE.Group(),
      wide = chest.kind === "double",
      w = wide ? 1.88 : 0.88;
    group.userData.chest = chest;
    group.userData.preview = preview;
    box(group, w, 0.08, 0.88, 0, 0.06, 0, materials.trim);
    box(group, w, 0.56, 0.07, 0, 0.38, -0.405, materials.wood);
    box(group, w, 0.56, 0.07, 0, 0.38, 0.405, materials.wood);
    box(group, 0.07, 0.56, 0.75, -w / 2 + 0.035, 0.38, 0, materials.wood);
    box(group, 0.07, 0.56, 0.75, w / 2 - 0.035, 0.38, 0, materials.wood);
    box(group, w - 0.12, 0.06, 0.75, 0, 0.12, 0, materials.inner);
    for (const x of [-w / 2 + 0.04, w / 2 - 0.04])
      for (const z of [-0.4, 0.4])
        box(group, 0.065, 0.64, 0.065, x, 0.36, z, materials.trim);
    box(group, w, 0.045, 0.91, 0, 0.65, 0, materials.trim);
    const hinge = new THREE.Group();
    hinge.position.set(0, 0.66, -0.44);
    group.add(hinge);
    box(hinge, w, 0.22, 0.88, 0, 0.11, 0.44, materials.wood);
    box(hinge, w, 0.04, 0.91, 0, 0.01, 0.44, materials.trim);
    box(hinge, w, 0.035, 0.91, 0, 0.225, 0.44, materials.trim);
    box(hinge, 0.11, 0.18, 0.045, 0, 0.015, 0.91, materials.metal);
    group.userData.hinge = hinge;
    if (!preview) {
      let block = chest.label_material;
      if (!block && chest.slots?.length) {
        const sums = new Map();
        for (const s of chest.slots) {
          const m = options.material(s.material_id);
          if (m) sums.set(m.block_id, (sums.get(m.block_id) || 0) + s.quantity);
        }
        block = [...sums].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      }
      const hasFrame = ["frame", "both"].includes(chest.label_mode),
        hasSign = ["sign", "both"].includes(chest.label_mode);
      if (hasFrame) {
        const fx = hasSign ? (wide ? -0.43 : -0.23) : 0;
        box(group, 0.36, 0.36, 0.04, fx, 0.35, 0.475, materials.frame);
        box(group, 0.29, 0.29, 0.045, fx, 0.35, 0.498, materials.inner);
        if (block) {
          const mat = privateMat(
            new THREE.MeshBasicMaterial({
              map: texture(block),
              transparent: true,
              side: THREE.DoubleSide,
            }),
          );
          const image = new THREE.Mesh(
            new THREE.PlaneGeometry(0.255, 0.255),
            mat,
          );
          image.position.set(fx, 0.35, 0.527);
          group.add(image);
        }
      }
      if (hasSign) {
        const tex = signTexture(chest.sign_text || chest.name),
          mat = privateMat(new THREE.MeshBasicMaterial({ map: tex }), true),
          width = hasFrame ? (wide ? 0.91 : 0.4) : Math.min(w - 0.1, 1.1),
          sx = hasFrame ? (wide ? 0.23 : 0.2) : 0;
        const sign = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.27, 0.04),
          mat,
        );
        sign.position.set(sx, 0.33, 0.484);
        group.add(sign);
      }
    }
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 0.07, 0.94, 0.94)),
      new THREE.LineBasicMaterial({
        color: "#8db7ff",
        transparent: true,
        opacity: 0.95,
      }),
    );
    outline.position.y = 0.47;
    outline.visible = preview;
    group.add(outline);
    group.userData.outline = outline;
    group.traverse((o) => {
      o.userData.chestId = chest.id;
      if (preview && o.isMesh) {
        o.material = privateMat(
          new THREE.MeshBasicMaterial({
            color: "#bddd90",
            transparent: true,
            opacity: 0.38,
            depthWrite: false,
          }),
        );
        o.castShadow = false;
      }
    });
    position(group, chest);
    return group;
  }
  function size(chest) {
    return chest.kind === "double"
      ? chest.rotation % 2
        ? [1, 2]
        : [2, 1]
      : [1, 1];
  }
  function position(group, chest) {
    const [w, d] = size(chest);
    group.position.set(chest.x + w / 2, chest.y, chest.z + d / 2);
    group.rotation.y = (chest.rotation * Math.PI) / 2;
  }
  function removeGroup(group) {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m?.userData?.private) {
          if (m.userData.privateMap) m.map?.dispose();
          m.dispose();
        } else if (o.isLineSegments) m?.dispose();
      }
    });
    scene.remove(group);
  }
  function label(chest) {
    let b = labels.get(chest.id);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "world-chest-label";
      b.dataset.chestId = chest.id;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onSelect(chest.id);
      });
      overlay.appendChild(b);
      labels.set(chest.id, b);
    }
    const total = (chest.slots || []).reduce((n, s) => n + s.quantity, 0);
    b.textContent =
      chest.name +
      " · " +
      (chest.slots?.length || 0) +
      "/" +
      (chest.kind === "double" ? 54 : 27);
    b.title = chest.name + " — " + total + " предметов";
    b.setAttribute("aria-label", "Открыть сундук " + chest.name);
  }
  function update(next) {
    data = next.chests || [];
    selected = next.selected ?? null;
    highlight = next.highlight ?? null;
    showLabels = next.showLabels !== false;
    const keys = new Set(data.map((c) => c.id));
    for (const [id, g] of groups) {
      if (!keys.has(id)) {
        removeGroup(g);
        groups.delete(id);
        labels.get(id)?.remove();
        labels.delete(id);
      }
    }
    for (const c of data) {
      const signature = JSON.stringify(c);
      let g = groups.get(c.id);
      if (!g || g.userData.signature !== signature) {
        if (g) removeGroup(g);
        g = buildChest(c);
        g.userData.signature = signature;
        scene.add(g);
        groups.set(c.id, g);
      }
      const has =
        highlight &&
        (c.slots || []).some(
          (s) => options.material(s.material_id)?.block_id === highlight,
        );
      g.userData.outline.visible = c.id === selected || !!has;
      g.userData.outline.material.color.set(has ? "#f5cf69" : "#8db7ff");
      label(c);
    }
    renderer.domElement.dataset.chestCount = data.length;
    renderer.domElement.dataset.frameCount = data.filter((c) =>
      ["frame", "both"].includes(c.label_mode),
    ).length;
    renderer.domElement.dataset.signCount = data.filter((c) =>
      ["sign", "both"].includes(c.label_mode),
    ).length;
    requestRender();
  }
  function rayAt(event) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - r.left) / r.width) * 2 - 1,
      (-(event.clientY - r.top) / r.height) * 2 + 1,
    );
    ray.setFromCamera(pointer, camera);
  }
  function pick(event) {
    rayAt(event);
    return (
      ray
        .intersectObjects([...groups.values()], true)
        .find((hit) => hit.object.userData.chestId)?.object.userData.chestId ||
      null
    );
  }
  function cellAt(event) {
    rayAt(event);
    plane.constant = -level;
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, p)
      ? { x: Math.floor(p.x), y: level, z: Math.floor(p.z) }
      : null;
  }
  function canPlace(chest) {
    const [w, d] = size(chest),
      cells = [];
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++)
        cells.push([chest.x + x, chest.y, chest.z + z]);
    if (cells.some(([x, y, z]) => x < -16 || x > 15 || z < -16 || z > 15))
      return false;
    const occ = new Set();
    for (const c of data) {
      if (mode === "move" && c.id === selected) continue;
      const [cw, cd] = size(c);
      for (let x = 0; x < cw; x++)
        for (let z = 0; z < cd; z++) occ.add([c.x + x, c.y, c.z + z].join(","));
    }
    return cells.every(
      ([x, y, z]) =>
        !occ.has([x, y, z].join(",")) &&
        (y === 0 || occ.has([x, y - 1, z].join(","))),
    );
  }
  function updateGhost(cell) {
    hoverCell = cell;
    if (ghost) {
      removeGroup(ghost);
      ghost = null;
    }
    if (!cell || !["place", "move"].includes(mode)) return;
    const old = data.find((c) => c.id === selected);
    const candidate = {
      id: "ghost",
      ...cell,
      kind: mode === "move" && old ? old.kind : kind,
      rotation,
    };
    ghost = buildChest(candidate, true);
    const valid = canPlace(candidate);
    ghost.traverse((o) => {
      if (o.isMesh) o.material.color.set(valid ? "#bfe890" : "#ef9d82");
    });
    ghost.userData.valid = valid;
    scene.add(ghost);
    requestRender();
  }
  let down = null;
  const pointers = new Set();
  function pointerDown(e) {
    pointers.add(e.pointerId);
    down = { x: e.clientX, y: e.clientY, multi: pointers.size > 1 };
  }
  function pointerMove(e) {
    if (down && pointers.size > 1) down.multi = true;
    if (mode === "place" || mode === "move") updateGhost(cellAt(e));
  }
  async function pointerUp(e) {
    pointers.delete(e.pointerId);
    const start = down;
    down = null;
    if (
      !start ||
      start.multi ||
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 ||
      e.button > 0
    )
      return;
    if (["place", "move"].includes(mode)) {
      const cell = cellAt(e);
      if (cell)
        options.onPlace(
          {
            ...cell,
            rotation,
            kind:
              mode === "move"
                ? data.find((c) => c.id === selected)?.kind || kind
                : kind,
          },
          mode,
        );
      return;
    }
    const id = pick(e);
    if (id) options.onSelect(id);
  }
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    down = null;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    const id = pick(e);
    if (id)
      options.onDrop(
        id,
        e.dataTransfer.getData("application/x-sklad-slot"),
        e.dataTransfer.getData("application/x-sklad-material"),
      );
  });
  function setMode(next) {
    mode = next.mode || "select";
    kind = next.kind || "single";
    rotation = next.rotation || 0;
    level = next.level || 0;
    canvas.style.cursor = ["place", "move"].includes(mode)
      ? "crosshair"
      : "grab";
    updateGhost(hoverCell);
    requestRender();
  }
  function reset() {
    const bounds = new THREE.Box3();
    for (const g of groups.values()) bounds.expandByObject(g);
    const target = groups.size
      ? bounds.getCenter(new THREE.Vector3())
      : new THREE.Vector3(0, 0.2, 0);
    const span = groups.size
      ? Math.max(2.5, ...bounds.getSize(new THREE.Vector3()).toArray())
      : 5;
    controls.target.copy(target);
    camera.position
      .copy(target)
      .add(
        new THREE.Vector3(0.85, 1, 1.3).multiplyScalar(
          Math.min(17, Math.max(4, span * 0.65 + 2)),
        ),
      );
    controls.update();
    requestRender();
  }
  function fit() {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, r.width),
      h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  function requestRender() {
    if (!disposed && !raf) raf = requestAnimationFrame(draw);
  }
  function draw(t) {
    raf = 0;
    if (disposed) return;
    const dt = Math.min(0.1, (t - lastTime) / 1000 || 0.016);
    lastTime = t;
    controls.update();
    let moving = false;
    for (const [id, g] of groups) {
      const hinge = g.userData.hinge,
        target = id === selected ? -1.05 : 0;
      if (Math.abs(hinge.rotation.x - target) > 0.002) {
        hinge.rotation.x = THREE.MathUtils.lerp(
          hinge.rotation.x,
          target,
          Math.min(1, dt * 12),
        );
        moving = true;
      }
    }
    renderer.render(scene, camera);
    const projected = [];
    for (const c of data) {
      const button = labels.get(c.id),
        group = groups.get(c.id);
      const point = new THREE.Vector3(
        group.position.x,
        c.y + 1.22,
        group.position.z,
      ).project(camera);
      button.hidden =
        !showLabels ||
        point.z > 1 ||
        point.z < -1 ||
        Math.abs(point.x) > 1.1 ||
        Math.abs(point.y) > 1.1;
      button.classList.toggle("selected", c.id === selected);
      if (!button.hidden)
        projected.push({
          button,
          id: c.id,
          x: (point.x * 0.5 + 0.5) * container.clientWidth,
          y: (-point.y * 0.5 + 0.5) * container.clientHeight,
        });
    }
    projected.sort(
      (a, b) =>
        Number(b.id === selected) - Number(a.id === selected) || b.y - a.y,
    );
    const placed = [];
    for (const item of projected) {
      const w = item.button.offsetWidth,
        h = item.button.offsetHeight;
      const left = Math.max(
        8,
        Math.min(container.clientWidth - w - 8, item.x - w / 2),
      );
      let bottom = Math.min(
          container.clientHeight - 36,
          Math.max(65 + h, item.y),
        ),
        tries = 0;
      let conflict;
      do {
        conflict = placed.find(
          (r) =>
            left < r.right + 5 &&
            left + w > r.left - 5 &&
            bottom - h < r.bottom + 5 &&
            bottom > r.top - 5,
        );
        if (conflict) bottom = conflict.top - 6;
      } while (conflict && ++tries < 24);
      if (bottom - h < 60 || conflict) {
        item.button.hidden = true;
        continue;
      }
      item.button.style.left = left + w / 2 + "px";
      item.button.style.top = bottom + "px";
      placed.push({ left, right: left + w, top: bottom - h, bottom });
    }
    if (moving) requestRender();
  }
  controls.addEventListener("change", requestRender);
  const observer = new ResizeObserver(fit);
  observer.observe(container);
  fit();
  theme(options.dark !== false);
  update(options.initial || {});
  reset();
  return {
    update,
    theme,
    setMode,
    reset,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const g of groups.values()) removeGroup(g);
      if (ghost) removeGroup(ghost);
      for (const t of textures.values()) t.dispose();
      wood.dispose();
      for (const m of Object.values(materials)) m.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      overlay.remove();
    },
  };
}
