# HTTP API

Inspect routes in `App.do_GET` and `App.do_POST` in `app.py` for the precise request fields.
The browser scripts are the reference client. All JSON responses use UTF-8.

| Route | Contract |
| --- | --- |
| `GET /api/health` | Process health, without database contents |
| `GET /api/catalog` | Material catalogue |
| `GET /api/editor-catalog` | Editable block catalogue and generated icon coordinates |
| `GET /api/state?project=...` | Authorized collection snapshot |
| `POST /api/schematic-preview` | Parse and preview an uploaded schematic |
| `POST /api/schematic-export` | Apply edits and return a `.litematic` file |

Editor endpoints use multipart uploads; inspect `static/editor.js` for the `FormData` shape.
Collection mutations are grouped by route in `app.py`. They validate collection access and
participant identity separately. Warehouse mutations carry a revision; a stale revision must
be refreshed rather than silently overwriting someone else's work.

Do not expose real keyed collection URLs in examples, screenshots or issue reports.
