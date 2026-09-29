// =========================================================================
// AUTONOMOUS FLEET & MISSION WATCHDOG ENGINE
// Prevents orphaned missions, locks on docks/bays, and frozen robots
// Ensures uninterrupted 24/7 continuous warehouse operations
// =========================================================================
let lastWatchdogTime = 0;

function logWatchdogSnapshot(triggerType, robot) {
    if (typeof window === 'undefined' || !window._benchStats) return;
    window._benchStats.stuckEvents++;
    window._benchStats.watchdogTriggers[triggerType] = (window._benchStats.watchdogTriggers[triggerType] || 0) + 1;
    
    const wfg = {};
    for (const r of AMR_FLEET) {
        let waitingOn = r.yieldTo || r._pinnedUntilBotId || r.escapePartnerId;
        if (waitingOn) wfg[r.id] = waitingOn;
    }
    
    const visited = new Set(), stack = new Set(), cycles = [];
    function dfs(node, path) {
        if (stack.has(node)) {
            cycles.push(path.slice(path.indexOf(node)).join(' -> ') + ' -> ' + node);
            return;
        }
        if (visited.has(node)) return;
        visited.add(node); stack.add(node);
        if (wfg[node]) dfs(wfg[node], [...path, node]);
        stack.delete(node);
    }
    for (const node of Object.keys(wfg)) if (!visited.has(node)) dfs(node, []);
    
    console.log(`[WATCHDOG: ${triggerType}] Snapshot for ${robot ? robot.id : 'GLOBAL'}:`);
    if (robot) {
        console.log(`  Cell: (${robot.gridX}, ${robot.gridY}), State: ${robot.state}`);
    }
    console.log(`  Wait-For Graph:`, wfg);
    if (cycles.length > 0) console.warn(`  🚨 CYCLES DETECTED:`, cycles);
}

