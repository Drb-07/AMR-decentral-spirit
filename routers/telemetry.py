"""Telemetry ingest (browser -> server sync) and KPI read/export endpoints."""
import time

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

import state
from services import inventory

router = APIRouter()


@router.post("/api/fleet/logs/sync")
async def sync_fleet_logs(req: Request):
    try:
        data = await req.json()
        state.latest_fleet_logs = data
        commands = []
        if state.pending_fault_injections:
            commands.extend(state.pending_fault_injections)
            state.pending_fault_injections.clear()
        if state.pending_service_actions:
            commands.extend(state.pending_service_actions)
            state.pending_service_actions.clear()
        if state.pending_return_triggers:
            commands.extend(state.pending_return_triggers)
            state.pending_return_triggers.clear()
        if state.pending_order_cancellations:
            commands.extend(state.pending_order_cancellations)
            state.pending_order_cancellations.clear()
        if state.pending_kiva_toggles:
            commands.extend(state.pending_kiva_toggles)
            state.pending_kiva_toggles.clear()
        return {"status": "ok", "received_bots": len(data.get("bots", [])), "commands": commands}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/api/fleet/logs")
async def get_fleet_logs():
    if state.latest_fleet_logs is None:
        return {"status": "empty", "message": "No fleet logs synchronized yet from simulation client.", "timestamp": time.time()}
    return state.latest_fleet_logs


@router.get("/api/fleet/kpis")
async def get_fleet_kpis():
    if state.latest_fleet_logs is None:
        return {
            "status": "empty",
            "message": "No fleet logs synchronized yet from simulation client.",
            "fleetFailureAndMaintenance": {
                "operationalRobotsCount": 8,
                "maintenanceRobotsCount": 0,
                "operationalChargersCount": 8,
                "faultedChargersCount": 0,
                "chargerQueueDepth": 0
            },
            "timestamp": time.time()
        }
    return {
        "status": "ok",
        "exportMetadata": state.latest_fleet_logs.get("exportMetadata", {}),
        "fleetAggregateKpis": state.latest_fleet_logs.get("fleetAggregateKpis", {}),
        "businessAndThroughputKpis": state.latest_fleet_logs.get("businessAndThroughputKpis", {}),
        "amazonRoboticsBenchmarks": state.latest_fleet_logs.get("amazonRoboticsBenchmarks", {}),
        "fleetFailureAndMaintenance": state.latest_fleet_logs.get("fleetFailureAndMaintenance", {}) or state.latest_fleet_logs.get("businessAndThroughputKpis", {}).get("fleetFailureAndMaintenance", {})
    }


