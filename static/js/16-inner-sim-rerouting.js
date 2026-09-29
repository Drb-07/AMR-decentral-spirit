// =========================================================================
    // INNER SHADOW SIMULATION (Fast-Forward Micro-Traffic Predictor)
    // "simulation run inside simulation that checks for traffic problems"
    // =========================================================================
    function runInnerTrafficSimulation(robot, candidatePath = null, lookaheadSeconds = 8.0) {
      if (typeof Traffic !== 'undefined' && Traffic.TRAFFIC_MODE !== 'legacy') return { hasTrafficProblem: false };
      
      if (!robot) return { hasTrafficProblem: false };
      const path = candidatePath || (robot.path && robot.path.length > robot.pathIndex ? robot.path.slice(robot.pathIndex) : []);
      if (!path || path.length === 0) return { hasTrafficProblem: false };

      const bspd = ROBOT_BASE_SPEED;
      const vR = Math.max(0.5, bspd * (robot.speedMultiplier || 1.0) * (robot.payloadDamping || 1.0));
      const dtStep = 0.4;
      const numSteps = Math.min(25, Math.ceil(lookaheadSeconds / dtStep));

      // PHASE 3: DECENTRALIZED SHADOW SIMULATION
      const peerData = robot.localPeerTable ? Array.from(robot.localPeerTable.values()) : [];
      
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

      for (let s = 1; s <= numSteps; s++) {
        const t = s * dtStep;
        const distR = vR * t;
        const stepR = Math.min(Math.floor(distR), path.length - 1);
        const posR = path[stepR];
        
        // Track the bounding box of our forward projection
        minX = Math.min(minX, posR.x); maxX = Math.max(maxX, posR.x);
        minY = Math.min(minY, posR.y); maxY = Math.max(maxY, posR.y);

        for (const peer of peerData) {
          const isOStationary = (peer.status_flags === 0) || ((peer.status_flags & 2) !== 0) || ((peer.status_flags & 4) !== 0);
          let posO = { x: peer.pose.x, y: peer.pose.y };

          if (!isOStationary && peer.intent_tube && peer.intent_tube.length > 0) {
             const vO = bspd; 
             const distO = vO * t;
             const stepO = Math.min(Math.floor(distO), peer.intent_tube.length - 1);
             posO = { x: peer.intent_tube[stepO][0], y: peer.intent_tube[stepO][1] };
          }

          const age = (typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0) - (peer.timestamp || 0);
          const pktLoss = peer.packetLoss || 0.0;
          const netConfidence = Math.max(0.0, 1.0 - (age / 3.0) - (pktLoss * 0.8));
          const poseConfidence = peer.pose_confidence !== undefined ? peer.pose_confidence : 1.0;
          const confidence = Math.min(netConfidence, poseConfidence);
          
          // Reduced below 1.0 to confidently allow side-by-side passing in adjacent lanes!
          const collisionThreshold = confidence >= 0.8 ? 0.85 : (confidence >= 0.5 ? 1.20 : 1.60);

          const dSim = Math.hypot(posR.x - posO.x, posR.y - posO.y);
          if (dSim < collisionThreshold) {
            let reason = 'SLOW_TRAFFIC_CONGESTION';
            if (isOStationary) reason = 'BLOCKED_BY_STATIONARY_BOT';
            else if (Math.abs(robot.heading - peer.pose.theta) > 2.0) reason = 'HEAD_ON_DEADLOCK';

            // Detect Very Bad Cascading Jam (Stopping here blocks another peer who is ALSO blocked)
            if (isOStationary && (peer.status_flags & 4)) {
                reason = 'CASCADING_VERY_BAD_JAM';
            }

            return {
              hasTrafficProblem: true,
              blocker: null,
              blockerId: peer.robot_id,
              conflictCell: { x: Math.round(posO.x), y: Math.round(posO.y) },
              timeToConflict: t,
              isStationary: isOStationary,
              reason: reason
            };
          }
        }
      }
      
      // Check 9x9 Area Stagnation (Bot is tangled/circling without progressing outwards)
      const expectedDist = vR * lookaheadSeconds;
      const areaWidth = maxX - minX;
      const areaHeight = maxY - minY;
      if (expectedDist > 15 && areaWidth <= 9 && areaHeight <= 9) {
          return {
              hasTrafficProblem: true,
              blockerId: 'GRID_TANGLE',
              conflictCell: { x: Math.round(path[0].x), y: Math.round(path[0].y) },
              timeToConflict: lookaheadSeconds,
              isStationary: false,
              reason: '9X9_AREA_STAGNATION_LOOP'
          };
      }

      return { hasTrafficProblem: false };
    }

    function solveTrafficPathViaInnerSim(robot, dest, blockerHint = null, conflictCellHint = null) {
      if (typeof Traffic !== 'undefined' && Traffic.TRAFFIC_MODE !== 'legacy') return false;

      if (!robot) return false;
      if (typeof BASELINE_STOP_AND_WAIT_MODE !== 'undefined' && BASELINE_STOP_AND_WAIT_MODE) return false;

      const targetDest = dest || (robot.path && robot.path.length > 0 ? robot.path[robot.path.length - 1] : robot.currentDestination);
      if (!targetDest) return false;

      if (Math.hypot(robot.gridX - targetDest.x, robot.gridY - targetDest.y) <= 1) return false;

      const bx = conflictCellHint ? conflictCellHint.x : (blockerHint ? blockerHint.gridX : robot.gridX);
      const by = conflictCellHint ? conflictCellHint.y : (blockerHint ? blockerHint.gridY : robot.gridY);
      const blockerId = blockerHint ? blockerHint.id : (robot.yieldTo || 'TRAFFIC');

      let thoughtLog = [];
      thoughtLog.push(`Detected conflict with ${blockerId}. Evaluating alternatives.`);

      // STAGE 1: Direct Avoidance
      const avoid1 = new Set();
      avoid1.add(`${bx},${by}`);
      if (blockerHint) {
        avoid1.add(`${blockerHint.gridX},${blockerHint.gridY}`);
        if (blockerHint.path && blockerHint.pathIndex < blockerHint.path.length) {
          const nb = blockerHint.path[blockerHint.pathIndex];
          avoid1.add(`${nb.x},${nb.y}`);
        }
      }

      const isHorizontalHighway = (by === 23 || by === 24 || by === 25 || by === 26 || by <= 4 || by >= 45);
      if (isHorizontalHighway) {
        const minX = Math.min(robot.gridX, targetDest.x);
        const maxX = Math.max(robot.gridX, targetDest.x);
        for (let vx = minX; vx <= maxX; vx++) {
          if (Math.abs(vx - targetDest.x) > 1) {
            avoid1.add(`${vx},${by}`);
          }
        }
      }
      
      const peerData = robot.localPeerTable ? Array.from(robot.localPeerTable.values()) : [];
      for (const peer of peerData) {
        if (peer.status_flags === 0 || (peer.status_flags & 4)) {
          avoid1.add(`${Math.round(peer.pose.x)},${Math.round(peer.pose.y)}`);
        }
      }

      const cand1 = findPath(robot.gridX, robot.gridY, targetDest.x, targetDest.y, avoid1);
      if (cand1 && cand1.length > 0) {
        const sim1 = runInnerTrafficSimulation(robot, cand1);
        if (!sim1.hasTrafficProblem) {
          thoughtLog.push(`Stage 1 (Local Bypass): SUCCESS.`);
          robot.thoughtProcess = thoughtLog;
          applyInnerSimPath(robot, cand1, blockerId, 'STAGE_1_AROUND');
          return true;
        } else {
          thoughtLog.push(`Stage 1 (Local Bypass): FAILED (${sim1.reason}).`);
        }
      } else {
        thoughtLog.push(`Stage 1 (Local Bypass): FAILED (No spatial route).`);
      }

      // STAGE 2: 2-Cell Radius Detour
      const avoid2 = new Set(avoid1);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          avoid2.add(`${bx + dx},${by + dy}`);
        }
      }
      for (const peer of peerData) {
        if (Math.hypot(peer.pose.x - robot.x, peer.pose.y - robot.y) < 3.5) {
          avoid2.add(`${Math.round(peer.pose.x)},${Math.round(peer.pose.y)}`);
          if (peer.intent_tube && peer.intent_tube.length > 0) {
            avoid2.add(`${Math.round(peer.intent_tube[0][0])},${Math.round(peer.intent_tube[0][1])}`);
          }
        }
      }

      const cand2 = findPath(robot.gridX, robot.gridY, targetDest.x, targetDest.y, avoid2);
      if (cand2 && cand2.length > 0) {
        const sim2 = runInnerTrafficSimulation(robot, cand2);
        if (!sim2.hasTrafficProblem) {
          thoughtLog.push(`Stage 2 (Wide Detour): SUCCESS.`);
          robot.thoughtProcess = thoughtLog;
          applyInnerSimPath(robot, cand2, blockerId, 'STAGE_2_AROUND_AROUND');
          return true;
        } else {
          thoughtLog.push(`Stage 2 (Wide Detour): FAILED (${sim2.reason}).`);
        }
      } else {
        thoughtLog.push(`Stage 2 (Wide Detour): FAILED (Blocked).`);
      }

      // STAGE 3: Aisle Column Bypass
      const avoid3 = new Set(avoid2);
      if (typeof NARROW_AISLE_COLS !== 'undefined' && NARROW_AISLE_COLS.has(bx)) {
        for (let dy = -6; dy <= 6; dy++) {
          avoid3.add(`${bx},${by + dy}`);
        }
      }
      const cand3 = findPath(robot.gridX, robot.gridY, targetDest.x, targetDest.y, avoid3);
      if (cand3 && cand3.length > 0) {
        const sim3 = runInnerTrafficSimulation(robot, cand3);
        if (!sim3.hasTrafficProblem) {
          thoughtLog.push(`Stage 3 (Aisle Bypass): SUCCESS.`);
          robot.thoughtProcess = thoughtLog;
          applyInnerSimPath(robot, cand3, blockerId, 'STAGE_3_AISLE_BYPASS');
          return true;
        } else {
          thoughtLog.push(`Stage 3 (Aisle Bypass): FAILED (${sim3.reason}).`);
        }
      } else {
        thoughtLog.push(`Stage 3 (Aisle Bypass): FAILED.`);
      }

      // -----------------------------------------------------------------------
      // STAGE 4: ROLLBACK MANEUVER
      // If all spatial detours fail, roll back to the position before the deadlock
      // -----------------------------------------------------------------------
      thoughtLog.push(`All inner sims failed. Initiating ROLLBACK to clear jam.`);
      robot.thoughtProcess = thoughtLog;

      let rollbackPath = [];
      let trail = robot.recentVisitedCells || [];
      
      // Extract up to 4 cells backward to get out of the jam zone
      for (let k = trail.length - 1; k >= Math.max(0, trail.length - 4); k--) {
          let occ = false;
          if (robot.localPeerTable) {
              for (const p of robot.localPeerTable.values()) {
                  if (Math.round(p.pose.x) === trail[k].x && Math.round(p.pose.y) === trail[k].y) {
                      occ = true; break;
                  }
              }
          }
          if (!occ) rollbackPath.push({ x: trail[k].x, y: trail[k].y });
      }

      // If trail is empty/blocked, calculate a simple reverse step away from blocker
      if (rollbackPath.length === 0) {
          let dx = Math.sign(robot.gridX - bx);
          let dy = Math.sign(robot.gridY - by);
          if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
          let cand1 = { x: robot.gridX + dx, y: robot.gridY };
          let cand2 = { x: robot.gridX, y: robot.gridY + dy };
          
          for (let cand of [cand1, cand2]) {
              if (isWalkable(cand.x, cand.y)) {
                  let occ = false;
                  if (robot.localPeerTable) {
                      for (const p of robot.localPeerTable.values()) {
                          if (Math.round(p.pose.x) === cand.x && Math.round(p.pose.y) === cand.y) { occ = true; break; }
                      }
                  }
                  if (!occ) { rollbackPath.push(cand); break; }
              }
          }
      }

      if (rollbackPath.length > 0) {
          // Save ultimate destination so it recalculates a fresh path after rolling back
          if (!robot.savedDest && robot.path && robot.path.length > 0) {
              robot.savedDest = robot.path[robot.path.length - 1];
          }
          robot.isBackingUp = true;
          robot.isSideStepping = false;
          robot.escapePartnerId = blockerId;
          setRobotPath(robot, rollbackPath);
          
          robot.isWaiting = false;
          robot._wasWaitingThisFrame = false;
          robot.waitTimer = 0;
          robot.statusBadge = `ROLLBACK`;
          
          // Broadcast jam for 4 seconds so others avoid this space while we untangle
          robot.jamBroadcastTimer = 4.0;
          
          if (robot.logStats) robot.logStats.totalBackupsToPreviousBox++;
          if (typeof onRobotJamEnd === 'function') onRobotJamEnd(robot, 'DEADLOCK_ROLLBACK');
          if (typeof trafficMetrics !== 'undefined') trafficMetrics.totalReroutes = (trafficMetrics.totalReroutes || 0) + 1;
          
          return true;
      }

      thoughtLog.push(`Rollback failed (blocked behind). Halting.`);
      robot.thoughtProcess = thoughtLog;
      return false;
    }

    function applyInnerSimPath(robot, newPath, blockerId, stageTag) {
      setRobotPath(robot, newPath);
      robot.isWaiting = false;
      robot._wasWaitingThisFrame = false;
      robot.waitTimer = 0;
      robot.yieldTo = null;
      robot.isRerouting = true;
      robot.rerouteTimer = 3.0;
      robot.statusBadge = 'PASSING';
      robot._lastInnerSimRepathTime = totalSimSeconds;
      if (robot.logStats) robot.logStats.totalReroutes++;
      onRobotJamEnd(robot, `INNER_SIM_${stageTag}`);
      if (typeof trafficMetrics !== 'undefined') trafficMetrics.totalReroutes = (trafficMetrics.totalReroutes || 0) + 1;
      
      // P2P Communication: Experienced drivers talking
      const blockerBot = AMR_FLEET.find(b => b.id === blockerId);
      if (blockerBot && !blockerBot.isOvertaking && !blockerBot.isRerouting) {
         blockerBot._pinnedForOvertake = true;
         blockerBot._pinnedTimer = 3.0;
         blockerBot.statusBadge = 'YIELDING';
         blockerBot.isWaiting = true;
         blockerBot._wasWaitingThisFrame = true;
         blockerBot.targetDesc = `Mesh Ack: Yielding lane to ${robot.id}`;
      }

      if (typeof logTerminal === 'function') logTerminal('SHADOW_SIM', 'tag-reroute', `📡 <strong>${robot.id}</strong> to <strong>${blockerId}</strong>: "I'm taking the passing lane!" Maintained lane discipline.`);
      if (typeof updateHudStats === 'function') updateHudStats();
    }

    // Dynamic Rerouting Engine (Detour Around Obstacles / Blockages)
    // Delegated directly to Inner Shadow Simulation multi-stage solver
    function attemptReroute(robot, blocker, wideMode = false) {
      if (!robot.path || robot.path.length === 0) return false;
      const dest = robot.path[robot.path.length - 1];
      if (Math.hypot(robot.gridX - dest.x, robot.gridY - dest.y) <= 1) return false;

      // P2P "Experienced Driver" Protocol: Battery-Priority Traffic De-congestion
      // Check 5-block radius. If ANY active peer has a lower battery, DO NOT reroute.
      // Wait patiently until the lower-battery peer has left the area.
      for (const peer of AMR_FLEET) {
        if (peer.id !== robot.id && peer.state !== 'IDLE_CHARGING' && peer.state !== 'OUT_OF_CHARGE' && peer.state !== 'IDLE') {
          const dist = Math.hypot(robot.gridX - peer.gridX, robot.gridY - peer.gridY);
          if (dist <= 5.0) {
            // Is peer lower battery?
            if (peer.battery < robot.battery - 0.1) {
              robot.isWaiting = true;
              robot._wasWaitingThisFrame = true;
              robot.statusBadge = 'YIELD BATT';
              robot.waitTimer = 0; // Freeze the wait timer so it doesn't escalate to deadlock
              robot.targetDesc = `Mesh Comm: Yielding area to ${peer.id} (${peer.battery.toFixed(1)}%)`;
              return false; // Abort reroute
            }
          }
        }
      }

      // If we are the lowest battery in the 5-block radius, we have clearance to calculate a new route!
      const success = solveTrafficPathViaInnerSim(robot, dest, blocker, blocker ? { x: blocker.gridX, y: blocker.gridY } : null);
      if (success) {
         if (typeof logTerminal === 'function') logTerminal('REROUTE', 'tag-reroute', `🧠 <strong>${robot.id}</strong> (Lowest battery in 5-block radius) claimed priority and rerouted.`);
      }
      return success;
    }

    // Dynamic SLA-Driven Priority Queue & Aging
    // VIP Express (85 base) preempts Standard (40 base), with aging to prevent starvation
    function computeTaskPriorityScore(task) {
      if (!task) return 0;
      const tier = task.importance || IMPORTANCE_TIERS.STANDARD;
      const baseUrgency = tier.baseUrgency || 40;
      const slaSec = tier.slaSeconds || 120;
      const createdAt = task.createdAt || Date.now();
      const elapsedSec = Math.max(0, (Date.now() - createdAt) / 1000 * (typeof simSpeed !== 'undefined' ? simSpeed : 1));

      // SLA Ratio: how close or past the deadline
      const slaRatio = elapsedSec / slaSec;

      // Age bonus: +0.75 points per sim-second in queue (starvation prevention)
      const agingTerm = elapsedSec * 0.75;

      // Escalation term: rapid surge as deadline approaches or breaches
      const escalationTerm = slaRatio >= 1.0 
        ? (60 + (slaRatio - 1.0) * 45) 
        : (slaRatio * 45);

      return baseUrgency + escalationTerm + agingTerm;
    }