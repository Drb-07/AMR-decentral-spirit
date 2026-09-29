// =========================================================================
    // PHASE 4: DETERMINISTIC DECENTRALIZED PRIORITY & YIELD ARBITRATION
    // Priority Score: P = wb*BatteryUrgency + wu*TaskUrgency + wd*DeadlineProximity + wt*WaitTime + wr*RecoveryCost
    // =========================================================================
    function getRobotPriority(r) {
      if (!r) return -999999;
      if (r.state === 'OUT_OF_CHARGE' || r.state === 'IDLE_CHARGING') return -999999;

      const wb = 100.0, wu = 50.0, wd = 30.0, wt = 10.0, wr = 20.0;

      // 1. BatteryUrgency: Higher as battery approaches floor
      const batteryUrgency = Math.max(0, 100.0 - r.battery);

      // 2. TaskUrgency: Base SLA requirement
      const taskUrgency = typeof calculateRobotUrgency === 'function' ? calculateRobotUrgency(r) : 20;

      // 3. DeadlineProximity: Time elapsed vs SLA window
      let deadlineProximity = 0;
      if (r.missionStartTime) {
         const nowMs = typeof totalSimSeconds !== 'undefined' ? totalSimSeconds * 1000 : Date.now();
         const elapsedSec = (nowMs - r.missionStartTime) / 1000 * (typeof simSpeed !== 'undefined' ? simSpeed : 1);
         const slaWindow = (r.orderBox && r.orderBox.importance) ? r.orderBox.importance.slaSeconds : 120;
         deadlineProximity = Math.min(2.0, elapsedSec / slaWindow) * 100.0; // scales up rapidly as deadline approaches
      }

      // 4. WaitTime: Increases the longer the robot has been yielding
      const waitTime = r.waitTimer || 0;

      // 5. RecoveryCost: Penalize yielding if robot is deep in a narrow aisle or heavily loaded
      let recoveryCost = 0;
      if (typeof getNarrowAisleSegment === 'function' && getNarrowAisleSegment(r.gridX, r.gridY)) {
         recoveryCost += 50.0; 
      }
      recoveryCost += (r.payloadWeight || 0) * 2.0;

      return (wb * batteryUrgency) + (wu * taskUrgency) + (wd * deadlineProximity) + (wt * waitTime) + (wr * recoveryCost);
    }

    // Decentralized Right-of-Way Arbiter: First to choose path gets Right of Way!
    function isHigherPriority(myRobot, peerOrPayload) {
      if (!myRobot) return false;
      if (!peerOrPayload) return true;

      // "The first to choose path will go with its path. The second will respect..."
      const myPathTime = myRobot.pathTimestamp || 0;
      const peerPathTime = peerOrPayload.path_timestamp !== undefined ? peerOrPayload.path_timestamp : (peerOrPayload.pathTimestamp || 0);

      // If paths were generated at different times, the older path (smaller timestamp) wins!
      if (Math.abs(myPathTime - peerPathTime) > 0.05) {
        return myPathTime < peerPathTime;
      }

      // Fallback to SLA Priority if timestamps are identical
      const myScore = getRobotPriority(myRobot);
      const peerScore = peerOrPayload.priority !== undefined ? peerOrPayload.priority : getRobotPriority(peerOrPayload);
      const peerId = peerOrPayload.robot_id || peerOrPayload.id;

      if (Math.abs(myScore - peerScore) > 0.1) {
        return myScore > peerScore;
      }
      return myRobot.id < peerId;
    }

    // =========================================================================
    // PHASE 4: LOCAL NAV2-STYLE YIELD BEHAVIORS (Decentralized Execution)
    // Replaces global arbiter. Robot locally decides to halt, side-step (90° turn),
    // or reverse based purely on intent_tube overlap and priority calculation.
    // =========================================================================
    function executeLocalYieldBehavior(robot, peerId, forceYield = false) {
      if (typeof Traffic !== 'undefined' && Traffic.TRAFFIC_MODE !== 'legacy') return false;
      
      if (robot.isSideStepping || robot.isBackingUp) return false;

      // Extract the peer's intent and priority purely from the simulated network
      const peerPayload = robot.localPeerTable ? robot.localPeerTable.get(peerId) : null;
      if (!peerPayload) return false;

      let thoughtLog = robot.thoughtProcess || [];

      // Local Priority Verification (bypassed if Deadlock Resolver intervenes)
      if (!forceYield && isHigherPriority(robot, peerPayload)) {
        thoughtLog.push(`Mesh: I have Right-of-Way over ${peerId}. Holding ground.`);
        robot.thoughtProcess = thoughtLog;
        return false; // I have right of way. I do not yield.
      }

      thoughtLog.push(`Mesh: ${peerId} has Right-of-Way. Yielding.`);

      // PHASE 11: Literal Stop-and-Wait Baseline Controller (FCFS)
      if (typeof BASELINE_STOP_AND_WAIT_MODE !== 'undefined' && BASELINE_STOP_AND_WAIT_MODE) {
        robot.isWaiting = true;
        robot._wasWaitingThisFrame = true;
        robot.statusBadge = 'HALT (FCFS)';
        thoughtLog.push(`Action: FCFS Halt.`);
        robot.thoughtProcess = thoughtLog;
        if (typeof onRobotJamEnd === 'function') onRobotJamEnd(robot, 'FCFS_STOP_AND_WAIT');
        return true; // Handle by doing nothing but stopping
      }

      // --- I must yield. Determine best local maneuver ---

      // Strategy A: 90-degree Side Step to clear corridor
      const neighbors = [
        { x: robot.gridX, y: robot.gridY - 1 },
        { x: robot.gridX, y: robot.gridY + 1 },
        { x: robot.gridX - 1, y: robot.gridY },
        { x: robot.gridX + 1, y: robot.gridY }
      ];

      let bestSideStep = null;
      let maxDistToPeer = -1;

      for (const cell of neighbors) {
        if (!isWalkable(cell.x, cell.y)) continue;
        
        let overlapsPeer = false;
        if (robot.localPeerTable) {
           for (const p of robot.localPeerTable.values()) {
             const age = (typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0) - (p.timestamp || 0);
             const pktLoss = p.packetLoss || 0.0;
             const netConfidence = Math.max(0.0, 1.0 - (age / 3.0) - (pktLoss * 0.8));
             const poseConfidence = p.pose_confidence !== undefined ? p.pose_confidence : 1.0;
             const confidence = Math.min(netConfidence, poseConfidence);
             
             const safeDist = confidence >= 0.8 ? 0.5 : (confidence >= 0.5 ? 1.2 : 2.2);

             if (Math.hypot(p.pose.x - cell.x, p.pose.y - cell.y) <= safeDist) { overlapsPeer = true; break; }
             if (p.intent_tube) {
                for (const pt of p.intent_tube) {
                   if (Math.hypot(pt[0] - cell.x, pt[1] - cell.y) <= safeDist) { overlapsPeer = true; break; }
                }
             }
           }
        }
        if (overlapsPeer) continue;

        const d = Math.hypot(cell.x - peerPayload.pose.x, cell.y - peerPayload.pose.y);
        if (d > maxDistToPeer) {
          maxDistToPeer = d;
          bestSideStep = cell;
        }
      }

      const myScore = getRobotPriority(robot);
      const peerScore = peerPayload.priority !== undefined ? peerPayload.priority : getRobotPriority(peerPayload);
      const reasonStr = `priority ${myScore.toFixed(1)} < ${peerScore.toFixed(1)}; avoiding overlap at (${Math.round(peerPayload.pose.x)},${Math.round(peerPayload.pose.y)})`;

      if (bestSideStep) {
        if (!robot.savedDest && robot.path && robot.path.length > 0) {
          robot.savedDest = robot.path[robot.path.length - 1];
        }
        robot.isSideStepping = true;
        robot.isBackingUp = false;
        robot.escapePartnerId = peerId;
        setRobotPath(robot, [bestSideStep]);
        robot.isWaiting = false;
        robot._wasWaitingThisFrame = false;
        robot.waitTimer = 0;
        robot.statusBadge = 'STEP (YIELD)';
        thoughtLog.push(`Action: 90-degree Side-Step.`);
        robot.thoughtProcess = thoughtLog;
        if (robot.logStats) robot.logStats.totalSideSteps++;
        if (typeof onRobotJamEnd === 'function') onRobotJamEnd(robot, 'LOCAL_SIDESTEP_YIELD');
        if (typeof trafficMetrics !== 'undefined') trafficMetrics.totalReroutes = (trafficMetrics.totalReroutes || 0) + 1;
        if (typeof logTerminal === 'function') logTerminal('YIELD', 'tag-yield', `↔️ <strong>${robot.id}</strong> yields to <strong>${peerId}</strong>: <span style="color:#94a3b8;font-size:10px;">${reasonStr}</span>. Executing 90° side-step to clear corridor.`);
        return true;
      }

      // Strategy B: Reverse to previous topological node (Back up)
      let backPath = [];
      let currentX = robot.gridX;
      let currentY = robot.gridY;
      let trail = robot.recentVisitedCells || [];
      let startIdx = trail.length - 1;
      const depth = 6; // Check up to 6 blocks back

      for (let k = 0; k < depth; k++) {
        let nextCell = null;
        if (startIdx - k >= 0) {
          nextCell = trail[startIdx - k];
        } else {
          let dx = currentX - peerPayload.pose.x;
          let dy = currentY - peerPayload.pose.y;
          let stepX = 0, stepY = 0;
          if (Math.abs(dx) >= Math.abs(dy)) stepX = dx !== 0 ? Math.sign(dx) : (Math.cos(robot.heading) < 0 ? 1 : -1);
          else stepY = dy !== 0 ? Math.sign(dy) : (Math.sin(robot.heading) < 0 ? 1 : -1);
          nextCell = { x: currentX + stepX, y: currentY + stepY };
        }
        if (!isWalkable(nextCell.x, nextCell.y)) break;
        
        let occ = false;
        if (robot.localPeerTable) {
          for (const p of robot.localPeerTable.values()) {
             if (Math.round(p.pose.x) === nextCell.x && Math.round(p.pose.y) === nextCell.y) { occ = true; break; }
          }
        }
        if (occ) break;

        backPath.push({ x: nextCell.x, y: nextCell.y });
        currentX = nextCell.x;
        currentY = nextCell.y;
      }

      // FORCE MINIMUM 2.5 BLOCKS CLEARANCE: Keep pushing back until safely out of the way
      if (backPath.length > 0) {
          let lastPt = backPath[backPath.length - 1];
          let distToPeer = Math.hypot(lastPt.x - peerPayload.pose.x, lastPt.y - peerPayload.pose.y);
          
          let attempts = 0;
          while (distToPeer < 2.5 && attempts < 6) {
              let dx = Math.sign(lastPt.x - peerPayload.pose.x);
              let dy = Math.sign(lastPt.y - peerPayload.pose.y);
              if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
              
              let cand1 = { x: lastPt.x + dx, y: lastPt.y };
              let cand2 = { x: lastPt.x, y: lastPt.y + dy };
              
              let extended = false;
              for (let cand of [cand1, cand2]) {
                  if (isWalkable(cand.x, cand.y)) {
                      let occ = false;
                      if (robot.localPeerTable) {
                          for (const p of robot.localPeerTable.values()) {
                             if (Math.round(p.pose.x) === cand.x && Math.round(p.pose.y) === cand.y) { occ = true; break; }
                          }
                      }
                      if (!occ) {
                          backPath.push(cand);
                          lastPt = cand;
                          distToPeer = Math.hypot(lastPt.x - peerPayload.pose.x, lastPt.y - peerPayload.pose.y);
                          extended = true;
                          break;
                      }
                  }
              }
              if (!extended) break;
              attempts++;
          }
      }

      if (backPath.length > 0) {
        if (!robot.savedDest && robot.path && robot.path.length > 0) {
          robot.savedDest = robot.path[robot.path.length - 1];
        }
        robot.isBackingUp = true;
        robot.isSideStepping = false;
        robot.escapePartnerId = peerId;
        setRobotPath(robot, backPath);
        robot.isWaiting = false;
        robot._wasWaitingThisFrame = false;
        robot.waitTimer = 0;
        robot.statusBadge = `BACK ${backPath.length}`;
        thoughtLog.push(`Action: Reversing ${backPath.length} blocks to give space.`);
        robot.thoughtProcess = thoughtLog;
        if (robot.logStats) robot.logStats.totalBackupsToPreviousBox++;
        if (typeof onRobotJamEnd === 'function') onRobotJamEnd(robot, 'LOCAL_REVERSE_YIELD');
        if (typeof logTerminal === 'function') logTerminal('YIELD', 'tag-yield', `🔙 <strong>${robot.id}</strong> yields to <strong>${peerId}</strong>: <span style="color:#94a3b8;font-size:10px;">${reasonStr}</span>. Executing reverse maneuver (${backPath.length} cells).`);
        return true;
      }

      // Strategy C: Halt & Wait is handled by the physics engine if this returns false
      thoughtLog.push(`Action: Cannot move safely. Halting.`);
      robot.thoughtProcess = thoughtLog;
      return false;
    }

    // Re-route legacy global references to the new localized behavior to prevent breaks
    function executeSideStepYield(blocker, movingBot) {
       if (!blocker || !movingBot) return false;
       return executeLocalYieldBehavior(blocker, movingBot.id);
    }

    // Dynamic Overtaking Maneuver (Move to parallel line, pass bot, return to route)
    // Extracting fleet rerouting principles from amr-fleet-manager:
    // Strictly adheres to walkable corridors; pauses when passing is physically impossible.
    function attemptOvertake(robot, blocker, urgA = null, urgB = null) {
      if (!robot.path || robot.path.length === 0) return false;
      const dest = robot.path[robot.path.length - 1];
      if (!dest) return false;

      // In narrow single-lane rack aisles, overtaking is physically impossible (solid racks on both sides)
      if (typeof NARROW_AISLE_COLS !== 'undefined' && NARROW_AISLE_COLS.has(robot.gridX) && NARROW_AISLE_COLS.has(blocker.gridX)) {
        return false;
      }

      // If robot is already near dest, no overtake needed
      if (Math.hypot(robot.gridX - dest.x, robot.gridY - dest.y) <= 2.0) return false;

      // --- Relative Speed Gate ---
      // Only overtake if the follower is meaningfully faster, or blocker is fully stopped.
      const _bspd = ROBOT_BASE_SPEED;
      const actualSpeedA = (robot.currentSpeed !== undefined && robot.currentSpeed !== null) ? robot.currentSpeed : (_bspd * (robot.speedMultiplier || 1.0) * (robot.payloadDamping || 1.0));
      const actualSpeedB = (blocker.currentSpeed !== undefined && blocker.currentSpeed !== null) ? blocker.currentSpeed : (_bspd * (blocker.speedMultiplier || 1.0) * (blocker.payloadDamping || 1.0));
      const blockerFullyStopped = blocker.isWaiting || actualSpeedB < 0.05;
      const relativeAdvantage = actualSpeedA - actualSpeedB;
      if (!blockerFullyStopped && relativeAdvantage < actualSpeedA * 0.10) return false;

      // Avoid blocker's current grid target & physical position (moving object estimation)
      const avoidBlocker = new Set();
      avoidBlocker.add(`${blocker.gridX},${blocker.gridY}`);
      avoidBlocker.add(`${Math.round(blocker.x)},${Math.round(blocker.y)}`);

      // Avoid the blocker's "tail" (previous box) to ensure 1-block trailing personal space
      if (blocker.previousBox) {
        avoidBlocker.add(`${blocker.previousBox.x},${blocker.previousBox.y}`);
      } else if (blocker.recentVisitedCells && blocker.recentVisitedCells.length > 0) {
        const lastVis = blocker.recentVisitedCells[blocker.recentVisitedCells.length - 1];
        avoidBlocker.add(`${lastVis.x},${lastVis.y}`);
      }

      // Avoid projected path (up to 3 tiles ahead to prevent clipping the blocker's nose)
      if (blocker.path && blocker.pathIndex < blocker.path.length) {
        for (let p = blocker.pathIndex; p < Math.min(blocker.path.length, blocker.pathIndex + 3); p++) {
          avoidBlocker.add(`${blocker.path[p].x},${blocker.path[p].y}`);
        }
      }

      // Force an IMMEDIATE lateral swing by blocking the overtaking robot's next planned forward step
      if (robot.path && robot.pathIndex < robot.path.length) {
        const nextStep = robot.path[robot.pathIndex];
        if (nextStep.x !== dest.x || nextStep.y !== dest.y) {
          avoidBlocker.add(`${nextStep.x},${nextStep.y}`);
        }
      }

      // Also avoid any other robots that are stopped/waiting
      for (const o of AMR_FLEET) {
        if (o.id !== robot.id && (o.isWaiting || o.state === 'IDLE_CHARGING')) {
          avoidBlocker.add(`${o.gridX},${o.gridY}`);
        }
      }

      // Maintain passing lane discipline: do not move back to the rack line until destination column
      const isHorizontalHighway = (blocker.gridY === 23 || blocker.gridY === 24 || blocker.gridY === 25 || blocker.gridY === 26 || blocker.gridY <= 4 || blocker.gridY >= 45);
      if (isHorizontalHighway) {
        const minX = Math.min(robot.gridX, dest.x);
        const maxX = Math.max(robot.gridX, dest.x);
        for (let vx = minX; vx <= maxX; vx++) {
          // Leave the final turn column open so it can exit the highway safely
          if (Math.abs(vx - dest.x) > 1) {
            avoidBlocker.add(`${vx},${blocker.gridY}`);
          }
        }
      }

      let overtakePath = findPath(robot.gridX, robot.gridY, dest.x, dest.y, avoidBlocker);

      if (overtakePath && overtakePath.length > 0) {
        const remSteps = robot.path.length - robot.pathIndex;
        if (overtakePath.length <= remSteps + 35) { // Allow longer bypass due to strict lane discipline
          setRobotPath(robot, overtakePath);
          robot.isOvertaking = true;
          robot.overtakeTarget = blocker.id;
          robot.overtakeTimer = 8.0;
          robot.speedMultiplier = 1.35;
          robot.statusBadge = 'PASS';
          robot.isWaiting = false;
          robot.waitTimer = 0;
          robot.yieldTo = null;
          if (robot.logStats) robot.logStats.totalOvertakesInitiated++;
          if (typeof onRobotJamEnd === 'function') onRobotJamEnd(robot, 'OVERTAKEN_VIA_PARALLEL_LANE');
          if (typeof trafficMetrics !== 'undefined') trafficMetrics.totalOvertakes = (trafficMetrics.totalOvertakes || 0) + 1;

          // P2P Communication: Fast bot signals slow bot to hold position
          if (!blocker.isOvertaking && !blocker.isBackingUp && !blocker.isSideStepping) {
            blocker._pinnedForOvertake = true;
            blocker._pinnedTimer = 4.0;
            blocker.isWaiting = true;
            blocker._wasWaitingThisFrame = true;
            blocker.currentSpeed = 0;
            blocker.statusBadge = 'YIELDING';
            blocker.targetDesc = `Mesh Ack: Yielding lane to ${robot.id}`;
          }

          if (typeof logTerminal === 'function') logTerminal('OVERTAKE', 'tag-overtake', `🏎️ <strong>${robot.id}</strong> signaled <strong>${blocker.id}</strong> via P2P Mesh. Overtaking via parallel lane and maintaining lane discipline. Blocker holding position.`);
          if (typeof updateHudStats === 'function') updateHudStats();
          return true;
        }
      }

      // User Specification: Allow pausing because rerouting consumes more energy than pausing!
      return false;
    }

    // Re-route legacy global references to the new localized behavior to prevent breaks
    function attemptMoveBackToPreviousBox(bot, opposingBot, forceYield = true) {
       if (!bot || !opposingBot) return false;
       return executeLocalYieldBehavior(bot, opposingBot.id, forceYield);
    }