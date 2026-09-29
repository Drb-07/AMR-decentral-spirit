    // ==========================================
    // REAL-WORLD AMR FLEET & TRAFFIC CONTROL SYSTEM
    // (Zero-Collision, Overtaking, Waiting, Rerouting, Flow-Directed Aisles)
    // ==========================================
    const AMR_COUNT = 8;
    const AMR_FLEET = [];
    const inboundMissions = []; // Single consolidated mission per inbound shipment (1 robot per dock)
    const outboundMissions = []; // Single consolidated mission per customer order (1 robot per order / Giant Box)
    const returnMissions = [];  // Feature 9A: Returns/putback missions (customer returns → stow back in rack)
    const ROBOT_BASE_SPEED = 4.2; // Cells per second at 1x simSpeed

    // ==========================================
    // FEATURE 9: RETURNS/PUTBACK FLOW, ORDER CANCELLATION & KIVA MODE
    // ==========================================
    let returnSequence = 0;
    let KIVA_MODE_ENABLED = false;
    const MOBILE_PODS = []; // Kiva-style mobile shelf units
    const PICKER_STATIONS = []; // Fixed human picker workstations for Kiva mode

    // Returns & Fulfillment-Flow KPIs
    const WAREHOUSE_RETURNS_METRICS = {
      totalReturnsMissionsCreated: 0,
      totalReturnsParcelsStowed: 0,
      totalOrdersCancelled: 0,
      totalCancelledItemsRestored: 0,
      kivaPodsDelivered: 0,
      kivaPicksCompleted: 0,
      activeKivaMode: false
    };

    function cancelActiveOrder() {
      if (!outboundMissions || outboundMissions.length === 0) {
        if (typeof logTerminal === 'function') logTerminal('SYSTEM', 'tag-yield', 'ℹ️ No active outbound orders available to cancel.');
        return;
      }
      
      let mIdx = outboundMissions.findIndex(m => m.status === 'ASSIGNED');
      if (mIdx === -1) mIdx = Math.floor(Math.random() * outboundMissions.length);
      const mission = outboundMissions[mIdx];
      let itemsRestored = 0;

      if (mission.itemsToPick) {
        for (const pick of mission.itemsToPick) {
          if (pick.rack && pick.parcel) {
            pick.rack.floors[pick.floorIndex] = pick.parcel;
            itemsRestored++;
          }
        }
      }

      if (mission.assignedRobotId) {
        const bot = AMR_FLEET.find(b => b.id === mission.assignedRobotId);
        if (bot && bot.outboundMission && bot.outboundMission.orderId === mission.orderId) {
          if (bot.orderBox && bot.orderBox.items) {
            itemsRestored += bot.orderBox.items.length;
          }
          bot.orderBox = null;
          bot.outboundMission = null;
          bot.payloadWeight = 0;
          bot.payloadDamping = 1.0;
          bot.statusBadge = 'CANCELLED';
          bot.targetDesc = `Order ${mission.orderId} Cancelled`;
          if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>Order ${mission.orderId}</strong> Cancelled! <strong>${bot.id}</strong> aborting mission and returning to charger.`);
          if (typeof routeRobotToNearestCharger === 'function') routeRobotToNearestCharger(bot, 'OPERATOR_RECALL');
        }
      } else {
        if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>Order ${mission.orderId}</strong> Cancelled before dispatch! Items restored to inventory.`);
      }

      if (typeof outboundOrders !== 'undefined' && outboundOrders[mission.bayId]) outboundOrders[mission.bayId] = null;
      outboundMissions.splice(mIdx, 1);

      WAREHOUSE_RETURNS_METRICS.totalOrdersCancelled++;
      WAREHOUSE_RETURNS_METRICS.totalCancelledItemsRestored += itemsRestored;
      
      if (typeof updateHudStats === 'function') updateHudStats();
      if (typeof dispatchFleet === 'function') dispatchFleet();
    }

    // Delivery Importance Tiers with Base Urgency & SLA Windows
    const IMPORTANCE_TIERS = {
      VIP_EXPRESS: {
        code: 'VIP_EXPRESS',
        label: 'VIP Express (1-Hr SLA)',
        shortLabel: 'VIP',
        baseUrgency: 85,
        color: '#ef4444', // Red
        slaSeconds: 45
      },
      SAME_DAY: {
        code: 'SAME_DAY',
        label: 'Same-Day Urgent',
        shortLabel: 'URGENT',
        baseUrgency: 65,
        color: '#f97316', // Orange
        slaSeconds: 75
      },
      STANDARD: {
        code: 'STANDARD',
        label: 'Standard (2-Day)',
        shortLabel: 'STD',
        baseUrgency: 40,
        color: '#38bdf8', // Cyan
        slaSeconds: 120
      },
      ECONOMY: {
        code: 'ECONOMY',
        label: 'Economy Bulk',
        shortLabel: 'ECO',
        baseUrgency: 20,
        color: '#94a3b8', // Slate grey
        slaSeconds: 180
      }
    };

    // Realistic Urgency Calculation Formula:
    // Urgency = BaseImportance + TimeBonus - WeightPenalty
    function calculateRobotUrgency(r) {
      if (!r) return 0;
      if (r.state === 'IDLE_CHARGING') return 0;
      if (r.state === 'RETURNING_HOME') return 15;
      if (r.state === 'IDLE') return 20;

      let baseUrgency = 40;
      let slaSeconds = 90;
      let createdAt = r.missionStartTime || Date.now();
      let totalWeight = 0;

      if (r.orderBox) {
        const tier = r.orderBox.importance || IMPORTANCE_TIERS.STANDARD;
        baseUrgency = tier.baseUrgency;
        slaSeconds = tier.slaSeconds;
        totalWeight = r.orderBox.totalWeight || 5;
      } else if (r.carriedParcels && r.carriedParcels.length > 0) {
        const highestTier = r.carriedParcels.reduce((prev, curr) => {
          const t = curr.importance || IMPORTANCE_TIERS.STANDARD;
          return t.baseUrgency > prev.baseUrgency ? t : prev;
        }, IMPORTANCE_TIERS.STANDARD);
        baseUrgency = highestTier.baseUrgency;
        slaSeconds = highestTier.slaSeconds;
        totalWeight = r.carriedParcels.reduce((sum, p) => sum + (parseFloat(p.weight) || 3), 0);
      } else if (r.inboundMission) {
        const tier = r.inboundMission.importance || IMPORTANCE_TIERS.STANDARD;
        baseUrgency = tier.baseUrgency;
        slaSeconds = tier.slaSeconds;
        totalWeight = r.inboundMission.totalWeight || 5;
      }

      // Elapsed time escalation: +0 to +25 as deadline approaches
      const elapsedSec = Math.max(0, (Date.now() - createdAt) / 1000 * simSpeed);
      const timeBonus = Math.min(25, (elapsedSec / slaSeconds) * 25);

      // Weight penalty: heavy freight (>15kg) reduces aggressive high-speed maneuvering
      const weightPenalty = Math.min(20, (totalWeight / 3.0));

      // Battery penalty: low SoC (<30%) reduces aggressive overtaking to conserve power
      let batteryPenalty = 0;
      if (r.battery < 30.0) {
        batteryPenalty = Math.min(25, (30.0 - r.battery) * 1.5);
      }

      const urgency = Math.round(Math.max(10, Math.min(100, baseUrgency + timeBonus - weightPenalty - batteryPenalty)));
      return urgency;
    }

    // Traffic Coordination & Safety Metrics
    const trafficMetrics = {
      totalYields: 0,
      totalOvertakes: 0,
      totalReroutes: 0,
      collisionsPrevented: 0,
      humanSafetyStops: 0,
      humanSlowdowns: 0,
      packStationBackpressureCount: 0
    };

