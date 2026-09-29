# AMR Fleet Mission Control (split layout)

Run (needs your existing `warehouse_map.py` and `inventory.py` in this folder):

    pip install -r requirements.txt
    python server.py          # http://127.0.0.1:8000

## Layout
    server.py            app + router wiring + entry point
    config.py            paths / host / port / grid size
    models.py            pydantic request models
    services.py          warehouse + inventory singletons
    state.py             shared mutable state (latest logs, command queues, flags)
    routers/             core, telemetry, faults, humans, diagnostics, slotting, returns_kiva
    templates/index.html markup only
    static/css/          base, hud, panels, components, problems
    static/js/           00..24, loaded in numeric order by index.html

## Notes
- The JS files are classic scripts sharing one global scope, exactly like the old single
  <script>. **Load order matters** (top-level `const`s are used across files), so keep the
  numeric prefixes and the order of the <script> tags in index.html.
- In Python, use `state.latest_fleet_logs`, never `from state import latest_fleet_logs`
  (rebinding would not be shared).
- Bug fixes from the review are NOT applied here; this is a pure restructure.
