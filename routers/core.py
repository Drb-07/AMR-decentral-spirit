"""Core routes: dashboard page, map, inventory and the WebSocket stub."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

import state
from config import INDEX_HTML
from models import BulkInjectRequest
from services import warehouse, inventory

router = APIRouter()


@router.get("/")
async def get_index():
    return FileResponse(INDEX_HTML)


@router.get("/api/map")
async def get_map():
    return warehouse.to_dict()


@router.get("/api/inventory")
async def get_inventory():
    return inventory.get_summary()


@router.post("/api/inventory/inject")
async def inject_inventory(req: BulkInjectRequest):
    stored = inventory.bulk_store_parcels(req.count)
    return {
        "stored": stored,
        "total_stored": inventory.total_stored_parcels,
        "capacity": inventory.total_capacity,
        "occupancy_rate": round(inventory.occupancy_rate, 2)
    }


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    state.active_connections.add(websocket)
    try:
        # Send initial map setup
        await websocket.send_json({"type": "INIT", "map": warehouse.to_dict()})
        while True:
            data = await websocket.receive_text()
            # Handle client messages if needed
    except WebSocketDisconnect:
        state.active_connections.discard(websocket)
