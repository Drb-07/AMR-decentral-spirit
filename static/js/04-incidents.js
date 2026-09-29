    // =========================================================================
    // FLEET PROBLEMS, COLLISIONS & INCIDENT DIAGNOSTICS ENGINE
    // =========================================================================
    const FLEET_INCIDENTS = [];
    let incidentIdCounter = 1000;
    let currentProblemFilter = 'ALL';
    const COLLISION_SPARKS = []; // Active collision spark animations on map

    function logBotProblem(type, robotId, options = {}) {
      const now = Date.now();
      const r = AMR_FLEET.find(b => b.id === robotId);
      const peerId = options.peerId || null;
      const severity = options.severity || (type === 'COLLISION' || type === 'OUT_OF_CHARGE' ? 'CRITICAL' : 'WARNING');
      const x = options.x !== undefined ? options.x : (r ? r.gridX : 0);
      const y = options.y !== undefined ? options.y : (r ? r.gridY : 0);
      const desc = options.desc || `${type} event detected on ${robotId}`;

      // Throttled deduplication: don't create multiple active incidents for same bot & type within 4s
      const existing = FLEET_INCIDENTS.find(inc => 
        inc.status === 'ACTIVE' && 
        inc.type === type && 
        inc.robotId === robotId &&
        (!peerId || inc.peerId === peerId)
      );

      if (existing) {
        existing.lastSeenTime = now;
        existing.desc = desc;
        updateProblemsBadge();
        if (currentMainTab === 'problems') updateProblemsDashboard();
        return existing;
      }

      incidentIdCounter++;
      const timeStr = new Date(now).toTimeString().split(' ')[0];
      const incident = {
        id: `INC-${incidentIdCounter}`,
        type,
        severity,
        robotId,
        peerId,
        x,
        y,
        startTime: now,
        lastSeenTime: now,
        timeStr,
        desc,
        status: 'ACTIVE',
        resolvedAt: null,
        resolutionAction: null
      };

      FLEET_INCIDENTS.unshift(incident);
      if (FLEET_INCIDENTS.length > 80) FLEET_INCIDENTS.pop();

      updateProblemsBadge();

      // Mirror to Operations Terminal with high-visibility tags
      if (type === 'COLLISION') {
        logTerminal('COLLISION', 'tag-yield', `💥 <strong>COLLISION CONFLICT:</strong> ${desc}`);
      } else if (type === 'OUT_OF_CHARGE') {
        logTerminal('ALERT', 'tag-yield', `🪫 <strong>UVLO CUT-OFF:</strong> ${desc}`);
      } else if (type === 'DEADLOCK') {
        logTerminal('YIELD', 'tag-yield', `🛑 <strong>AISLE GRIDLOCK:</strong> ${desc}`);
      } else if (type === 'BMS_DEFICIT') {
        logTerminal('BMS', 'tag-yield', `⚠️ <strong>BMS DEFICIT:</strong> ${desc}`);
      }

      if (currentMainTab === 'problems') {
        updateProblemsDashboard();
      }

      return incident;
    }

    function resolveIncident(incidentId, actionName) {
      const inc = FLEET_INCIDENTS.find(i => i.id === incidentId);
      if (inc && inc.status === 'ACTIVE') {
        inc.status = 'RESOLVED';
        inc.resolvedAt = Date.now();
        inc.resolutionAction = actionName;
        updateProblemsBadge();
        if (currentMainTab === 'problems') updateProblemsDashboard();
      }
    }

    function updateProblemsBadge() {
      const badge = document.getElementById('tab-problems-badge');
      if (!badge) return;
      const activeCount = FLEET_INCIDENTS.filter(i => i.status === 'ACTIVE').length;
      badge.innerText = activeCount;
      badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
      if (activeCount > 0) {
        badge.classList.add('danger');
      } else {
        badge.classList.remove('danger');
      }
    }

    function abortMissionToCharger(robotId, reason = 'DYNAMIC_SAFETY_ABORT') {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;
      if (r.state === 'IDLE_CHARGING' || r.state === 'OUT_OF_CHARGE') return;

      // Salvage and requeue Inbound Mission
      if (r.inboundMission) {
        if (r.carriedParcels && r.carriedParcels.length > 0) {
          if (inboundQueues[r.inboundMission.dockId]) {
            inboundQueues[r.inboundMission.dockId].unshift(...r.carriedParcels);
          }
        }
        r.inboundMission.status = 'PENDING';
        r.inboundMission.assignedRobotId = null;
        r.carriedParcels = [];
        r.isLoadedYellow = false;
        r.inboundMission = null;
      }

      // Salvage and requeue Outbound Order
      if (r.outboundMission) {
        if (r.orderBox && r.orderBox.items && r.orderBox.items.length > 0) {
          for (const it of r.orderBox.items) {
            if (it.rackSlot && it.rackSlot.rack) {
              it.rackSlot.rack.floors[it.rackSlot.floorIndex] = it;
            }
          }
        }
        if (r.outboundMission.itemsToPick && r.outboundMission.itemsToPick.length > 0) {
          r.outboundMission.status = 'PENDING';
          r.outboundMission.assignedRobotId = null;
        } else {
          if (outboundOrders[r.outboundMission.bayId]) outboundOrders[r.outboundMission.bayId] = null;
          const oIdx = outboundMissions.findIndex(m => m.orderId === r.outboundMission.orderId);
          if (oIdx !== -1) outboundMissions.splice(oIdx, 1);
        }
        r.orderBox = null;
        r.outboundMission = null;
      }

      r.statusBadge = 'TO CHG';
      r.payloadWeight = 0;
      r.payloadDamping = 1.0;
      routeRobotToNearestCharger(r, reason);
      updateHudStats();
      dispatchFleet();
    }

    function rescueStrandedBot(robotId) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;

      // Find nearest available charger
      const nearest = getNearestAvailableCharger(r.gridX, r.gridY, r.id, true);
      const port = nearest.charger || CHARGING_PORTS[0];

      // Undock any current assignment
      undockFromCharger(r.id);

      // Safe teleport / tow recovery to the charging pad
      r.x = port.x;
      r.y = port.y;
      r.gridX = port.x;
      r.gridY = port.y;
      r.path = [];
      r.pathIndex = 0;
      r.heading = port.y === 1 ? Math.PI / 2 : -Math.PI / 2;
      r.isWaiting = false;
      r.waitTimer = 0;
      r.yieldTo = null;
      r.isOvertaking = false;
      r.isRerouting = false;
      r.statusBadge = null;
      r.currentSpeed = 0;
      r.strandedTimer = 0;
      r.payloadWeight = 0;
      r.payloadDamping = 1.0;

      // Salvage Inbound Mission safely
      if (r.inboundMission) {
        if (r.carriedParcels && r.carriedParcels.length > 0) {
          if (inboundQueues[r.inboundMission.dockId]) {
            inboundQueues[r.inboundMission.dockId].unshift(...r.carriedParcels);
          }
        }
        r.inboundMission.status = 'PENDING';
        r.inboundMission.assignedRobotId = null;
        r.carriedParcels = [];
        r.isLoadedYellow = false;
        r.inboundMission = null;
      }

      // Salvage Outbound Order safely
      if (r.outboundMission) {
        if (r.orderBox && r.orderBox.items && r.orderBox.items.length > 0) {
          for (const it of r.orderBox.items) {
            if (it.rackSlot && it.rackSlot.rack) {
              it.rackSlot.rack.floors[it.rackSlot.floorIndex] = it;
            }
          }
        }
        if (r.outboundMission.itemsToPick && r.outboundMission.itemsToPick.length > 0) {
          r.outboundMission.status = 'PENDING';
          r.outboundMission.assignedRobotId = null;
        } else {
          if (outboundOrders[r.outboundMission.bayId]) outboundOrders[r.outboundMission.bayId] = null;
          const oIdx = outboundMissions.findIndex(m => m.orderId === r.outboundMission.orderId);
          if (oIdx !== -1) outboundMissions.splice(oIdx, 1);
        }
        r.orderBox = null;
        r.outboundMission = null;
      }

      // Fast charge boost: at least 60% SoC
      r.battery = Math.max(60.0, r.battery);
      dockAtCharger(port.id, r.id);
      if (r.logStats) r.logStats.totalTowedByRescue = (r.logStats.totalTowedByRescue || 0) + 1;
      r.state = 'IDLE_CHARGING';
      r.targetDesc = `Parked at Fast Charger ${port.id} (${r.battery.toFixed(1)}%) - Rescued by Tow`;

      // Resolve all active problems for this bot
      for (const inc of FLEET_INCIDENTS) {
        if (inc.robotId === r.id && inc.status === 'ACTIVE') {
          resolveIncident(inc.id, `Towed to Charger ${port.id} (+60% SoC Boost)`);
        }
      }

      logTerminal('SYSTEM', 'tag-complete', `⚡ <strong>TOW RESCUE COMPLETED:</strong> <strong>${r.id}</strong> safely towed to Fast Charger <strong>${port.id}</strong>. Battery replenished to <strong>${r.battery.toFixed(1)}% SoC</strong>.`);
      updateHudStats();
      if (currentMainTab === 'problems') updateProblemsDashboard();
      dispatchFleet();
    }

    function clearRobotDeadlock(robotId) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;
      r.isWaiting = false;
      r.waitTimer = 0;
      r.yieldTo = null;
      r.statusBadge = null;

      // Anti-gridlock side step into adjacent walkable cell
      const neighbors = [
        { x: r.gridX + 1, y: r.gridY },
        { x: r.gridX - 1, y: r.gridY },
        { x: r.gridX, y: r.gridY + 1 },
        { x: r.gridX, y: r.gridY - 1 }
      ];
      let stepCell = null;
      for (const cell of neighbors) {
        if (isWalkable(cell.x, cell.y)) {
          let occ = false;
          for (const other of AMR_FLEET) {
            if (other.id !== r.id && Math.hypot(other.x - cell.x, other.y - cell.y) < 1.0) {
              occ = true; break;
            }
          }
          if (!occ) { stepCell = cell; break; }
        }
      }

      if (stepCell) {
        const dest = (r.path && r.path.length > 0) ? r.path[r.path.length - 1] : null;
        if (dest && typeof dest.x === 'number') {
          const repath = findPath(stepCell.x, stepCell.y, dest.x, dest.y);
          setRobotPath(r, [stepCell, ...(repath || [])]);
        } else {
          setRobotPath(r, [stepCell]);
        }
      }

      for (const inc of FLEET_INCIDENTS) {
        if (inc.robotId === r.id && inc.type === 'DEADLOCK' && inc.status === 'ACTIVE') {
          resolveIncident(inc.id, 'Operator Nudge / Unblocked');
        }
      }

      logTerminal('REROUTE', 'tag-reroute', `🔄 <strong>MANUAL UNBLOCK:</strong> <strong>${r.id}</strong> cleared from gridlock.`);
      if (currentMainTab === 'problems') updateProblemsDashboard();
    }

    function towAllStrandedBots() {
      let count = 0;
      for (const r of AMR_FLEET) {
        if (r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0) {
          rescueStrandedBot(r.id);
          count++;
        }
      }
      if (count === 0) {
        logTerminal('SYSTEM', 'tag-inbound', 'ℹ️ No stranded bots detected. All fleet AMRs operating above 10% cutoff.');
      }
    }

    function breakAllDeadlocks() {
      let count = 0;
      for (const r of AMR_FLEET) {
        if (r.isWaiting || r.waitTimer > 1.5) {
          clearRobotDeadlock(r.id);
          count++;
        }
      }
      logTerminal('SYSTEM', 'tag-reroute', `🔄 <strong>ANTI-GRIDLOCK SWEEP:</strong> Unblocked ${count} AMRs.`);
    }

    function clearResolvedIncidents() {
      const activeOnly = FLEET_INCIDENTS.filter(i => i.status === 'ACTIVE');
      FLEET_INCIDENTS.length = 0;
      FLEET_INCIDENTS.push(...activeOnly);
      updateProblemsDashboard();
    }

    function setProblemFilter(filterName, btn) {
      currentProblemFilter = filterName;
      const pills = document.querySelectorAll('.prob-filter-pill');
      pills.forEach(p => p.classList.toggle('active', p.getAttribute('data-filter') === filterName));
      renderProblemsFeed();
    }

    function updateProblemsDashboard() {
      // 1. Calculate problem totals
      let collisionCount = 0;
      let outOfChargeCount = 0;
      let deadlockCount = 0;
      let bmsDeficitCount = 0;

      for (const inc of FLEET_INCIDENTS) {
        if (inc.type === 'COLLISION') collisionCount++;
        else if (inc.type === 'OUT_OF_CHARGE' && inc.status === 'ACTIVE') outOfChargeCount++;
        else if (inc.type === 'DEADLOCK' && inc.status === 'ACTIVE') deadlockCount++;
        else if (inc.type === 'BMS_DEFICIT') bmsDeficitCount++;
      }

      for (const r of AMR_FLEET) {
        if (r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0) {
          outOfChargeCount = Math.max(outOfChargeCount, 1);
        }
        if (r.isWaiting && r.waitTimer > 2.5) {
          deadlockCount = Math.max(deadlockCount, 1);
        }
      }

      const elColl = document.getElementById('prob-kpi-collisions');
      const elOut = document.getElementById('prob-kpi-out-of-charge');
      const elDead = document.getElementById('prob-kpi-deadlocks');
      const elBms = document.getElementById('prob-kpi-bms-deficits');

      if (elColl) elColl.innerText = collisionCount;
      if (elOut) elOut.innerText = outOfChargeCount;
      if (elDead) elDead.innerText = deadlockCount;
      if (elBms) elBms.innerText = bmsDeficitCount;

      const incCountEl = document.getElementById('prob-incident-count');
      if (incCountEl) {
        const active = FLEET_INCIDENTS.filter(i => i.status === 'ACTIVE').length;
        incCountEl.innerText = `${active} Active (${FLEET_INCIDENTS.length} Total)`;
      }

      renderProblemsFeed();
      renderProblemsMatrix();
      updateProblemsBadge();
    }

    function renderProblemsFeed() {
      const container = document.getElementById('prob-feed-list');
      if (!container) return;

      const filtered = FLEET_INCIDENTS.filter(inc => {
        if (currentProblemFilter === 'ALL') return true;
        return inc.type === currentProblemFilter;
      });

      if (filtered.length === 0) {
        container.innerHTML = `
          <div style="text-align:center; padding:45px 20px; color:#64748b;">
            <div style="font-size:36px; margin-bottom:10px;">✅</div>
            <div style="font-size:14px; font-weight:700; color:#cbd5e1;">Zero Active ${currentProblemFilter === 'ALL' ? '' : currentProblemFilter} Incidents</div>
            <div style="font-size:11px; margin-top:5px; color:#94a3b8;">Fleet motion, decentralized collision mesh, and BMS energy budgeting nominal.</div>
          </div>
        `;
        return;
      }

      const now = Date.now();
      container.innerHTML = filtered.map(inc => {
        const isActive = inc.status === 'ACTIVE';
        const elapsedSec = Math.round((now - inc.startTime) / 1000);

        let icon = '⚠️';
        let typeLabel = inc.type;
        if (inc.type === 'COLLISION') { icon = '💥'; typeLabel = 'COLLISION / CONFLICT'; }
        else if (inc.type === 'OUT_OF_CHARGE') { icon = '🪫'; typeLabel = 'BATTERY AT 10% FLOOR'; }
        else if (inc.type === 'DEADLOCK') { icon = '🛑'; typeLabel = 'AISLE DEADLOCK / STALL'; }
        else if (inc.type === 'BMS_DEFICIT') { icon = '⚠️'; typeLabel = 'BMS ENERGY DEFICIT'; }

        return `
          <div class="prob-card ${isActive ? `active-${inc.type}` : 'resolved'}">
            <div class="prob-card-header">
              <div class="prob-card-title">
                <span>${icon}</span>
                <span>${typeLabel}</span>
                <strong style="color:#38bdf8; margin-left:4px;">${inc.robotId}</strong>
                ${inc.peerId ? `<span style="color:#94a3b8; font-size:10px;">vs <strong>${inc.peerId}</strong></span>` : ''}
              </div>
              <div class="prob-card-meta">
                <span class="prob-time">[${inc.timeStr}]</span>
                <span class="prob-status-tag ${isActive ? 'active' : 'resolved'}">
                  ${isActive ? `ACTIVE (${elapsedSec}s)` : 'RESOLVED'}
                </span>
              </div>
            </div>

            <div class="prob-card-desc">
              ${inc.desc}
              ${!isActive && inc.resolutionAction ? `<div style="margin-top:3px; color:#4ade80; font-size:10px;">✔ Resolved via: <strong>${inc.resolutionAction}</strong></div>` : ''}
            </div>

            <div class="prob-card-actions">
              ${isActive && (inc.type === 'OUT_OF_CHARGE' || inc.type === 'BMS_DEFICIT') ? `
                <button class="prob-btn tow" onclick="rescueStrandedBot('${inc.robotId}')" title="Emergency tow to nearest fast charger & +50% SoC boost">
                  <span>⚡ Tow to Charger (+50%)</span>
                </button>
              ` : ''}
              ${isActive && inc.type === 'DEADLOCK' ? `
                <button class="prob-btn unblock" onclick="clearRobotDeadlock('${inc.robotId}')" title="Force side-step and clear waiting stall">
                  <span>🔄 Force Nudge / Unblock</span>
                </button>
              ` : ''}
              ${isActive && inc.type === 'COLLISION' ? `
                <button class="prob-btn unblock" onclick="clearRobotDeadlock('${inc.robotId}')">
                  <span>🔄 Unblock ${inc.robotId}</span>
                </button>
                ${inc.peerId ? `
                  <button class="prob-btn unblock" onclick="clearRobotDeadlock('${inc.peerId}')">
                    <span>🔄 Unblock ${inc.peerId}</span>
                  </button>
                ` : ''}
              ` : ''}
              <button class="prob-btn locate" onclick="locateBotOnMap('${inc.robotId}')" title="Center 2D map on ${inc.robotId} with radar ping">
                <span>📍 Locate on Map</span>
              </button>
              <button class="prob-btn track" onclick="trackBot('${inc.robotId}', true)" title="Engage targeting lock and follow camera on ${inc.robotId}">
                <span>🎯 Track</span>
              </button>
              ${isActive ? `
                <button class="prob-btn" style="margin-left:auto; font-size:9px;" onclick="resolveIncident('${inc.id}', 'Manual Dismiss')">
                  Dismiss
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function renderProblemsMatrix() {
      const container = document.getElementById('prob-matrix-grid');
      if (!container || !AMR_FLEET) return;

      container.innerHTML = AMR_FLEET.map(r => {
        const isDead = r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0;
        const isStalled = r.isWaiting && r.waitTimer > 2.0;
        const isCharging = r.state === 'IDLE_CHARGING';

        let rowClass = '';
        if (isDead) rowClass = 'is-dead';
        else if (isStalled) rowClass = 'is-stalled';

        let barColor = '#22c55e';
        if (isDead) barColor = '#ef4444';
        else if (r.battery <= 25.0) barColor = '#f87171';
        else if (r.battery <= 50.0) barColor = '#f59e0b';

        let stateLabel = r.state;
        let stateTagBg = '#1e293b';
        let stateTagColor = '#94a3b8';

        if (isDead) {
          stateLabel = '🪫 IMMOBILIZED (10%)';
          stateTagBg = '#7f1d1d';
          stateTagColor = '#fecaca';
        } else if (isCharging) {
          stateLabel = `⚡ FAST CHARGE (${r.battery.toFixed(1)}%)`;
          stateTagBg = 'rgba(34, 197, 94, 0.2)';
          stateTagColor = '#4ade80';
        } else if (isStalled) {
          stateLabel = `🛑 STALLED (${r.waitTimer.toFixed(1)}s)`;
          stateTagBg = 'rgba(245, 158, 11, 0.2)';
          stateTagColor = '#fde047';
        } else if (r.isWaiting) {
          stateLabel = `⏳ Yielding to ${r.yieldTo || 'AMR'}`;
          stateTagBg = 'rgba(245, 158, 11, 0.15)';
          stateTagColor = '#f59e0b';
        } else if (r.isOvertaking) {
          stateLabel = '🏎️ Overtaking (1.35x)';
          stateTagBg = 'rgba(56, 189, 248, 0.2)';
          stateTagColor = '#38bdf8';
        } else if (r.state === 'CARRYING_TO_RACK') {
          stateLabel = `📥 Shelving (${r.carriedParcels ? r.carriedParcels.length : 0} pkgs)`;
          stateTagBg = 'rgba(250, 204, 21, 0.2)';
          stateTagColor = '#facc15';
        } else if (r.state === 'DELIVERING_ORDER_TO_BAY' || r.state === 'ORDER_PICKING') {
          stateLabel = `📦 Order Pick / Deliver`;
          stateTagBg = 'rgba(234, 88, 12, 0.2)';
          stateTagColor = '#fb923c';
        }

        const nearestChg = getNearestAvailableCharger(r.gridX, r.gridY, r.id);
        const estSoc = nearestChg.energyNeeded + SAFETY_RESERVE_SOC;

        return `
          <div class="matrix-row ${rowClass}">
            <div class="matrix-top">
              <div class="matrix-bot-title">
                <span>🤖</span>
                <span>${r.id}</span>
                <span style="font-size:10px; font-weight:normal; color:#94a3b8;">at (${r.gridX}, ${r.gridY})</span>
              </div>
              <span class="matrix-state-tag" style="background:${stateTagBg}; color:${stateTagColor};">${stateLabel}</span>
            </div>

            <div class="matrix-bar-wrap">
              <div class="matrix-bar-bg" title="BMS SoC gauge with red 10% UVLO cutoff line">
                <div class="matrix-bar-cutoff-line" title="10% BMS Cutoff Floor"></div>
                <div class="matrix-bar-fill" style="width:${r.battery.toFixed(1)}%; background:${barColor};"></div>
              </div>
              <span class="matrix-soc-text" style="color:${barColor};">${r.battery.toFixed(1)}%</span>
            </div>

            <div class="matrix-details">
              <span>Nearest Bay: <strong>${nearestChg.charger ? nearestChg.charger.id : 'CH-01'}</strong> (${nearestChg.distance}m | Req: ~${estSoc.toFixed(1)}%)</span>
              <span>Draw: <strong>${isCharging ? `+${(r.chargeRateKw || 30).toFixed(1)}kW` : `-${Math.round(r.powerWatts || 165)}W`}</strong></span>
            </div>

            <div class="matrix-actions">
              ${isDead ? `
                <button class="prob-btn tow" style="flex:1;" onclick="rescueStrandedBot('${r.id}')">
                  <span>⚡ Tow &amp; Revive (+60%)</span>
                </button>
              ` : `
                <button class="prob-btn tow" style="flex:1;" onclick="sendBotToCharger('${r.id}')">
                  <span>⚡ Dock Nearest</span>
                </button>
              `}
              ${r.isWaiting ? `
                <button class="prob-btn unblock" onclick="clearRobotDeadlock('${r.id}')">
                  <span>🔄 Nudge</span>
                </button>
              ` : ''}
              <button class="prob-btn locate" onclick="locateBotOnMap('${r.id}')" title="Locate on Map">
                <span>📍 Map</span>
              </button>
              <button class="prob-btn track" onclick="trackBot('${r.id}', true)" title="Engage targeting lock and follow camera on ${r.id}">
                <span>🎯 Track</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

