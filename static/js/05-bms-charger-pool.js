    // =========================================================================
    // AMAZON ROBOTICS (KIVA) DYNAMIC BMS ENERGY BUDGET & CHARGER POOL ALLOCATION
    // =========================================================================
    const CHARGING_PORTS = [
      { id: "CH-01", x: 38, y: 1, zone: "Top Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-02", x: 39, y: 1, zone: "Top Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-03", x: 40, y: 1, zone: "Top Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-04", x: 41, y: 1, zone: "Top Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-05", x: 38, y: 48, zone: "Bottom Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-06", x: 39, y: 48, zone: "Bottom Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-07", x: 40, y: 48, zone: "Bottom Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null },
      { id: "CH-08", x: 41, y: 48, zone: "Bottom Center", occupiedBy: null, reservedBy: null, isFaulted: false, faultReason: null, faultSimTime: null }
    ];

    // Feature 8: Failure, Maintenance & Charger Contention Metrics
    const CHARGER_WAITING_QUEUE = []; // Ordered array: { robotId, battery, urgency, targetPortId, joinTime, stagingX, stagingY }

    const FLEET_FAILURE_MAINTENANCE_METRICS = {
      totalRobotFaultsIncurred: 0,
      totalChargerFaultsIncurred: 0,
      totalTasksReassigned: 0,
      totalMaintenanceServicesCompleted: 0,
      totalChargerContentionEvents: 0,
      totalChargerQueueWaitSeconds: 0,
      totalChargerSessionsQueued: 0,
      averageChargerQueueWaitSeconds: 0,
      maxChargerQueueWaitSeconds: 0,
      faultHistory: []
    };

    const FLEET_FAILURE_MAINTENANCE_CONFIG = {
      randomFaultsEnabled: false,
      checkIntervalMs: 20000,
      mtbfSeconds: 90.0,
      mttrSeconds: 15.0
    };

    const SAFETY_RESERVE_SOC = 15.0; // 15% Minimum Reserve: AMR NEVER depletes below this on warehouse floor
    const DOCKING_ENERGY_BUFFER = 0.45; // Energy % needed for precision deceleration & contact pad engagement
    const ENERGY_RATE_EMPTY_PER_TILE = 0.038; // Base energy % drained per cell traversed empty (~170W)
    const ENERGY_LIFT_PER_OP = 0.15; // Energy % drained per shelf/pick lift actuator cycle (~35W)

    function sortParcelsByProximity(parcels, startX, startY) {
      if (!parcels || parcels.length <= 1) return [...(parcels || [])];
      const remaining = [...parcels];
      const sorted = [];
      let cx = startX, cy = startY;
      while (remaining.length > 0) {
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const p = remaining[i];
          const rx = (p.rackSlot && p.rackSlot.rack) ? p.rackSlot.rack.x : cx;
          const ry = (p.rackSlot && p.rackSlot.rack) ? p.rackSlot.rack.y : cy;
          const d = Math.abs(cx - rx) + Math.abs(cy - ry);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        const [nextP] = remaining.splice(bestIdx, 1);
        sorted.push(nextP);
        if (nextP.rackSlot && nextP.rackSlot.rack) {
          cx = nextP.rackSlot.rack.x;
          cy = nextP.rackSlot.rack.y;
        }
      }
      return sorted;
    }

    function sortItemsByProximity(items, startX, startY) {
      if (!items || items.length <= 1) return [...(items || [])];
      const remaining = [...items];
      const sorted = [];
      let cx = startX, cy = startY;
      while (remaining.length > 0) {
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const it = remaining[i];
          const rx = it.rack ? it.rack.x : cx;
          const ry = it.rack ? it.rack.y : cy;
          const d = Math.abs(cx - rx) + Math.abs(cy - ry);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        const [nextIt] = remaining.splice(bestIdx, 1);
        sorted.push(nextIt);
        if (nextIt.rack) {
          cx = nextIt.rack.x;
          cy = nextIt.rack.y;
        }
      }
      return sorted;
    }

    function calculateEnergyCost(distanceTiles, payloadWeightKg = 0, liftOperations = 0, expectedTurns = 2) {
      if (distanceTiles <= 0 && liftOperations <= 0) return 0;
      const TARE_MASS = 145.0;
      const totalMass = TARE_MASS + Math.max(0, payloadWeightKg);
      const massRatio = totalMass / TARE_MASS;

      // Mechanical rolling resistance & aerodynamic drag work scaled by total mass
      const baseEnergyPerTile = (typeof ENERGY_RATE_EMPTY_PER_TILE !== 'undefined' ? ENERGY_RATE_EMPTY_PER_TILE : 0.038);
      const transitEnergy = distanceTiles * baseEnergyPerTile * Math.pow(massRatio, 0.85);

      // Kinetic acceleration & deceleration cycles (0.5 * m * v² + electrical braking losses)
      const accelCycles = Math.max(1, Math.ceil(distanceTiles / 14));
      const kineticCycleEnergy = accelCycles * (0.012 * massRatio);

      // Dual-differential corner turning rotation energy (90° pivots overcoming tire scrub)
      const turnEnergy = expectedTurns * (0.009 * massRatio);

      const baseLiftOp = (typeof ENERGY_LIFT_PER_OP !== 'undefined' ? ENERGY_LIFT_PER_OP : 0.08);
      const liftEnergy = liftOperations * baseLiftOp * (1.0 + (payloadWeightKg / 50.0) * 0.4);

      return transitEnergy + kineticCycleEnergy + turnEnergy + liftEnergy;
    }

