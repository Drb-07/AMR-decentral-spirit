"""Read-only diagnostics: pack stations, kinematics, perception."""
import time

from fastapi import APIRouter

import state

router = APIRouter()


@router.get("/api/fleet/packstations")
async def get_pack_stations():
    if state.latest_fleet_logs is None:
        return {"status": "empty", "message": "No fleet logs synchronized yet from simulation client.", "timestamp": time.time()}
    return {
        "status": "ok",
        "packStationOperations": state.latest_fleet_logs.get("packStationOperations", {})
    }


@router.get("/api/fleet/kinematics")
async def get_fleet_kinematics():
    if state.latest_fleet_logs is None:
        return {"status": "empty", "message": "No fleet logs synchronized yet from simulation client.", "timestamp": time.time()}
    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {})
    kinematics_summary = biz.get("kinematics", {}) or state.latest_fleet_logs.get("kinematics", {})
    bots = state.latest_fleet_logs.get("bots", [])
    
    bot_kinematics = []
    for b in bots:
        status = b.get("currentStatus", {})
        kin = b.get("kinematicsAndDistance", {})
        bot_kinematics.append({
            "id": b.get("id") or b.get("botId"),
            "totalMassKg": status.get("totalChassisMassKg", 145.0),
            "payloadWeightKg": status.get("payloadWeightKg", 0.0),
            "currentSpeed": status.get("currentSpeedCellsPerSec", 0.0),
            "currentSpeedMps": status.get("currentSpeedMps", 0.0),
            "acceleration": status.get("accelerationCellsPerSec2", 0.0),
            "angularVelocity": status.get("angularVelocityRadPerSec", 0.0),
            "isBraking": status.get("isBraking", False),
            "brakeIntensityPercent": status.get("brakeIntensityPercent", 0),
            "isTurning": status.get("isTurning", False),
            "turnDirection": status.get("turnDirection", None),
            "totalBrakingEvents": kin.get("totalBrakingEvents", 0),
            "totalBrakingEnergyJoules": kin.get("totalBrakingEnergyJoules", 0.0),
            "totalCornerRotations": kin.get("totalCornerRotations", 0),
            "totalRotationTimeSeconds": kin.get("totalRotationTimeSeconds", 0.0),
            "totalPayloadTonKm": kin.get("totalTransportTonKm", 0.0),
            "powerWatts": status.get("bmsPowerWatts", 0)
        })
        
    return {
        "status": "ok",
        "timestamp": time.time(),
        "fleetKinematicsSummary": kinematics_summary,
        "robots": bot_kinematics
    }


@router.get("/api/fleet/perception")
async def get_fleet_perception():
    if state.latest_fleet_logs is None:
        return {"status": "empty", "message": "No fleet logs synchronized yet from simulation client.", "timestamp": time.time()}
    bots = state.latest_fleet_logs.get("bots", [])
    
    bot_perceptions = []
    total_occlusions = 0
    total_blind_spot = 0
    total_confirmed_tracks = 0
    
    for b in bots:
        p = b.get("perceptionAndSensorSuite", {})
        total_occlusions += p.get("totalOcclusionEvents", 0)
        total_blind_spot += p.get("totalBlindSpotIgnoredEvents", 0)
        total_confirmed_tracks += p.get("totalConfirmedTracksLifetime", 0)
        
        bot_perceptions.append({
            "id": b.get("id") or b.get("botId"),
            "sensorType": p.get("sensorType", "2D_SAFETY_LIDAR_PROXIMITY"),
            "maxRangeCells": p.get("maxRangeCells", 6.0),
            "maxRangeMeters": p.get("maxRangeMeters", 2.1),
            "fovDegrees": p.get("fovDegrees", 220),
            "detectionLatencyMs": p.get("detectionLatencyMs", 80),
            "blindSpotRadiusCells": p.get("blindSpotRadiusCells", 0.85),
            "activeConfirmedObstaclesCount": p.get("activeConfirmedObstaclesCount", 0),
            "totalOcclusionEvents": p.get("totalOcclusionEvents", 0),
            "totalBlindSpotIgnoredEvents": p.get("totalBlindSpotIgnoredEvents", 0),
            "totalConfirmedTracksLifetime": p.get("totalConfirmedTracksLifetime", 0),
            "confirmedObstacles": p.get("confirmedObstacles", [])
        })
        
    return {
        "status": "ok",
        "timestamp": time.time(),
        "fleetPerceptionSummary": {
            "sensorSpecification": "2D Safety LiDAR Scanner (220° FOV, 6.0c Range, 80ms Confirmation Latency)",
            "proximitySensorSpecification": "360° Ultrasonic / Bumper Halo (0.85c Range)",
            "totalOcclusionEventsPrevented": total_occlusions,
            "totalBlindSpotIgnored": total_blind_spot,
            "totalConfirmedTracksLifetime": total_confirmed_tracks,
            "totalRobotsActive": len(bot_perceptions)
        },
        "robots": bot_perceptions
    }
