**English** · [Русский](configuration.ru.md)

# Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LITEMATIC_HOST` | `127.0.0.1` | HTTP bind address |
| `LITEMATIC_PORT` | `8874` | HTTP port |
| `LITEMATIC_DB` | `planner.sqlite3` beside `app.py` | Persistent collaboration database |

Generate artwork with `scripts/prepare_assets.py` and the loopback-only icon helper. Use the same
client version for textures and model data. The locally generated factual editor registry targets 26.1;
the model pipeline was originally verified with a 26.3 Java client. Unknown/modded states may be
preserved in a schematic without having a visual model or a catalogue entry.

For network deployment, use a TLS reverse proxy and set request size and timeout limits. The
service does not provide a global administrator account. Possession of a collection URL grants
access to that collection. Keep databases, database backups and keyed URLs private.
