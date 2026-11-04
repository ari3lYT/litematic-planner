# Vanilla block rendering

`block-models.js` resolves the Java blockstate variants and multipart rules, model parents, texture aliases, face UVs, rotations, UV lock and tint. `schematic3d.js` instances the resulting geometry for each state in a schematic. Unsupported models are reported in the viewer instead of being replaced by cubes.

The assets in `static/minecraft/` were prepared from a locally installed Minecraft Java 26.3 client. Regenerate the model pack and texture atlas with:

```sh
python3 frontend/build-minecraft-assets.py /absolute/path/to/minecraft-client.jar
```

`build-block-icons.js` renders the block icons from the same geometry. The generated `block-icons.png` and its `block-icons.json` index are generated locally alongside the model pack and are excluded from Git. Normal frontend builds reuse these local files.

Build the viewer with `npm run build` from `frontend/`. `check-models.mjs` verifies real model silhouettes using ray casts, multipart selection, face tint and the special chest model. The model resources do not execute game code and do not modify schematic NBT.
