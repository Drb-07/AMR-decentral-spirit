"""ABC / velocity slotting metrics and re-slot optimisation."""
import time

from fastapi import APIRouter

import state
from services import inventory

router = APIRouter()


@router.get("/api/fleet/slotting")
async def get_fleet_slotting():
    if state.latest_fleet_logs is None:
        return {
            "status": "ok",
            "timestamp": time.time(),
            "storageSlottingAndConsolidation": inventory.get_slotting_metrics()
        }
    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {})
    slotting_data = biz.get("storageSlottingAndConsolidation", {}) or state.latest_fleet_logs.get("storageSlottingAndConsolidation", {})
    if not slotting_data:
        slotting_data = inventory.get_slotting_metrics()
    return {
        "status": "ok",
        "timestamp": time.time(),
        "storageSlottingAndConsolidation": slotting_data
    }


@router.post("/api/fleet/slotting/optimize")
async def optimize_fleet_slotting():
    res = inventory.reslot_and_consolidate(max_moves=10)
    return {
        "status": "ok",
        "timestamp": time.time(),
        "optimizationResult": res
    }
