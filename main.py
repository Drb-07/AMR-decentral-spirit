"""
FastAPI + WebSocket Live Warehouse Viewer Server
Part of Edge-AI Distributed Fleet Coordination for AMRs

Serves the interactive dashboard on http://localhost:8000

Layout
  server.py      app factory + entry point (this file)
  config.py      paths / constants
  models.py      pydantic request models
  services.py    warehouse + inventory singletons
  state.py       shared mutable state (logs, command queues, flags)
  routers/       API endpoints, one module per feature area
  templates/     index.html (markup only)
  static/css/    stylesheets
  static/js/     dashboard scripts (loaded in numeric order)
"""
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from config import HOST, PORT, STATIC_DIR
from routers import core, diagnostics, faults, humans, returns_kiva, slotting, telemetry

app = FastAPI(title="Edge AMR Fleet Visualizer")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

for module in (core, telemetry, faults, humans, diagnostics, slotting, returns_kiva):
    app.include_router(module.router)


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
