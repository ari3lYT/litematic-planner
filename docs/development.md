**English** · [Русский](development.ru.md)

# Development

Install `requirements-dev.txt`, run `python scripts/prepare_registry.py`, then run `python -m unittest discover -s tests -v`.
Tests cover independent NBT round trips, negative dimensions, property-preserving replacements,
palette growth and custom tags. They create temporary fixtures and require no production data.

Run `npm --prefix frontend ci` and `npm --prefix frontend run build` after changing 3D code.
The frontend uses pinned esbuild, Three.js and Lucide packages. Generated bundles keep license notices.
After preparing local Minecraft assets, `(cd frontend && node check-models.mjs)` checks model geometry.
The icon helper serves only loopback, accepts only the two generated outputs and never uploads them.

| Area | Source |
| --- | --- |
| NBT import, edit and export | `schematic_editor.py` |
| HTTP, materials and persistence | `app.py` |
| Editor interface | `static/editor.js`, `static/editor.css` |
| Block geometry | `frontend/block-models.js` |
| Schematic preview | `frontend/schematic3d.js` |
| Warehouse preview | `frontend/scene3d.js` |

Keep generated Minecraft textures, atlases and icons out of Git. Test with small synthetic
schematics containing stairs, fences, waterlogged states, multiple regions and negative sizes.
