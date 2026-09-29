"""Fault injection (chaos) and maintenance/service endpoints."""
import time

from fastapi import APIRouter, Request

import state

router = APIRouter()


@router.post("/api/fleet/chaos/inject")
async def chaos_inject(req: Request):
    try:
        body = await req.json()
    except Exception:
        body = {}
    bot_id = body.get("robotId", None)
    fault_type = body.get("faultType", "MOTOR_STALL")
    evt = {
        "event": "CHAOS_FAULT_INJECTED",
        "robotId": bot_id,
        "faultType": fault_type,
        "timestamp": time.time()
    }
    state.chaos_events.append(evt)
    state.fault_history.append(evt)
    state.pending_fault_injections.append({
        "action": "INJECT_FAULT",
        "targetType": "ROBOT",
        "robotId": bot_id,
        "portId": None,
        "faultType": fault_type,
        "timestamp": evt["timestamp"]
    })
    return {"status": "ok", "message": f"Chaos fault {fault_type} queued for {bot_id or 'random active robot'}", "event": evt}


@router.get("/api/fleet/chaos/events")
async def get_chaos_events():
    return {"status": "ok", "events": state.chaos_events}


@router.post("/api/fleet/fault/inject")
async def fleet_fault_inject(req: Request):
    try:
        body = await req.json()
    except Exception:
        body = {}
    target_type = (body.get("targetType") or ("CHARGER" if body.get("portId") else "ROBOT")).upper()
    robot_id = body.get("robotId") or body.get("botId")
    port_id = body.get("portId")
    fault_type = body.get("faultType") or ("POWER_CONVERTER_TRIP" if target_type == "CHARGER" else "COMMS_DROPOUT")

    cmd = {
        "action": "INJECT_FAULT",
        "targetType": target_type,
        "robotId": robot_id,
        "portId": port_id,
        "faultType": fault_type,
        "timestamp": time.time()
    }
    state.pending_fault_injections.append(cmd)
    state.fault_history.append(cmd)
    state.chaos_events.append({
        "event": "CHAOS_FAULT_INJECTED",
        "robotId": robot_id,
        "faultType": fault_type,
        "timestamp": cmd["timestamp"]
    })
    return {
        "status": "ok",
        "message": f"Fault {fault_type} queued for {port_id or robot_id or ('random ' + target_type.lower())}",
        "command": cmd
    }


@router.post("/api/fleet/maintenance/service")
async def fleet_maintenance_service(req: Request):
    try:
        body = await req.json()
    except Exception:
        body = {}
    robot_id = body.get("robotId") or body.get("botId")
    port_id = body.get("portId")
    service_all = body.get("serviceAll", False) or (robot_id is None and port_id is None)

    cmd = {
        "action": "SERVICE_MAINTENANCE",
        "robotId": robot_id,
        "portId": port_id,
        "serviceAll": bool(service_all),
        "timestamp": time.time()
    }
    state.pending_service_actions.append(cmd)
    state.service_history.append(cmd)
    return {
        "status": "ok",
        "message": f"Maintenance action queued: {'All units' if service_all else (port_id or robot_id)}",
        "command": cmd
    }


@router.get("/api/fleet/maintenance")
async def get_fleet_maintenance():
    if state.latest_fleet_logs is None:
        return {
            "status": "ok",
            "fleetFailureAndMaintenance": {
                "operationalRobotsCount": 8,
                "maintenanceRobotsCount": 0,
                "operationalChargersCount": 8,
                "faultedChargersCount": 0,
                "chargerQueueDepth": 0,
                "totalRobotFaults": 0,
                "totalChargerFaults": 0,
                "totalTasksReassigned": 0,
                "totalServicesCompleted": 0,
                "chargerContentionEvents": 0,
                "averageChargerQueueWaitSeconds": 0.0,
                "maxChargerQueueWaitSeconds": 0.0,
                "chargerList": [],
                "queuedRobots": []
            },
            "faultedRobots": [],
            "recentFaultEvents": state.fault_history[-20:],
            "recentServiceActions": state.service_history[-20:],
            "timestamp": time.time()
        }

    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {})
    maint = state.latest_fleet_logs.get("fleetFailureAndMaintenance", {}) or biz.get("fleetFailureAndMaintenance", {})
    bots = state.latest_fleet_logs.get("bots", [])
    faulted_bots = [
        {
            "id": b.get("botId") or b.get("id"),
            "state": b.get("currentStatus", {}).get("state"),
            "statusBadge": b.get("currentStatus", {}).get("statusBadge"),
            "battery": b.get("currentStatus", {}).get("batteryPercent"),
            "isFaulted": b.get("currentStatus", {}).get("isFaulted", False),
            "isUnderMaintenance": b.get("currentStatus", {}).get("isUnderMaintenance", False),
            "faultType": b.get("currentStatus", {}).get("faultType"),
            "maintenanceReason": b.get("currentStatus", {}).get("maintenanceReason")
        }
        for b in bots
        if b.get("currentStatus", {}).get("isFaulted")
        or b.get("currentStatus", {}).get("isUnderMaintenance")
        or b.get("currentStatus", {}).get("state") in ("HARDWARE_FAULT", "MARKED_FOR_MAINTENANCE")
    ]
    return {
        "status": "ok",
        "timestamp": time.time(),
        "fleetFailureAndMaintenance": maint,
        "faultedRobots": faulted_bots,
        "recentFaultEvents": state.fault_history[-20:],
        "recentServiceActions": state.service_history[-20:]
    }
