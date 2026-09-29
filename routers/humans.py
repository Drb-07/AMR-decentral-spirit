"""Human-worker presence toggle and status endpoints."""
import time

from fastapi import APIRouter, Request

import state

router = APIRouter()


@router.post("/api/fleet/humans/toggle")
async def toggle_human_presence(request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    if "enabled" in body and body["enabled"] is not None:
        state.humans_enabled = bool(body["enabled"])
    else:
        state.humans_enabled = not state.humans_enabled
    
    if state.latest_fleet_logs and "humanRobotHybridOperations" in state.latest_fleet_logs:
        state.latest_fleet_logs["humanRobotHybridOperations"]["enabled"] = state.humans_enabled
        if not state.humans_enabled:
            state.latest_fleet_logs["humanRobotHybridOperations"]["activeHumanWorkersCount"] = 0

    return {
        "status": "ok",
        "humansEnabled": state.humans_enabled,
        "message": f"Human worker presence toggled: {'ENABLED' if state.humans_enabled else 'DISABLED'}"
    }


@router.get("/api/fleet/humans/status")
async def get_human_status():
    return {
        "status": "ok",
        "humansEnabled": state.humans_enabled
    }


@router.get("/api/fleet/humans")
async def get_human_workers():
    if state.latest_fleet_logs is None:
        return {
            "status": "ok",
            "humansEnabled": state.humans_enabled,
            "humanRobotHybridOperations": {
                "enabled": state.humans_enabled,
                "activeHumanWorkersCount": 4 if state.humans_enabled else 0
            },
            "timestamp": time.time()
        }
    ops = state.latest_fleet_logs.get("humanRobotHybridOperations", {})
    ops["enabled"] = state.humans_enabled
    return {
        "status": "ok",
        "humansEnabled": state.humans_enabled,
        "humanRobotHybridOperations": ops
    }