function runFleetWatchdog(now) {
  if (now - lastWatchdogTime < 2000 / (typeof simSpeed !== 'undefined' ? simSpeed : 1)) return;
  lastWatchdogTime = now;

  // 1. Recover orphaned or stuck Inbound Missions
  for (let i = inboundMissions.length - 1; i >= 0; i--) {
    const m = inboundMissions[i];
    if (m.status === 'ASSIGNED') {
      const assignedBot = AMR_FLEET.find(b => b.id === m.assignedRobotId);
      const isInvalid = !assignedBot || assignedBot.isFaulted || assignedBot.state === 'OUT_OF_CHARGE' || assignedBot.state === 'RETURNING_HOME' || !assignedBot.inboundMission || assignedBot.inboundMission.id !== m.id;
      if (isInvalid) {
        if (typeof logTerminal === 'function') logTerminal('SYSTEM', 'tag-yield', `⚠️ Watchdog recovered Inbound Mission <strong>${m.id}</strong>.`);
        if (assignedBot && assignedBot.carriedParcels && assignedBot.carriedParcels.length > 0) {
          m.parcels = [...assignedBot.carriedParcels, ...(m.parcels || [])];
          assignedBot.carriedParcels = [];
          assignedBot.cargo = null;
        }
        m.status = 'PENDING'; m.assignedRobotId = null;
        if (assignedBot) { assignedBot.inboundMission = null; if (typeof releaseAllTerminalClaimsForRobot === 'function') releaseAllTerminalClaimsForRobot(assignedBot.id); }
      }
    }
    if (!m.parcels || m.parcels.length === 0) inboundMissions.splice(i, 1);
  }

  // 2. Recover orphaned or stuck Outbound Orders
  for (let i = outboundMissions.length - 1; i >= 0; i--) {
    const m = outboundMissions[i];
    if (m.status === 'ASSIGNED') {
      const assignedBot = AMR_FLEET.find(b => b.id === m.assignedRobotId);
      const isInvalid = !assignedBot || assignedBot.isFaulted || assignedBot.state === 'OUT_OF_CHARGE' || assignedBot.state === 'RETURNING_HOME' || !assignedBot.outboundMission || assignedBot.outboundMission.orderId !== m.orderId;
      if (isInvalid) {
        if (typeof logTerminal === 'function') logTerminal('SYSTEM', 'tag-yield', `⚠️ Watchdog recovered Outbound Order <strong>${m.orderId}</strong>.`);
        if (assignedBot && assignedBot.orderBox && assignedBot.orderBox.items) {
          for (const it of assignedBot.orderBox.items) {
            if (it && it.parcel_id) {
              m.itemsToPick.unshift({ rack: { x: it.rackX || 40, y: it.rackY || 20, floors: [it] }, floorIndex: it.floorIndex || 0, parcel: it, forOrderId: m.orderId });
            }
          }
          assignedBot.orderBox = null;
        }
        m.status = 'PENDING'; m.assignedRobotId = null;
        if (assignedBot) { assignedBot.outboundMission = null; if (typeof releaseAllTerminalClaimsForRobot === 'function') releaseAllTerminalClaimsForRobot(assignedBot.id); }
      }
    }
    if ((!m.itemsToPick || m.itemsToPick.length === 0) && m.status === 'PENDING') {
      if (outboundOrders[m.bayId]) outboundOrders[m.bayId] = null;
      outboundMissions.splice(i, 1);
    }
  }

  // 3. Clean up orphan dock or bay locks
  for (const [bayId, ord] of Object.entries(outboundOrders)) {
    if (ord && !outboundMissions.some(m => m.bayId === bayId || (m.pendingDeliveries && m.pendingDeliveries.some(d => d.bayId === bayId)))) {
      outboundOrders[bayId] = null;
    }
  }

  // 4. Check for active robots that arrived at target or have empty paths
  for (const r of AMR_FLEET) {
    if ((r.state === 'CARRYING_TO_RACK' || r.state === 'ORDER_PICKING' || r.state === 'DELIVERING_ORDER_TO_BAY' || r.state === 'RETURNING_HOME') && (!r.path || r.path.length === 0 || r.pathIndex >= r.path.length)) {
      if (typeof onRobotReachedDestination === 'function') onRobotReachedDestination(r);
    }
  }

  // =========================================================================
  // UNIVERSAL STUCK DETECTORS (Runs in all modes to catch Map/Geometry bugs)
  // =========================================================================
  for (const r of AMR_FLEET) {
    if (r.state === 'IDLE_CHARGING' || r.state === 'OUT_OF_CHARGE' || r.state === 'LOADING_INBOUND' || r.state === 'IDLE') {
      r._stuckCheckX = undefined;
      r._stuckCheckY = undefined;
      r._stuckSeconds = 0;
      continue;
    }
    const dtWatchdog = 2.0 / (typeof simSpeed !== 'undefined' ? simSpeed : 1);
    if (r._stuckCheckX === undefined || Math.hypot(r.gridX - r._stuckCheckX, r.gridY - r._stuckCheckY) >= 0.75) {
      r._stuckCheckX = r.gridX;
      r._stuckCheckY = r.gridY;
      r._stuckSeconds = 0;
    } else {
      r._stuckSeconds = (r._stuckSeconds || 0) + dtWatchdog;
      if (r._stuckSeconds > 15.0) {
        logWatchdogSnapshot('PER_BOT_15S_STUCK', r);
        if (typeof logTerminal === 'function') logTerminal('SYSTEM', 'tag-yield', `⚠️ <strong>${r.id}</strong> stuck at (${r.gridX},${r.gridY}) for 15s. Forcing hard reroute.`);
        r.isWaiting = false;
        r._wasWaitingThisFrame = false;
        r.waitTimer = 0;
        r.isBackingUp = false;
        if (r.statusBadge === 'WAIT') r.statusBadge = null;
        if (typeof Traffic !== 'undefined') Traffic.release(r);
        if (typeof releaseAllTerminalClaimsForRobot === 'function') releaseAllTerminalClaimsForRobot(r.id);
        
        if (r.path && r.path.length > 0) {
          const dest = r.path[r.path.length - 1];
          const newPath = typeof findPath === 'function' ? findPath(r.gridX, r.gridY, dest.x, dest.y) : [];
          if (newPath.length > 0) {
            if (typeof setRobotPath === 'function') setRobotPath(r, newPath);
          } else {
            if (typeof onRobotReachedDestination === 'function') onRobotReachedDestination(r);
          }
        } else {
          if (typeof onRobotReachedDestination === 'function') onRobotReachedDestination(r);
        }
        r._stuckCheckX = r.gridX;
        r._stuckCheckY = r.gridY;
        r._stuckSeconds = 0;
      }
    }
  }

  if (typeof dispatchFleet === 'function') dispatchFleet();

  // 5. Scrub stale UI badges for idle robots
  for (const r of AMR_FLEET) {
      if (r.state === 'IDLE' || r.state === 'IDLE_CHARGING' || r.state === 'RETURNING_HOME') {
          if (r.statusBadge === 'STATION BUSY' || r.statusBadge === 'WAIT') {
              r.statusBadge = null;
          }
          if (r.targetDesc && r.targetDesc.includes("Waiting for Packer")) {
              r.targetDesc = null;
          }
      }
  }
}