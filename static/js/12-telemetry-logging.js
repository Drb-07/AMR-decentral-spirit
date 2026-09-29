    // ==========================================
    // HIGH-PRECISION TELEMETRY & BEHAVIOR LOGGING ENGINE
    // ==========================================
    let totalSimSeconds = 0;

    function recordRobotEvent(robot, type, description, details = {}) {
      if (!robot || !robot.eventHistory) return;
      const entry = {
        eventId: robot.eventHistory.length + 1,
        timestamp: new Date().toISOString(),
        simTimeSeconds: Number((totalSimSeconds || 0).toFixed(2)),
        type: type,
        description: description,
        coords: { x: Number(robot.x.toFixed(2)), y: Number(robot.y.toFixed(2)), gridX: robot.gridX, gridY: robot.gridY },
        battery: Number(robot.battery.toFixed(1)),
        state: robot.state,
        statusBadge: robot.statusBadge || null,
        cargoWeightKg: Number((robot.payloadWeight || 0).toFixed(1)),
        details: details
      };
      robot.eventHistory.push(entry);
      if (robot.eventHistory.length > 2000) {
        robot.eventHistory.shift();
      }
    }

    function onRobotJamStart(robot, blockerId, reason) {
      if (!robot) return;
      if (robot.currentJam) {
        if (blockerId && robot.currentJam.blockerId === 'UNKNOWN') {
          robot.currentJam.blockerId = blockerId;
          const blocker = AMR_FLEET.find(b => b.id === blockerId);
          if (blocker) robot.currentJam.blockerBattery = Number(blocker.battery.toFixed(1));
        }
        return;
      }
      const blocker = blockerId ? AMR_FLEET.find(b => b.id === blockerId) : null;
      robot.currentJam = {
        episodeId: (robot.jamEpisodes ? robot.jamEpisodes.length + 1 : 1),
        startTime: Date.now(),
        startSimTime: totalSimSeconds,
        location: { x: robot.gridX, y: robot.gridY },
        blockerId: blockerId || 'UNKNOWN',
        myBattery: Number(robot.battery.toFixed(1)),
        blockerBattery: blocker ? Number(blocker.battery.toFixed(1)) : null,
        reason: reason || 'COLLISION_PREVENTION'
      };
      if (robot.logStats) {
        robot.logStats.totalJamsEncountered++;
      }
      recordRobotEvent(robot, 'JAM_ENTER', `Halted at (${robot.gridX}, ${robot.gridY}) due to ${reason} (Blocker: ${blockerId || 'peer'})`, {
        blockerId,
        reason,
        myBattery: robot.battery,
        blockerBattery: blocker ? blocker.battery : null
      });
    }

    function onRobotJamEnd(robot, resolution = 'RESUMED_NORMAL') {
      if (!robot || !robot.currentJam) return;
      const waitDur = totalSimSeconds - robot.currentJam.startSimTime;
      if (waitDur >= 0.05) {
        const episode = {
          episodeId: robot.currentJam.episodeId,
          startRealTime: new Date(robot.currentJam.startTime).toLocaleTimeString(),
          startSimTimeSec: Number(robot.currentJam.startSimTime.toFixed(2)),
          endSimTimeSec: Number(totalSimSeconds.toFixed(2)),
          waitDurationSec: Number(waitDur.toFixed(2)),
          location: robot.currentJam.location,
          blockerId: robot.currentJam.blockerId,
          botBattery: robot.currentJam.myBattery,
          blockerBattery: robot.currentJam.blockerBattery,
          reason: robot.currentJam.reason,
          resolution: resolution,
          description: `Waited ${waitDur.toFixed(1)}s at (${robot.currentJam.location.x}, ${robot.currentJam.location.y}) due to ${robot.currentJam.reason} (${robot.currentJam.blockerId}). Resolved via ${resolution}.`
        };
        if (robot.jamEpisodes) {
          robot.jamEpisodes.push(episode);
          if (robot.jamEpisodes.length > 500) robot.jamEpisodes.shift();
        }
        recordRobotEvent(robot, 'JAM_CLEARED', `Traffic delay resolved after ${waitDur.toFixed(1)}s via ${resolution}`, episode);
      }
      robot.currentJam = null;
    }

    function buildBotLogObject(r) {
      if (!r) return null;
      const s = r.logStats || {};
      const totalTime = s.totalSimTime || 0.001;
      const moveTime = s.activeMovingTime || 0;
      const waitTime = s.jamWaitTime || 0;
      const chgTime = s.chargingTime || 0;
      const loadTime = s.loadingTime || 0;
      const idleTime = s.idleTime || 0;

      const movingPct = Number(((moveTime / totalTime) * 100).toFixed(1));
      const jamWaitPct = Number(((waitTime / totalTime) * 100).toFixed(1));
      const chargingPct = Number(((chgTime / totalTime) * 100).toFixed(1));
      const loadingPct = Number(((loadTime / totalTime) * 100).toFixed(1));
      const idlePct = Number(((idleTime / totalTime) * 100).toFixed(1));

      const activeAndWait = moveTime + waitTime;
      const jamDelayFactor = activeAndWait > 0 ? Number(((waitTime / activeAndWait) * 100).toFixed(1)) : 0;
      const nonChgTime = totalTime - chgTime;
      const operationalAvailabilityPct = nonChgTime > 0 ? Number((((moveTime + loadTime) / nonChgTime) * 100).toFixed(1)) : 0;

      const avgSpeed = moveTime > 0 ? Number(((s.totalDistanceTraveled || 0) / moveTime).toFixed(2)) : 0;

      return {
        botId: r.id,
        num: r.num,
        homeBay: {
          id: r.homeBayId,
          zone: r.homeBayZone,
          x: r.homeX,
          y: r.homeY
        },
        currentStatus: {
          state: r.state,
          batteryPercent: Number(r.battery.toFixed(1)),
          minBatterySeenPercent: Number((s.minBatterySeen !== undefined ? s.minBatterySeen : r.battery).toFixed(1)),
          isFaulted: !!r.isFaulted,
          isUnderMaintenance: !!r.isUnderMaintenance,
          faultType: r.faultType || null,
          maintenanceReason: r.maintenanceReason || null,
          currentSpeedCellsPerSec: Number((r.currentSpeed || 0).toFixed(2)),
          currentSpeedMps: Number(((r.currentSpeed || 0) * 0.8).toFixed(2)),
          accelerationCellsPerSec2: Number((r.acceleration || 0).toFixed(2)),
          angularVelocityRadPerSec: Number((r.angularVelocity || 0).toFixed(2)),
          isTurning: !!r.isTurning,
          turnDirection: r.turnDirection || null,
          isBraking: !!r.isBraking,
          brakeIntensityPercent: Math.round((r.brakeIntensity || 0) * 100),
          headingDegrees: Math.round((r.heading * 180 / Math.PI + 360) % 360),
          position: {
            x: Number(r.x.toFixed(2)),
            y: Number(r.y.toFixed(2)),
            gridX: r.gridX,
            gridY: r.gridY
          },
          statusBadge: r.statusBadge || null,
          targetDescription: r.targetDesc || null,
          payloadWeightKg: Number((r.payloadWeight || 0).toFixed(1)),
          totalChassisMassKg: Number((r.totalMassKg || 145.0).toFixed(1)),
          payloadDampingFactor: Number((r.payloadDamping || 1.0).toFixed(2)),
          bmsPowerWatts: Math.round(r.powerWatts || 0),
          bmsChargePhase: r.chargePhase || 'Standby'
        },
        functionalTimeBreakdown: {
          totalSimSeconds: Number(totalTime.toFixed(2)),
          activeMovingTimeSeconds: Number(moveTime.toFixed(2)),
          activeMovingPercent: movingPct,
          jamWaitTimeSeconds: Number(waitTime.toFixed(2)),
          jamWaitPercent: jamWaitPct,
          chargingTimeSeconds: Number(chgTime.toFixed(2)),
          chargingPercent: chargingPct,
          loadingTimeSeconds: Number(loadTime.toFixed(2)),
          loadingPercent: loadingPct,
          idleTimeSeconds: Number(idleTime.toFixed(2)),
          idlePercent: idlePct,
          jamDelayFactorPercent: jamDelayFactor,
          operationalAvailabilityPercent: operationalAvailabilityPct
        },
        kinematicsAndDistance: {
          totalDistanceTraveledCells: Number((s.totalDistanceTraveled || 0).toFixed(2)),
          totalCellsTraversed: s.totalCellsTraversed || 0,
          averageMovingSpeedCellsPerSec: avgSpeed,
          maxSpeedRecordedCellsPerSec: Number((s.maxSpeed || 0).toFixed(2)),
          totalBrakingEvents: s.totalBrakingEvents || 0,
          totalBrakingEnergyJoules: Number((s.totalBrakingEnergyJoules || 0).toFixed(1)),
          totalCornerRotations: s.totalCornerRotations || 0,
          totalRotationTimeSeconds: Number((s.totalRotationTimeSec || 0).toFixed(1)),
          totalTransportTonKm: Number((r.totalPayloadTonKm || 0).toFixed(4))
        },
        bmsEnergyMetrics: {
          initialBatteryPercent: Number((s.initialBattery || 100).toFixed(1)),
          currentBatteryPercent: Number(r.battery.toFixed(1)),
          minBatteryFloorSeenPercent: Number((s.minBatterySeen !== undefined ? s.minBatterySeen : r.battery).toFixed(1)),
          batterySafetyFloorMet: (s.minBatterySeen !== undefined ? s.minBatterySeen : r.battery) > 10.0,
          outOfChargeEvents: s.totalOutOfChargeEvents || 0,
          towedByRescueCount: s.totalTowedByRescue || 0,
          totalEnergyConsumedSoCPercent: Number((s.totalEnergyConsumedSoC || 0).toFixed(2)),
          totalEnergyChargedSoCPercent: Number((s.totalEnergyChargedSoC || 0).toFixed(2)),
          chargeCyclesCompleted: s.chargeCyclesCount || 0
        },
        warehouseProductivity: {
          inboundShipmentsCompleted: s.totalInboundCompleted || 0,
          outboundOrdersCompleted: s.totalOutboundCompleted || 0,
          totalParcelsShelved: s.totalParcelsShelved || 0,
          totalItemsPickedConsolidated: s.totalItemsConsolidated || 0,
          totalPayloadMassTransportedKg: Number((s.totalWeightTransportedKg || 0).toFixed(1)),
          completedMissions: (r.missionsHistory || []).slice(-30)
        },
        trafficAndJamBehavior: {
          totalJamsEncountered: s.totalJamsEncountered || 0,
          totalJamWaitTimeSeconds: Number(waitTime.toFixed(2)),
          averageJamDurationSeconds: s.totalJamsEncountered > 0 ? Number((waitTime / s.totalJamsEncountered).toFixed(2)) : 0,
          totalBackupsToPreviousBox: s.totalBackupsToPreviousBox || 0,
          totalSideStepsExecuted: s.totalSideSteps || 0,
          totalOvertakesInitiated: s.totalOvertakesInitiated || 0,
          totalOvertakesCompleted: s.totalOvertakesCompleted || 0,
          totalReroutesExecuted: s.totalReroutes || 0,
          totalRightOfWayYields: s.totalRightOfWayYields || 0,
          totalEmergencyBrakingEvents: s.totalEmergencyBraking || 0,
          physicalCollisions: s.physicalCollisions || 0,
          jamEpisodes: (r.jamEpisodes || []).slice(-30)
        },
        perceptionAndSensorSuite: {
          sensorType: '2D_SAFETY_LIDAR_PROXIMITY',
          maxRangeCells: Number((r.sensorRange || 6.0).toFixed(1)),
          maxRangeMeters: Number(((r.sensorRange || 6.0) * 0.35).toFixed(2)),
          fovDegrees: 220,
          detectionLatencyMs: Math.round((r.detectionLatencySec || 0.08) * 1000),
          blindSpotRadiusCells: Number((r.blindSpotRadius || 0.85).toFixed(2)),
          activeConfirmedObstaclesCount: (r.perception && r.perception.confirmedObstacles) ? r.perception.confirmedObstacles.length : 0,
          totalOcclusionEvents: (r.perception ? r.perception.totalOcclusions : 0),
          totalBlindSpotIgnoredEvents: (r.perception ? r.perception.totalBlindSpotIgnored : 0),
          totalConfirmedTracksLifetime: (r.perception ? r.perception.totalConfirmedTracks : 0),
          confirmedObstacles: ((r.perception && r.perception.confirmedObstacles) ? r.perception.confirmedObstacles : []).map(o => ({
            id: o.id,
            type: o.type,
            distanceCells: Number((o.dist || 0).toFixed(2)),
            bearingDegrees: Math.round(((o.bearing || 0) * 180 / Math.PI + 360) % 360),
            timeVisibleMs: Math.round((o.timeVisible || 0) * 1000),
            confirmed: !!o.confirmed
          }))
        },
        chronologicalEventLog: (r.eventHistory || []).slice(-50)
      };
    }

