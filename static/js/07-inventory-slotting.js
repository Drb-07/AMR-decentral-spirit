    // 3D Multi-Tier Rack Memory & Inventory Management
    const MAX_FLOORS = 5;
    const rackMemory = {}; // Key: "x,y" -> { x, y, floors: [null, null, null, null, null] }
    const inboundQueues = {}; // Key: dockId -> Array of parcels waiting for pickup (Lit Yellow while > 0)
    const outboundOrders = {}; // Key: bayId -> { orderId, parcels: [], expireAt } (Lit Yellow while active)
    let parcelSequence = 1000;
    let orderSequence = 2000;

    const SKU_CATALOG = [
      { sku: "SKU-FMCG", name: "Retail Goods", fullName: "Retail Packaged Goods", weight: 6.7, velocityClass: "A", demandWeight: 0.50, color: "#34d399", tint: "rgba(52, 211, 153, 0.15)", border: "#059669" },
      { sku: "SKU-ELEC", name: "Electronics", fullName: "Consumer Electronics", weight: 4.5, velocityClass: "A", demandWeight: 0.30, color: "#38bdf8", tint: "rgba(56, 189, 248, 0.15)", border: "#0284c7" },
      { sku: "SKU-FASH", name: "Apparel", fullName: "Apparel & Footwear", weight: 2.2, velocityClass: "B", demandWeight: 0.12, color: "#f472b6", tint: "rgba(244, 114, 182, 0.15)", border: "#db2777" },
      { sku: "SKU-PHRM", name: "Pharma", fullName: "Cold-Chain Pharma", weight: 3.8, velocityClass: "B", demandWeight: 0.05, color: "#c084fc", tint: "rgba(192, 132, 252, 0.15)", border: "#9333ea" },
      { sku: "SKU-AUTO", name: "Automotive", fullName: "Automotive Parts", weight: 14.2, velocityClass: "C", demandWeight: 0.02, color: "#fb923c", tint: "rgba(251, 146, 60, 0.15)", border: "#ea580c" },
      { sku: "SKU-INDM", name: "Hardware", fullName: "Industrial Hardware", weight: 18.5, velocityClass: "C", demandWeight: 0.01, color: "#facc15", tint: "rgba(250, 204, 21, 0.15)", border: "#ca8a04" }
    ];

    function getRackCategory(y) {
      let idx = 0;
      if (y >= 5 && y <= 22) {
        idx = Math.floor((y - 5) / 3);
      } else if (y >= 27 && y <= 44) {
        idx = Math.floor((y - 27) / 3);
      }
      idx = Math.max(0, Math.min(SKU_CATALOG.length - 1, idx));
      return SKU_CATALOG[idx];
    }

    function calculateRackDockTransitCost(rx, ry) {
      if (!mapData || !mapData.stations) return { cost: 20.0, zone: 'ZONE_A', minIn: 20, minOut: 20 };
      const pickups = Object.values(mapData.stations).filter(s => s.station_type === 'pickup' || s.id.startsWith('P'));
      const dropoffs = Object.values(mapData.stations).filter(s => s.station_type === 'dropoff' || s.id.startsWith('D'));

      let minIn = Infinity;
      for (const p of pickups) {
        const d = Math.abs(rx - p.x) + Math.abs(ry - p.y);
        if (d < minIn) minIn = d;
      }
      if (minIn === Infinity) minIn = 20.0;

      let minOut = Infinity;
      for (const d of dropoffs) {
        const dist = Math.abs(rx - d.x) + Math.abs(ry - d.y);
        if (dist < minOut) minOut = dist;
      }
      if (minOut === Infinity) minOut = 20.0;

      const cost = 0.4 * minIn + 0.6 * minOut;
      let zone = 'ZONE_A';
      if (cost <= 18.0) {
        zone = 'ZONE_A'; // Prime Fast-Pick Dock Adjacent Zone
      } else if (cost <= 28.0) {
        zone = 'ZONE_B'; // Intermediate Transit Zone
      } else {
        zone = 'ZONE_C'; // Deep Reserve / Slow Mover Zone
      }
      return { cost, zone, minIn, minOut };
    }

    // Storage & Slotting Intelligence State
    const WAREHOUSE_SLOTTING_METRICS = {
      policy: 'ABC_VELOCITY_PROXIMITY',
      baselineRandomPickDistanceEstimate: 52.4, // Baseline average pick tour distance across 80x50 warehouse with random slotting
      totalPicksExecuted: 0,
      totalPickDistanceCells: 0,
      averagePickDistanceCells: 0,
      totalStowsExecuted: 0,
      totalStowDistanceCells: 0,
      averageStowDistanceCells: 0,
      travelDistanceSavedPercent: 0,
      slottingCompliancePercent: 100,
      reSlottingAndConsolidation: {
        totalOptimizationPasses: 0,
        totalRelocationsExecuted: 0,
        classAPromotions: 0,
        classCDemotions: 0,
        tierConsolidations: 0,
        cumulativeDistanceSavedCells: 0,
        lastOptimizationSimTime: 0,
        auditTrail: []
      }
    };

    function initRackMemory() {
      if (!mapData) return;
      for (let x = 1; x < mapData.width - 1; x++) {
        for (let y = 1; y < mapData.height - 1; y++) {
          if (mapData.grid[x][y] === 1) { // Storage rack (excluding outer walls)
            const cat = getRackCategory(y);
            const { cost, zone, minIn, minOut } = calculateRackDockTransitCost(x, y);
            rackMemory[`${x},${y}`] = {
              x: x,
              y: y,
              categorySku: cat.sku,
              categoryName: cat.name,
              categoryFullName: cat.fullName,
              categoryColor: cat.color,
              categoryTint: cat.tint,
              categoryBorder: cat.border,
              zone: zone, // 'ZONE_A', 'ZONE_B', 'ZONE_C'
              dockCost: Number(cost.toFixed(1)),
              minInboundDist: minIn,
              minOutboundDist: minOut,
              floors: [null, null, null, null, null] // Index 0 = Tier 1, Index 4 = Tier 5
            };
          }
        }
      }

      // Seed initial warehouse inventory respecting ABC slotting zones (~240 items)
      // Class A in ZONE_A (~85%), Class B in ZONE_B (~80%), Class C in ZONE_C (~90%)
      for (const rack of Object.values(rackMemory)) {
        if (Math.random() < 0.22) {
          // Determine appropriate SKU for this rack's zone
          let targetSku = rack.categorySku;
          const matchingSkus = SKU_CATALOG.filter(c => {
            if (rack.zone === 'ZONE_A') return c.velocityClass === 'A';
            if (rack.zone === 'ZONE_B') return c.velocityClass === 'B';
            return c.velocityClass === 'C';
          });
          const cat = matchingSkus.length > 0 ? matchingSkus[Math.floor(Math.random() * matchingSkus.length)] : (SKU_CATALOG.find(c => c.sku === rack.categorySku) || SKU_CATALOG[0]);

          const numItems = Math.floor(Math.random() * 2) + 1;
          for (let f = 0; f < numItems; f++) {
            parcelSequence++;
            const w = parseFloat((cat.weight + (Math.random() * 2 - 1)).toFixed(1));
            rack.floors[f] = {
              parcel_id: `PKG-${parcelSequence}`,
              sku: cat.sku,
              name: cat.name,
              weight: `${w}kg`,
              weightVal: w,
              dock: 'INIT_STOCK',
              timestamp: 'Initial Inventory'
            };
          }
        }
      }

      // Initialize queues for stations
      for (const sid of Object.keys(mapData.stations)) {
        if (sid.startsWith('P')) inboundQueues[sid] = [];
        if (sid.startsWith('D')) outboundOrders[sid] = null;
      }

      // Sync the real dynamic station count to the UI
      const stationTotalEl = document.getElementById('hud-stations-total');
      if (stationTotalEl) {
        stationTotalEl.innerText = `${Object.keys(mapData.stations).length} Total`;
      }

      initPackStations();
      updateSlottingComplianceStats();
      updateHudStats();
    }

    function getStoredParcelCount() {
      let count = 0;
      for (const rack of Object.values(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          const item = rack.floors[f];
          if (item !== null && !item.isReservedInbound) count++;
        }
      }
      return count;
    }

    function getTotalInboundWaiting() {
      let count = 0;
      for (const queue of Object.values(inboundQueues)) {
        count += queue.length;
      }
      return count;
    }

    function getTotalOutboundInTransit() {
      let count = 0;
      for (const ord of Object.values(outboundOrders)) {
        if (ord) count += Math.max(0, ord.totalCount - (ord.deliveredCount || 0));
      }
      return count;
    }

    function updateHudStats() {
      const storedEl = document.getElementById('hud-stored-count');
      const inEl = document.getElementById('hud-inbound-waiting');
      const outEl = document.getElementById('hud-outbound-transit');
      const fleetEl = document.getElementById('hud-fleet-status');
      const collEl = document.getElementById('hud-collision-status');
      const trafEl = document.getElementById('hud-traffic-events');

      const totalSlots = Object.keys(rackMemory).length * MAX_FLOORS;
      const stored = getStoredParcelCount();
      const inWaiting = getTotalInboundWaiting();
      const outTransit = getTotalOutboundInTransit();

      if (storedEl) {
        const pct = totalSlots > 0 ? ((stored / totalSlots) * 100).toFixed(1) : 0;
        storedEl.innerText = `${stored.toLocaleString()} / ${totalSlots.toLocaleString()} (${pct}%)`;
      }
      if (inEl) inEl.innerText = `${inWaiting} Parcels Queued`;
      if (outEl) outEl.innerText = `${outTransit} Awaiting Deposit`;

      if (fleetEl) {
        let charging = 0, shelving = 0, retrieving = 0, waiting = 0, lowBatt = 0, botsInBridge = 0;
        if (typeof trafficMetrics.activeCrossings === 'undefined') trafficMetrics.activeCrossings = new Map();

        for (const r of AMR_FLEET) {
          if (r.isWaiting) waiting++;
          if (r.battery <= 28.0 && r.state !== 'IDLE_CHARGING') lowBatt++;
          if (r.state === 'IDLE_CHARGING' || r.state === 'RETURNING_HOME') charging++;
          else if (r.state === 'MOVING_TO_PICKUP' || r.state === 'CARRYING_TO_RACK') shelving++;
          else if (r.state === 'ORDER_PICKING' || r.state === 'DELIVERING_ORDER_TO_BAY') retrieving++;
          else charging++;

          // Transit Bridge Congestion Tracking
          if (r.gridX >= 80 && r.gridX <= 89 && r.gridY >= 24 && r.gridY <= 25) {
            botsInBridge++;
            if (!trafficMetrics.activeCrossings.has(r.id)) trafficMetrics.activeCrossings.set(r.id, totalSimSeconds);
          } else if (trafficMetrics.activeCrossings.has(r.id)) {
            trafficMetrics.bridgeCrossings = (trafficMetrics.bridgeCrossings || 0) + 1;
            trafficMetrics.bridgeTransitTimeSec = (trafficMetrics.bridgeTransitTimeSec || 0) + (totalSimSeconds - trafficMetrics.activeCrossings.get(r.id));
            trafficMetrics.activeCrossings.delete(r.id);
          }
        }
        fleetEl.innerText = `${AMR_FLEET.length} Bots (${shelving} Shelve | ${retrieving} Retrieve | ${charging} Charge${waiting > 0 ? ` | ${waiting} Yield` : ''})`;
        
        const bridgeEl = document.getElementById('hud-bridge-traffic');
        if (bridgeEl) {
          const avgTime = trafficMetrics.bridgeCrossings > 0 ? (trafficMetrics.bridgeTransitTimeSec / trafficMetrics.bridgeCrossings).toFixed(1) : '0.0';
          bridgeEl.innerText = `${botsInBridge} Bots (${avgTime}s avg | ${trafficMetrics.bridgeCrossings || 0} crossed)`;
        }
      }

      if (collEl) {
        collEl.innerHTML = `<span style="color:#22c55e; font-weight:700;">0 Collisions</span> <span style="color:#94a3b8; font-size:10px;">(${trafficMetrics.collisionsPrevented} Safe Yields)</span>`;
      }
      if (trafEl) {
        trafEl.innerText = `${trafficMetrics.totalYields} Yields | ${trafficMetrics.totalOvertakes} Overtakes | ${trafficMetrics.totalReroutes} Reroutes`;
      }

      // Throughput & Business KPIs HUD updates
      const tpOrdersEl = document.getElementById('hud-tp-orders');
      const tpCycleEl = document.getElementById('hud-tp-cycle');
      const tpPicksEl = document.getElementById('hud-tp-picks');
      const tpDockEl = document.getElementById('hud-tp-dock');
      const tpVipEl = document.getElementById('hud-tp-vip');

      if (tpOrdersEl || tpCycleEl || tpPicksEl || tpDockEl || tpVipEl) {
        const kpis = computeWarehouseBusinessKpis();
        if (tpOrdersEl) tpOrdersEl.innerText = `${kpis.ordersFulfilledPerHour} orders/hr (${kpis.totalOrdersFulfilled} total)`;
        if (tpCycleEl) tpCycleEl.innerText = `${kpis.averageOrderCycleTimeSeconds}s (AR: 40-90s)`;
        if (tpPicksEl) tpPicksEl.innerText = `${kpis.pickRatePerRobotPerHour} picks/hr/bot (${kpis.fleetTotalPicksPerHour}/hr fleet)`;
        if (tpDockEl) tpDockEl.innerText = `${kpis.inboundDockAverageUtilizationPercent}% (Wait: ${kpis.inboundDockAverageQueueWaitSeconds}s)`;
        if (tpVipEl) tpVipEl.innerText = `${kpis.vipSlaCompliancePercent}% (All: ${kpis.overallSlaCompliancePercent}%)`;
      }

      const wrkCountEl = document.getElementById('hud-workers-count');
      const sftIntEl = document.getElementById('hud-safety-interventions');
      const pkrBpEl = document.getElementById('hud-packer-backpressure');
      const pkrUtEl = document.getElementById('hud-packer-utilization');
      if (wrkCountEl || sftIntEl || pkrBpEl || pkrUtEl) {
        const activeWorkers = (typeof HUMAN_WORKERS !== 'undefined' && HUMAN_WORKERS) ? HUMAN_WORKERS.length : 0;
        const sftStops = trafficMetrics.humanSafetyStops || 0;
        const sftSlows = trafficMetrics.humanSlowdowns || 0;
        const stations = (typeof PACK_STATIONS !== 'undefined' && PACK_STATIONS) ? Object.values(PACK_STATIONS) : [];
        const queuedBots = stations.reduce((sum, s) => sum + (s.queue ? s.queue.length : 0), 0);
        const stalls = stations.reduce((sum, s) => sum + (s.backpressureIncidents || 0), 0);
        const packedTotal = stations.reduce((sum, s) => sum + (s.totalOrdersPacked || 0), 0);
        const avgPackUtil = stations.length > 0 ? Number((stations.reduce((sum, s) => {
          const tot = (s.totalBusyTimeSec || 0) + (s.totalIdleTimeSec || 0);
          return sum + (tot > 0 ? (s.totalBusyTimeSec / tot) * 100 : 0);
        }, 0) / stations.length).toFixed(1)) : 0;

        if (wrkCountEl) {
          if (typeof humansEnabled !== 'undefined' && !humansEnabled) {
            wrkCountEl.innerHTML = `<span style="color:#94a3b8;font-weight:700;">Disabled (OFF)</span> <span style="color:#64748b;font-size:10px;">(Free-Flow)</span>`;
          } else {
            wrkCountEl.innerHTML = `<span style="color:#a3e635;font-weight:700;">${activeWorkers} Active 👷</span> <span style="color:#94a3b8;font-size:10px;">(ISO 3691-4)</span>`;
          }
        }
        if (sftIntEl) {
          if (typeof humansEnabled !== 'undefined' && !humansEnabled) {
            sftIntEl.innerHTML = `<span style="color:#64748b;font-weight:700;">Bubbles Inactive</span> <span style="color:#64748b;font-size:10px;">(Full Speed)</span>`;
          } else {
            sftIntEl.innerHTML = `<span style="color:#38bdf8;font-weight:700;">${sftStops} Stops</span> | <span style="color:#fbbf24;">${sftSlows} Decels</span> <span style="color:#22c55e;font-size:10px;">(0 Hits)</span>`;
          }
        }
        if (pkrBpEl) pkrBpEl.innerHTML = `<span style="color:${queuedBots > 0 ? '#ef4444' : '#22c55e'};font-weight:700;">${queuedBots} Queued</span> <span style="color:#94a3b8;font-size:10px;">(${stalls} Stalls)</span>`;
        if (pkrUtEl) pkrUtEl.innerHTML = `<span style="color:#34d399;font-weight:700;">${avgPackUtil}%</span> <span style="color:#94a3b8;font-size:10px;">(${packedTotal} pkd)</span>`;
      }

      // ABC Storage & Slotting HUD elements
      const slotPolEl = document.getElementById('hud-slot-policy');
      const slotCompEl = document.getElementById('hud-slot-compliance');
      const slotPickDistEl = document.getElementById('hud-slot-pick-dist');
      const slotDistSavedEl = document.getElementById('hud-slot-dist-saved');
      const slotReslotMovesEl = document.getElementById('hud-slot-reslot-moves');

      if (slotPolEl) slotPolEl.innerText = 'ABC / Velocity';
      if (slotCompEl) slotCompEl.innerText = `${WAREHOUSE_SLOTTING_METRICS.slottingCompliancePercent}% Optimal`;
      if (slotPickDistEl) {
        const avgDist = WAREHOUSE_SLOTTING_METRICS.averagePickDistanceCells;
        const avgMeters = (avgDist * 0.35).toFixed(1);
        slotPickDistEl.innerText = `${avgDist}c (~${avgMeters}m)`;
      }
      if (slotDistSavedEl) {
        const savedPct = WAREHOUSE_SLOTTING_METRICS.travelDistanceSavedPercent;
        slotDistSavedEl.innerText = `+${savedPct}% vs Random`;
      }
      if (slotReslotMovesEl) {
        const moves = WAREHOUSE_SLOTTING_METRICS.reSlottingAndConsolidation.totalRelocationsExecuted;
        slotReslotMovesEl.innerText = `${moves} Completed`;
      }

      // Feature 8: Fleet Health, Maintenance & Charger Contention HUD Elements
      const fleetHealthEl = document.getElementById('hud-maint-fleet-health');
      const faultedBotsEl = document.getElementById('hud-maint-faulted-bots');
      const chargerHealthEl = document.getElementById('hud-maint-charger-health');
      const chargerQueueEl = document.getElementById('hud-maint-charger-queue');
      const tasksReassignedEl = document.getElementById('hud-maint-tasks-reassigned');

      const totalBots = AMR_FLEET.length;
      const maintenanceBots = AMR_FLEET.filter(b => b.isFaulted || b.state === 'HARDWARE_FAULT' || b.state === 'MARKED_FOR_MAINTENANCE' || b.isUnderMaintenance).length;
      const activeBots = totalBots - maintenanceBots;

      if (fleetHealthEl) fleetHealthEl.innerText = `${activeBots} / ${totalBots} Active`;
      if (faultedBotsEl) {
        faultedBotsEl.innerText = `${maintenanceBots} In Maintenance`;
        faultedBotsEl.style.color = maintenanceBots > 0 ? '#ef4444' : '#38bdf8';
      }

      const totalChargers = CHARGING_PORTS.length;
      const faultedChargers = CHARGING_PORTS.filter(p => p.isFaulted).length;
      const activeChargers = totalChargers - faultedChargers;

      if (chargerHealthEl) {
        chargerHealthEl.innerText = `${activeChargers} / ${totalChargers} Operational`;
        chargerHealthEl.style.color = faultedChargers > 0 ? '#f59e0b' : '#22c55e';
      }

      if (chargerQueueEl) {
        const qLen = CHARGER_WAITING_QUEUE.length;
        const avgWait = FLEET_FAILURE_MAINTENANCE_METRICS.averageChargerQueueWaitSeconds;
        chargerQueueEl.innerText = `${qLen} Waiting (${avgWait}s avg)`;
        chargerQueueEl.style.color = qLen > 0 ? '#f59e0b' : '#38bdf8';
      }

      if (tasksReassignedEl) {
        tasksReassignedEl.innerText = `${FLEET_FAILURE_MAINTENANCE_METRICS.totalTasksReassigned} Reassigned`;
      }

      // Feature 9: Returns & Kiva Mode HUD
      const returnsQueuedEl = document.getElementById('hud-returns-queued');
      const returnsStowedEl = document.getElementById('hud-returns-stowed');
      const returnsCancelledEl = document.getElementById('hud-returns-cancelled');
      const kivaStatusEl = document.getElementById('hud-kiva-status');
      const kivaPodsEl = document.getElementById('hud-kiva-pods');
      const kivaDeliveredEl = document.getElementById('hud-kiva-delivered');

      if (returnsQueuedEl) {
        const pendingReturns = returnMissions.filter(m => m.status === 'PENDING' || m.status === 'ASSIGNED').length;
        returnsQueuedEl.innerText = `${pendingReturns} Mission${pendingReturns !== 1 ? 's' : ''}`;
        returnsQueuedEl.style.color = pendingReturns > 0 ? '#34d399' : '#94a3b8';
      }
      if (returnsStowedEl) returnsStowedEl.innerText = `${WAREHOUSE_RETURNS_METRICS.totalReturnsParcelsStowed} Items`;
      if (returnsCancelledEl) {
        returnsCancelledEl.innerText = `${WAREHOUSE_RETURNS_METRICS.totalOrdersCancelled} Cancelled (${WAREHOUSE_RETURNS_METRICS.totalCancelledItemsRestored} Items Restored)`;
        returnsCancelledEl.style.color = WAREHOUSE_RETURNS_METRICS.totalOrdersCancelled > 0 ? '#f87171' : '#94a3b8';
      }
      if (kivaStatusEl) {
        kivaStatusEl.innerText = KIVA_MODE_ENABLED ? 'ENABLED ✅' : 'DISABLED';
        kivaStatusEl.style.color = KIVA_MODE_ENABLED ? '#fbbf24' : '#64748b';
      }
      if (kivaPodsEl) {
        kivaPodsEl.innerText = KIVA_MODE_ENABLED ? `${MOBILE_PODS.length} Pods (${MOBILE_PODS.filter(p => p.state !== 'IDLE').length} Active)` : '0 Pods (Mode Off)';
        kivaPodsEl.style.color = KIVA_MODE_ENABLED ? '#fbbf24' : '#64748b';
      }
      if (kivaDeliveredEl) {
        kivaDeliveredEl.innerText = `${WAREHOUSE_RETURNS_METRICS.kivaPodsDelivered} Deliveries | ${WAREHOUSE_RETURNS_METRICS.kivaPicksCompleted} Picks`;
      }
    }


    function updateSlottingComplianceStats() {
      let totalItems = 0;
      let optimalItems = 0;
      const zoneBreakdown = { ZONE_A: 0, ZONE_B: 0, ZONE_C: 0 };
      const skuBreakdown = {
        CLASS_A: { total: 0, optimal: 0 },
        CLASS_B: { total: 0, optimal: 0 },
        CLASS_C: { total: 0, optimal: 0 }
      };

      for (const rack of Object.values(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          const item = rack.floors[f];
          if (item && !item.isReservedInbound) {
            totalItems++;
            zoneBreakdown[rack.zone] = (zoneBreakdown[rack.zone] || 0) + 1;
            const skuInfo = SKU_CATALOG.find(c => c.sku === item.sku);
            const vCls = skuInfo ? skuInfo.velocityClass : 'A';
            const tierKey = `CLASS_${vCls}`;
            if (skuBreakdown[tierKey]) skuBreakdown[tierKey].total++;

            const isOptimal = (
              (vCls === 'A' && rack.zone === 'ZONE_A') ||
              (vCls === 'B' && rack.zone === 'ZONE_B') ||
              (vCls === 'C' && rack.zone === 'ZONE_C')
            );
            if (isOptimal) {
              optimalItems++;
              if (skuBreakdown[tierKey]) skuBreakdown[tierKey].optimal++;
            }
          }
        }
      }

      WAREHOUSE_SLOTTING_METRICS.totalStoredParcels = totalItems;
      WAREHOUSE_SLOTTING_METRICS.slottingCompliancePercent = totalItems > 0
        ? Number(((optimalItems / totalItems) * 100).toFixed(1))
        : 100.0;

      // Distance Saved % vs Baseline
      if (WAREHOUSE_SLOTTING_METRICS.totalPicksExecuted > 0) {
        const avgPick = WAREHOUSE_SLOTTING_METRICS.averagePickDistanceCells;
        const baseline = WAREHOUSE_SLOTTING_METRICS.baselineRandomPickDistanceEstimate;
        const savedPct = Math.max(0, Number((((baseline - avgPick) / baseline) * 100).toFixed(1)));
        WAREHOUSE_SLOTTING_METRICS.travelDistanceSavedPercent = savedPct;
      }
    }

    // Intelligent ABC / Velocity Slot Allocation Policy
    function findOptimalSlotForSku(sku, originDockId = null, policy = 'ABC_VELOCITY') {
      const skuInfo = SKU_CATALOG.find(c => c.sku === sku) || SKU_CATALOG[0];
      const vClass = skuInfo.velocityClass || 'A';

      if (policy === 'RANDOM') {
        const emptySlots = [];
        for (const rack of Object.values(rackMemory)) {
          for (let f = 0; f < MAX_FLOORS; f++) {
            if (rack.floors[f] === null) {
              emptySlots.push({ rack, floorIndex: f, floorNum: f + 1 });
            }
          }
        }
        return emptySlots.length > 0 ? emptySlots[Math.floor(Math.random() * emptySlots.length)] : null;
      }

      // ABC Target Zone Ordering
      let targetZones = ['ZONE_A', 'ZONE_B', 'ZONE_C'];
      if (vClass === 'B') targetZones = ['ZONE_B', 'ZONE_A', 'ZONE_C'];
      else if (vClass === 'C') targetZones = ['ZONE_C', 'ZONE_B', 'ZONE_A'];

      let dockPos = null;
      if (originDockId && mapData && mapData.stations && mapData.stations[originDockId]) {
        dockPos = { x: mapData.stations[originDockId].x, y: mapData.stations[originDockId].y };
      }

      for (const z of targetZones) {
        const catSlots = [];
        const anySlots = [];
        for (const rack of Object.values(rackMemory)) {
          if (rack.zone === z) {
            for (let f = 0; f < MAX_FLOORS; f++) {
              if (rack.floors[f] === null) {
                const slot = { rack, floorIndex: f, floorNum: f + 1 };
                if (rack.categorySku === sku) {
                  catSlots.push(slot);
                }
                anySlots.push(slot);
              }
            }
          }
        }

        const candidates = catSlots.length > 0 ? catSlots : anySlots;
        if (candidates.length > 0) {
          let bestSlot = null;
          let bestScore = Infinity;

          for (const cand of candidates) {
            const rx = cand.rack.x;
            const ry = cand.rack.y;
            const dIn = dockPos ? (Math.abs(rx - dockPos.x) + Math.abs(ry - dockPos.y)) : (cand.rack.dockCost || 20);
            const dOut = cand.rack.minOutboundDist || 20.0;
            // Floor 1 & 2 (index 1 & 2, tiers 2 & 3) = Golden Zone
            const f = cand.floorIndex;
            const tierPen = (f === 1 || f === 2) ? 0.0 : ((f === 0 || f === 3) ? 1.0 : 2.5);
            const score = 0.5 * dIn + 0.5 * dOut + tierPen;

            if (score < bestScore) {
              bestScore = score;
              bestSlot = cand;
            }
          }
          if (bestSlot) return bestSlot;
        }
      }

      // If all preferred zones are completely full, find any empty slot
      for (const rack of Object.values(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          if (rack.floors[f] === null) {
            return { rack, floorIndex: f, floorNum: f + 1 };
          }
        }
      }
      return null;
    }

    function findRandomSlotForSku(sku) {
      return findOptimalSlotForSku(sku, null, 'ABC_VELOCITY');
    }

    // Background Re-Slotting & Consolidation Task
    function runBackgroundSlottingOptimization(maxMoves = 5) {
      if (!rackMemory || Object.keys(rackMemory).length === 0) return { status: 'empty', moves: [] };

      const movesExecuted = [];
      let promotions = 0;
      let demotions = 0;
      let consolidations = 0;
      let distSavedTotal = 0;

      // 1. Class A Promotions (Move Class A items from Zone C/B to Zone A)
      for (const rack of Object.values(rackMemory)) {
        if (movesExecuted.length >= maxMoves) break;
        if (rack.zone === 'ZONE_C' || rack.zone === 'ZONE_B') {
          for (let f = 0; f < MAX_FLOORS; f++) {
            const item = rack.floors[f];
            if (item && !item.isReservedInbound && !item.isReservedOutbound) {
              const skuInfo = SKU_CATALOG.find(c => c.sku === item.sku);
              if (skuInfo && skuInfo.velocityClass === 'A') {
                // Find empty slot in ZONE_A
                let targetSlot = null;
                for (const tRack of Object.values(rackMemory)) {
                  if (tRack.zone === 'ZONE_A') {
                    for (let tf = 0; tf < MAX_FLOORS; tf++) {
                      if (tRack.floors[tf] === null) {
                        targetSlot = { rack: tRack, floorIndex: tf };
                        break;
                      }
                    }
                    if (targetSlot) break;
                  }
                }

                if (targetSlot) {
                  const distSaved = Math.max(0, (rack.dockCost || 25) - (targetSlot.rack.dockCost || 10));
                  distSavedTotal += distSaved;
                  promotions++;
                  targetSlot.rack.floors[targetSlot.floorIndex] = item;
                  rack.floors[f] = null;

                  movesExecuted.push({
                    type: 'PROMOTION',
                    parcelId: item.parcel_id,
                    sku: item.sku,
                    from: `${rack.x},${rack.y}:L${f+1}`,
                    to: `${targetSlot.rack.x},${targetSlot.rack.y}:L${targetSlot.floorIndex+1}`,
                    distSaved: distSaved
                  });
                  break;
                }
              }
            }
          }
        }
      }

      // 2. Class C Demotions (Move slow-moving Class C items from Zone A to Zone C)
      for (const rack of Object.values(rackMemory)) {
        if (movesExecuted.length >= maxMoves) break;
        if (rack.zone === 'ZONE_A') {
          for (let f = 0; f < MAX_FLOORS; f++) {
            const item = rack.floors[f];
            if (item && !item.isReservedInbound && !item.isReservedOutbound) {
              const skuInfo = SKU_CATALOG.find(c => c.sku === item.sku);
              if (skuInfo && skuInfo.velocityClass === 'C') {
                let targetSlot = null;
                for (const tRack of Object.values(rackMemory)) {
                  if (tRack.zone === 'ZONE_C') {
                    for (let tf = 0; tf < MAX_FLOORS; tf++) {
                      if (tRack.floors[tf] === null) {
                        targetSlot = { rack: tRack, floorIndex: tf };
                        break;
                      }
                    }
                    if (targetSlot) break;
                  }
                }

                if (targetSlot) {
                  demotions++;
                  targetSlot.rack.floors[targetSlot.floorIndex] = item;
                  rack.floors[f] = null;
                  movesExecuted.push({
                    type: 'DEMOTION',
                    parcelId: item.parcel_id,
                    sku: item.sku,
                    from: `${rack.x},${rack.y}:L${f+1}`,
                    to: `${targetSlot.rack.x},${targetSlot.rack.y}:L${targetSlot.floorIndex+1}`,
                    distSaved: 0
                  });
                  break;
                }
              }
            }
          }
        }
      }

      // 3. Rack Consolidation (De-fragmenting racks with <= 2 items)
      for (const rack of Object.values(rackMemory)) {
        if (movesExecuted.length >= maxMoves) break;
        const occ = rack.floors.filter(f => f !== null && !f.isReservedInbound && !f.isReservedOutbound).length;
        if (occ > 0 && occ <= 2) {
          for (let f = 0; f < MAX_FLOORS; f++) {
            const item = rack.floors[f];
            if (item && !item.isReservedInbound && !item.isReservedOutbound) {
              let targetSlot = null;
              for (const tRack of Object.values(rackMemory)) {
                if (tRack !== rack && tRack.categorySku === item.sku && tRack.zone === rack.zone) {
                  for (let tf = 0; tf < MAX_FLOORS; tf++) {
                    if (tRack.floors[tf] === null) {
                      targetSlot = { rack: tRack, floorIndex: tf };
                      break;
                    }
                  }
                  if (targetSlot) break;
                }
              }

              if (targetSlot) {
                consolidations++;
                targetSlot.rack.floors[targetSlot.floorIndex] = item;
                rack.floors[f] = null;
                movesExecuted.push({
                  type: 'CONSOLIDATION',
                  parcelId: item.parcel_id,
                  sku: item.sku,
                  from: `${rack.x},${rack.y}:L${f+1}`,
                  to: `${targetSlot.rack.x},${targetSlot.rack.y}:L${targetSlot.floorIndex+1}`,
                  distSaved: 0
                });
                break;
              }
            }
          }
        }
      }

      const reslot = WAREHOUSE_SLOTTING_METRICS.reSlottingAndConsolidation;
      reslot.totalOptimizationPasses++;
      reslot.totalRelocationsExecuted += movesExecuted.length;
      reslot.classAPromotions += promotions;
      reslot.classCDemotions += demotions;
      reslot.tierConsolidations += consolidations;
      reslot.cumulativeDistanceSavedCells += distSavedTotal;
      reslot.lastOptimizationSimTime = Number((totalSimSeconds || 0).toFixed(1));
      reslot.auditTrail = [...movesExecuted, ...reslot.auditTrail].slice(0, 30);

      updateSlottingComplianceStats();

      if (movesExecuted.length > 0) {
        logTerminal('OPTIMIZE', 'tag-yield', `🔄 <strong>Slotting Optimizer</strong>: Executed <strong>${movesExecuted.length} moves</strong> (${promotions} A-Promotions, ${demotions} C-Demotions, ${consolidations} Tier Consolidations) | Saved <span style="color:#22c55e;font-weight:700;">+${distSavedTotal.toFixed(1)}c</span> future travel distance | Compliance: <span style="color:#38bdf8;font-weight:700;">${WAREHOUSE_SLOTTING_METRICS.slottingCompliancePercent}%</span>`);
        updateHudStats();
      }

      return {
        status: 'ok',
        movesExecutedCount: movesExecuted.length,
        promotions,
        demotions,
        consolidations,
        distanceSavedCells: distSavedTotal,
        moves: movesExecuted
      };
    }

    let DECENTRALIZED_CBBA_MODE = true; // Toggle for Phase 5 vs Baseline Hungarian
    let BASELINE_STOP_AND_WAIT_MODE = false; // Toggle for Phase 11 FCFS baseline comparison