@router.get("/api/fleet/kpis/csv", response_class=PlainTextResponse)
async def get_fleet_kpis_csv():
    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {}) if state.latest_fleet_logs else {}
    benchmarks = state.latest_fleet_logs.get("amazonRoboticsBenchmarks", {}) if state.latest_fleet_logs else {}
    slaTiers = biz.get("slaTierBreakdown", {})
    
    lines = [
        "=== WAREHOUSE THROUGHPUT & BUSINESS KPIS ===",
        "Metric,Value,Unit,Benchmark Reference",
        f"Total Operating Time,{biz.get('totalSimOperatingSeconds', 0)},Seconds,{biz.get('totalSimOperatingHours', 0)} Operating Hours",
        f"Active AMR Fleet Size,{biz.get('fleetSize', 8)},AMRs,8 Vehicles Standard Grid",
        f"Orders Placed,{biz.get('totalOrdersPlaced', 0)},Orders,Sim-wide Ingestion",
        f"Orders Fulfilled,{biz.get('totalOrdersFulfilled', 0)},Orders,Deposited at Outbound Bays",
        f"Orders Fulfilled Per Hour,{biz.get('ordersFulfilledPerHour', 0)},Orders/Hr,Amazon Target: 30-50 Orders/Hr per cluster",
        f"Average Order Cycle Time,{biz.get('averageOrderCycleTimeSeconds', 0)},Seconds,Amazon Target: 40-90s cluster picking",
        f"Minimum Order Cycle Time,{biz.get('minOrderCycleTimeSeconds', 0)},Seconds,Fastest direct aisle dispatch",
        f"Maximum Order Cycle Time,{biz.get('maxOrderCycleTimeSeconds', 0)},Seconds,Worst-case tour with multi-stop pick",
        f"Pick Rate Per Robot Per Hour,{biz.get('pickRatePerRobotPerHour', 0)},Picks/AMR/Hr,Amazon Target: 25-45 picks/hr per bot",
        f"Total Fleet Picks Per Hour,{biz.get('fleetTotalPicksPerHour', 0)},Picks/Hr,Consolidated multi-agent throughput",
        f"Total Items Picked,{biz.get('totalItemsPicked', 0)},Items,Shelf to Giant Box collections",
        f"Total Parcels Shelved,{biz.get('totalParcelsShelved', 0)},Parcels,Dock to Rack induction",
        f"Total Actions Per Hour,{biz.get('totalActionsPerHour', 0)},Actions/Hr,Combined pick & stow operations",
        f"Inbound Dock Average Utilization,{biz.get('inboundDockAverageUtilizationPercent', 0)},%,Target: 70-85% continuous flow",
        f"Inbound Dock Avg Queue Wait,{biz.get('inboundDockAverageQueueWaitSeconds', 0)},Seconds,Dock holding wait before AMR arrival",
        f"Outbound Bay Average Utilization,{biz.get('departureBayAverageUtilizationPercent', 0)},%,Bay deposit & packaging readiness",
        f"VIP Express SLA Compliance,{biz.get('vipSlaCompliancePercent', 0)},%,Target: >95% on-time (45s window)",
        f"Overall SLA Compliance,{biz.get('overallSlaCompliancePercent', 0)},%,Target: >90% across all customer tiers",
        "",
        "=== AMAZON ROBOTICS PUBLISHED BENCHMARK COMPARISON ===",
        "Performance Dimension,Simulation Measured Value,Amazon Robotics Target,Compliance Status,Variance vs Benchmark,Operational Notes"
    ]
    if isinstance(benchmarks, dict):
        for b in benchmarks.values():
            if isinstance(b, dict):
                lines.append(f'"{b.get("metric","")}","{b.get("simulationValue","")}","{b.get("amazonRoboticsTarget","")}","{b.get("comparisonStatus","")}","{b.get("variancePercent","")}","{b.get("notes","")}"')
    
    if isinstance(slaTiers, dict) and slaTiers:
        lines.append("")
        lines.append("=== SLA PERFORMANCE BREAKDOWN BY SERVICE TIER ===")
        lines.append("Tier Code,SLA Window (s),Orders Placed,Orders Fulfilled,Met SLA,Breached SLA,Compliance (%),Avg Cycle Time (s)")
        for code, t in slaTiers.items():
            if isinstance(t, dict):
                lines.append(f"{code},{t.get('slaWindowSeconds', 0)},{t.get('placed', 0)},{t.get('fulfilled', 0)},{t.get('metSla', 0)},{t.get('breachedSla', 0)},{t.get('compliancePercent', 0)}%,{t.get('averageCycleTimeSeconds', 0)}s")
            
    slotting = biz.get("storageSlottingAndConsolidation", {}) or (state.latest_fleet_logs.get("storageSlottingAndConsolidation", {}) if state.latest_fleet_logs else {})
    if not slotting:
        slotting = inventory.get_slotting_metrics()
    
    lines.append("")
    lines.append("=== STORAGE SLOTTING & CONSOLIDATION INTELLIGENCE ===")
    lines.append("Metric,Value,Unit,Notes")
    lines.append(f"Slotting Policy,{slotting.get('policy', 'ABC_VELOCITY_PROXIMITY')},Policy Name,Velocity-based proximity allocation")
    lines.append(f"Slotting Compliance,{slotting.get('slottingCompliancePercent', slotting.get('slotting_compliance_percent', 100.0))},%,Class A in Zone A / B in B / C in C")
    lines.append(f"Average Pick Distance,{slotting.get('averagePickDistanceCells', 0)},Cells,Measured AMR rack-to-station pick transit")
    lines.append(f"Baseline Pick Distance,{slotting.get('baselineRandomPickDistanceEstimate', 52.4)},Cells,Monte Carlo random slotting baseline")
    lines.append(f"Travel Distance Saved,{slotting.get('travelDistanceSavedPercent', 0)},%,Efficiency gain vs random allocation")
    reslot_obj = slotting.get('reSlottingAndConsolidation', {})
    total_relocations = reslot_obj.get('totalRelocationsExecuted', 0) if isinstance(reslot_obj, dict) else 0
    lines.append(f"Total Relocations Executed,{total_relocations},Relocations,Background promotions demotions and consolidations")

    lines.append("")
    lines.append("=== FLEET FAILURE MAINTENANCE & CHARGER CONTENTION ===")
    lines.append("Metric,Value,Unit,Notes")
    maint = biz.get("fleetFailureAndMaintenance", {}) or (state.latest_fleet_logs.get("fleetFailureAndMaintenance", {}) if state.latest_fleet_logs else {})
    lines.append(f"Operational Robots,{maint.get('operationalRobotsCount', 8)},AMRs,Active healthy fleet units")
    lines.append(f"Robots in Maintenance,{maint.get('maintenanceRobotsCount', 0)},AMRs,Marked for maintenance / hardware fault")
    lines.append(f"Operational Chargers,{maint.get('operationalChargersCount', 8)},Chargers,Functioning power converter bays")
    lines.append(f"Faulted Chargers,{maint.get('faultedChargersCount', 0)},Chargers,Tripped or faulted charging ports")
    lines.append(f"Charger Queue Depth,{maint.get('chargerQueueDepth', 0)},AMRs,Low-battery robots waiting in queue")
    lines.append(f"Total Robot Faults Incurred,{maint.get('totalRobotFaults', 0)},Incidents,Comms dropout / sensor fault / stuck wheel")
    lines.append(f"Total Charger Faults Incurred,{maint.get('totalChargerFaults', 0)},Incidents,Power converter trips / connector faults")
    lines.append(f"Total Tasks Reassigned,{maint.get('totalTasksReassigned', 0)},Missions,Clean automatic task reassignments")
    lines.append(f"Total Services Completed,{maint.get('totalServicesCompleted', 0)},Services,Technician and automated repairs")
    lines.append(f"Charger Contention Events,{maint.get('chargerContentionEvents', 0)},Contention,Multi-bot charging bay competition")
    lines.append(f"Average Charger Queue Wait,{maint.get('averageChargerQueueWaitSeconds', 0)},Seconds,Mean staging wait under load")

    return PlainTextResponse("\n".join(lines), media_type="text/csv")
