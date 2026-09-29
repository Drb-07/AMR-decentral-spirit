// =========================================================================
// DECENTRALIZED NETWORK TICK (Run this every frame in updateRobots)
// =========================================================================
function tickDecentralizedNetwork(dt) {
  if (typeof zenohMesh !== 'undefined') zenohMesh.deliverMessages(AMR_FLEET);
  const heartbeatInterval = typeof zenohMesh !== 'undefined' ? 1.0 / zenohMesh.config.messageRateHz : 0.1;
  
  for (const robot of AMR_FLEET) {
    if (robot.pose_confidence === undefined) robot.pose_confidence = 1.0;
    robot.pose_confidence = Math.max(0.2, robot.pose_confidence - (dt * 0.015)); 

    for (const other of AMR_FLEET) {
      if (robot.id !== other.id) {
        const dist = Math.hypot(robot.x - other.x, robot.y - other.y);
        if (dist < (robot.sensorRange || 6.0)) {
           if (typeof hasLineOfSight === 'function' && hasLineOfSight(robot.x, robot.y, other.x, other.y)) {
              robot.pose_confidence = Math.min(1.0, robot.pose_confidence + (dt * 0.5));
           }
        }
      }
    }

    if (totalSimSeconds - (robot.lastHeartbeatSimTime || 0) >= heartbeatInterval) {
      robot.lastHeartbeatSimTime = totalSimSeconds;
      
      let flags = 0;
      if (robot.state !== 'IDLE' && robot.state !== 'IDLE_CHARGING') flags |= 1; 
      if (robot.battery <= 25.0) flags |= 2;                                     
      if (robot.isWaiting) flags |= 4;                                           

      const rawTube = robot.path ? robot.path.slice(robot.pathIndex, robot.pathIndex + 21) : [];
      const intentTube = rawTube.map(pt => [pt.x, pt.y]);

      let activeTaskId = null;
      if (robot.inboundMission) activeTaskId = robot.inboundMission.id;
      else if (robot.outboundMission) activeTaskId = robot.outboundMission.orderId;
      else if (robot.returnMission) activeTaskId = robot.returnMission.id;

      if (!robot.heartbeatSeq) robot.heartbeatSeq = 0;
      robot.heartbeatSeq++;

      if (robot.isWaiting && robot.waitTimer > 1.5) {
         robot.jamBroadcastTimer = 4.0; 
      } else if (robot.jamBroadcastTimer > 0) {
         robot.jamBroadcastTimer -= dt;
      }
      
      let activeJam = null;
      if (robot.jamBroadcastTimer > 0) {
         activeJam = { x: Math.round(robot.x), y: Math.round(robot.y), radius: 2 };
      }

      const payload = {
        robot_id: robot.id,
        seq: robot.heartbeatSeq,
        pose: { x: Number(robot.x.toFixed(2)), y: Number(robot.y.toFixed(2)), theta: Number(robot.heading.toFixed(2)) },
        pose_confidence: Number(robot.pose_confidence.toFixed(2)), 
        intent_tube: intentTube,
        status_flags: flags,
        priority: typeof getRobotPriority === 'function' ? getRobotPriority(robot) : 50,
        active_task_id: activeTaskId,
        path_timestamp: robot.pathTimestamp || 0,
        active_jam: activeJam
      };
      
      if (typeof zenohMesh !== 'undefined') zenohMesh.publishHeartbeat(robot.id, robot.x, robot.y, payload);
    }
    
    // 3. Purge stale peer data & Self-Healing Task Continuity
    if (robot.localPeerTable) {
      for (const [peerId, peerData] of robot.localPeerTable.entries()) {
        if (totalSimSeconds - peerData.timestamp > 5.0) { 
          
          // FALSE ALARM GUARD: Check if the peer is actually dead in the global fleet
          const actualBot = typeof AMR_FLEET !== 'undefined' ? AMR_FLEET.find(b => b.id === peerId) : null;
          const isActuallyDead = !actualBot || actualBot.isFaulted || actualBot.state === 'OUT_OF_CHARGE' || 
                                 (totalSimSeconds - (actualBot.lastHeartbeatSimTime || 0) > 5.0);

          if (isActuallyDead && typeof DECENTRALIZED_CBBA_MODE !== 'undefined' && DECENTRALIZED_CBBA_MODE && peerData.active_task_id) {
             if (typeof zenohMesh !== 'undefined' && !zenohMesh.taskAnnouncements.has(peerData.active_task_id)) {
                if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>Dead-Node Confirmed</strong>: <strong>${peerId}</strong> unresponsive. Recovering task <strong>${peerData.active_task_id}</strong>!`);
                
                let recoveredTask = null; let taskSpec = null;
                
                const inb = typeof inboundMissions !== 'undefined' ? inboundMissions.find(m => m.id === peerData.active_task_id) : null;
                if (inb) { 
                    inb.status = 'PENDING'; inb.assignedRobotId = null; recoveredTask = inb; 
                    taskSpec = { kind: 'INBOUND', id: inb.id, ref: inb, targetX: inb.dockX, targetY: inb.dockY, totalWeight: inb.totalWeight, importance: inb.importance, slaPriority: typeof computeTaskPriorityScore === 'function' ? computeTaskPriorityScore(inb) : 50, desc: `Recovered Inbound ${inb.id}` }; 
                }
                
                const outb = typeof outboundMissions !== 'undefined' ? outboundMissions.find(m => m.orderId === peerData.active_task_id) : null;
                if (outb) { 
                   outb.status = 'PENDING'; outb.assignedRobotId = null; recoveredTask = outb; 
                   const tx = outb.itemsToPick && outb.itemsToPick[0] ? outb.itemsToPick[0].rack.x : 40;
                   const ty = outb.itemsToPick && outb.itemsToPick[0] ? outb.itemsToPick[0].rack.y : 25;
                   taskSpec = { kind: 'OUTBOUND', id: outb.orderId, ref: outb, targetX: tx, targetY: ty, totalWeight: outb.totalWeight, importance: outb.importance, slaPriority: typeof computeTaskPriorityScore === 'function' ? computeTaskPriorityScore(outb) : 50, desc: `Recovered Outbound ${outb.orderId}` };
                }

                const ret = typeof returnMissions !== 'undefined' ? returnMissions.find(m => m.id === peerData.active_task_id) : null;
                if (ret) { 
                   ret.status = 'PENDING'; ret.assignedRobotId = null; recoveredTask = ret; 
                   taskSpec = { kind: 'RETURN', id: ret.id, ref: ret, targetX: ret.dockX, targetY: ret.dockY, totalWeight: ret.totalWeight, importance: ret.importance, slaPriority: typeof computeTaskPriorityScore === 'function' ? computeTaskPriorityScore(ret) : 50, desc: `Recovered Return ${ret.id}` };
                }

                if (recoveredTask && taskSpec) zenohMesh.announceTask(taskSpec);
             }
          }
          robot.localPeerTable.delete(peerId);
        }
      }
    }
    
    if (typeof DECENTRALIZED_CBBA_MODE !== 'undefined' && DECENTRALIZED_CBBA_MODE && typeof zenohMesh !== 'undefined') {
        for (const task of zenohMesh.taskAnnouncements.values()) {
            const isEligible = (robot.state === 'IDLE' || robot.state === 'IDLE_CHARGING' || robot.state === 'RETURNING_HOME');
            const threshold = robot.proactiveChargeThreshold || 32.0;
            if (isEligible && robot.battery >= threshold && !(robot.state === 'IDLE_CHARGING' && robot.battery < 75.0)) {
                if (!task.bidders.has(robot.id)) {
                    if (typeof evaluateMissionEnergyFeasibility === 'function') {
                        const evalResult = evaluateMissionEnergyFeasibility(robot, task);
                        if (evalResult.feasible) {
                            const dist = Math.hypot(robot.x - task.targetX, robot.y - task.targetY);
                            const tTravel = dist / (typeof ROBOT_BASE_SPEED !== 'undefined' ? ROBOT_BASE_SPEED : 2.5);
                            let cCongestion = 0, cConflict = 0;
                            if (robot.localPeerTable) {
                                for (const p of robot.localPeerTable.values()) {
                                    if (Math.hypot(robot.x - p.pose.x, robot.y - p.pose.y) < 5.0) cConflict += 5.0;
                                }
                            }
                            const cBattery = Math.max(0, 100 - robot.battery) * 0.5;
                            const cDeadline = - ((task.slaPriority || 0) * 0.8);
                            const cost = tTravel + cCongestion + cBattery + cConflict + cDeadline;
                            
                            zenohMesh.publishBid(task.id, robot.id, cost, `Travel=${tTravel.toFixed(1)}, Batt=${cBattery.toFixed(1)}`);
                            task.bidders.add(robot.id);
                            robot.lastFeasibilityCheck = evalResult;
                        }
                    }
                }
            }
            if (totalSimSeconds - task.announceTime > 0.5) {
                const bids = zenohMesh.getBidsForTask(task.id);
                if (bids.length > 0) {
                    let best = bids[0];
                    for (const b of bids) if (b.cost < best.cost || (Math.abs(b.cost - best.cost) < 0.01 && b.robotId < best.robotId)) best = b;
                    if (best.robotId === robot.id && zenohMesh.claimTask(task.id, robot.id)) {
                        if (typeof executeTaskAssignment === 'function') executeTaskAssignment(robot, task, robot.lastFeasibilityCheck, best);
                    }
                }
            }
        }
        
        const threshold = robot.proactiveChargeThreshold || 32.0;
        const needsCharge = robot.state === 'IDLE' || robot.battery < threshold;
        const isEligibleForCharge = robot.state !== 'IDLE_CHARGING' && robot.state !== 'RETURNING_HOME' && !robot.inboundMission && !robot.outboundMission && !robot.returnMission && !robot.isFaulted && !robot.isUnderMaintenance;

        if (needsCharge && isEligibleForCharge) {
            for (const bay of zenohMesh.chargeAnnouncements.values()) {
                if (!bay.bidders.has(robot.id)) {
                    const dist = Math.hypot(robot.x - bay.x, robot.y - bay.y);
                    const cost = (dist / 4.0) - (Math.max(0, 100 - robot.battery) * 3.0);
                    zenohMesh.publishChargeBid(bay.id, robot.id, cost, "ChgBid");
                    bay.bidders.add(robot.id);
                }
                if (totalSimSeconds - bay.announceTime > 0.5) {
                    const bids = zenohMesh.getChargeBids(bay.id);
                    if (bids.length > 0) {
                        let best = bids[0];
                        for (const b of bids) if (b.cost < best.cost || (Math.abs(b.cost - best.cost) < 0.01 && b.robotId < best.robotId)) best = b;
                        if (best.robotId === robot.id && zenohMesh.claimChargeBay(bay.id, robot.id)) {
                            if (typeof reserveCharger === 'function') reserveCharger(bay.id, robot.id);
                            if (typeof claimTerminalDestination === 'function') claimTerminalDestination(robot.id, bay.x, bay.y);
                            robot.state = 'RETURNING_HOME';
                            robot.statusBadge = robot.battery <= 25.0 ? 'LOW BATT' : 'TO CHG';
                            const chgPath = findPath(robot.gridX, robot.gridY, bay.x, bay.y);
                            setRobotPath(robot, chgPath);
                            if (robot.path && robot.path.length === 0 && typeof onRobotReachedDestination === 'function') onRobotReachedDestination(robot);
                        }
                    }
                }
            }
        }
    }
  }
}

function isWalkable(x, y) {
  if (typeof mapData === 'undefined' || !mapData) return false;
  if (x < 0 || x >= mapData.width || y < 0 || y >= mapData.height) return false;
  return mapData.grid[x][y] !== 1;
}

function getAccessPointForRack(rx, ry, fromX, fromY, requestingRobotId = null) {
  const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
  let bestAny = null;
  let minAnyDist = Infinity;

  for (const d of dirs) {
    const ax = rx + d.dx;
    const ay = ry + d.dy;
    if (isWalkable(ax, ay)) {
      const dist = Math.abs(ax - fromX) + Math.abs(ay - fromY);
      if (dist < minAnyDist) {
        minAnyDist = dist;
        bestAny = { x: ax, y: ay };
      }
    }
  }
  if (bestAny && requestingRobotId && typeof claimTerminalDestination === 'function') {
      claimTerminalDestination(requestingRobotId, bestAny.x, bestAny.y);
  }
  return bestAny;
}

// =========================================================================
// SPACE-TIME A* PATHFINDER: Strict Lanes & Crosswalk Rules
// =========================================================================
function findPath(sx, sy, gx, gy, avoidCells = null, requestingRobotId = null) {
  if (sx === gx && sy === gy) return [];
  const width = mapData.width;
  const height = mapData.height;
  if (gx < 0 || gx >= width || gy < 0 || gy >= height || mapData.grid[gx][gy] === 1) {
      const access = getAccessPointForRack(gx, gy, sx, sy, requestingRobotId);
      if (!access) return [];
      gx = access.x;
      gy = access.y;
      if (sx === gx && sy === gy) return [];
  }

  const avoidSet = new Set();
  if (avoidCells) {
      for (const key of avoidCells) avoidSet.add(key);
  }

  const reqRobot = typeof AMR_FLEET !== 'undefined' ? AMR_FLEET.find(b => b.id === requestingRobotId) : null;
  const peerData = reqRobot && reqRobot.localPeerTable ? Array.from(reqRobot.localPeerTable.values()) : [];
  
  for (const peer of peerData) {
      if (peer.active_jam) {
          const jx = peer.active_jam.x, jy = peer.active_jam.y, jrad = peer.active_jam.radius || 2;
          for (let dx = -jrad; dx <= jrad; dx++) {
              for (let dy = -jrad; dy <= jrad; dy++) avoidSet.add(`${jx+dx},${jy+dy}`);
          }
      }
      if (peer.intent_tube && peer.intent_tube.length > 0) {
          for (let i = 0; i < Math.min(4, peer.intent_tube.length); i++) {
              avoidSet.add(`${Math.round(peer.intent_tube[i][0])},${Math.round(peer.intent_tube[i][1])}`);
          }
      }
  }

  const EASTBOUND_ROWS = new Set([2, 22, 24, 44, 46]); 
  const WESTBOUND_ROWS = new Set([3, 4, 5, 23, 25, 26, 27, 45, 47]); 
  const NARROW_AISLE_COLS_SET = typeof NARROW_AISLE_COLS !== 'undefined' ? NARROW_AISLE_COLS : new Set();

  const openSet = [];
  const gScore = new Map();
  const cameFrom = new Map();

  const startKey = `${sx},${sy}`;
  openSet.push({ x: sx, y: sy, f: Math.abs(sx - gx) + Math.abs(sy - gy), dir: null });
  gScore.set(startKey, 0);

  const dirs = [ {dx: 0, dy: -1}, {dx: 0, dy: 1}, {dx: -1, dy: 0}, {dx: 1, dy: 0} ];

  while (openSet.length > 0) {
      openSet.sort((a, b) => a.f - b.f);
      const curr = openSet.shift();
      const currKey = `${curr.x},${curr.y}`;

      if (curr.x === gx && curr.y === gy) {
          const path = [];
          let trace = currKey;
          while (cameFrom.has(trace)) {
              const node = cameFrom.get(trace);
              path.push({ x: parseInt(trace.split(',')[0]), y: parseInt(trace.split(',')[1]) });
              trace = `${node.x},${node.y}`;
          }
          path.reverse();
          return path;
      }

      for (const d of dirs) {
          const nx = curr.x + d.dx;
          const ny = curr.y + d.dy;
          const nKey = `${nx},${ny}`;

          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (mapData.grid[nx][ny] === 1) continue;
          if (avoidSet.has(nKey) && nKey !== `${gx},${gy}`) continue;

          // 1. CHARGER FREEZE FIX: Forward-First Exit and Entry Rules
          if (curr.y === 1 && (ny !== 2 || nx !== curr.x)) continue;
          if (curr.y === 48 && (ny !== 47 || nx !== curr.x)) continue;
          if (ny === 1 && (curr.y !== 2 || curr.x !== nx)) continue;
          if (ny === 48 && (curr.y !== 47 || curr.x !== nx)) continue;
          if ((ny === 1 || ny === 48) && (nx !== gx || ny !== gy) && (nx !== sx || ny !== sy)) continue;

          // 2. DOCK BUFFERS (Crosswalk Rule): No vertical driving allowed on Docks or their immediate buffers.
          if ((nx === 1 || nx === 2 || nx === 167 || nx === 168) && d.dy !== 0) continue;

          // 3. STRICT 1-WAY HORIZONTAL HIGHWAYS (Exempts the dock crosswalk zones so they can turn to leave!)
          if (nx >= 5 && nx <= 164) {
              if (EASTBOUND_ROWS.has(ny) && d.dx < 0) continue;
              if (WESTBOUND_ROWS.has(ny) && d.dx > 0) continue;
          }

          // 4. STRICT 1-WAY VERTICAL HIGHWAYS
          if (nx === 3 && d.dy > 0) continue;   // x=3 is Left lane, goes UP (North)
          if (nx === 4 && d.dy < 0) continue;   // x=4 is Right lane, goes DOWN (South)
          if (nx === 165 && d.dy > 0) continue; // x=165 is Left lane, goes UP (North)
          if (nx === 166 && d.dy < 0) continue; // x=166 is Right lane, goes DOWN (South)

          // 5. NARROW AISLE DIRECTIONALITY
          if (NARROW_AISLE_COLS_SET.has(nx) && d.dy !== 0) {
              const isSouthboundAisle = (nx % 2 === 0);
              if (isSouthboundAisle && d.dy < 0) continue; 
              if (!isSouthboundAisle && d.dy > 0) continue; 
          }

          // 6. TURN PENALTY
          const isTurn = curr.dir !== null && (curr.dir.dx !== d.dx || curr.dir.dy !== d.dy);
          const moveCost = isTurn ? 2.5 : 1.0; 

          const tentG = gScore.get(currKey) + moveCost;

          if (!gScore.has(nKey) || tentG < gScore.get(nKey)) {
              cameFrom.set(nKey, { x: curr.x, y: curr.y });
              gScore.set(nKey, tentG);
              const h = Math.abs(nx - gx) + Math.abs(ny - gy);
              openSet.push({ x: nx, y: ny, f: tentG + h, dir: d });
          }
      }
  }
  return []; 
}

const GLOBAL_TRAJECTORIES = new Map(); 

function setRobotPath(robot, newPath) {
  if (!robot) return;
  
  if (!newPath || !Array.isArray(newPath) || newPath.length === 0) {
    robot.path = [];
    robot.pathIndex = 0;
    return;
  }

  const rawDest = newPath[newPath.length - 1];
  if (rawDest && typeof rawDest.x === 'number' && typeof rawDest.y === 'number') {
    robot.currentDestination = { x: rawDest.x, y: rawDest.y };
  }

  const valid = [];
  let prevX = robot.gridX !== undefined ? robot.gridX : Math.round(robot.x);
  let prevY = robot.gridY !== undefined ? robot.gridY : Math.round(robot.y);

  for (let i = 0; i < newPath.length; i++) {
    const pt = newPath[i];
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') continue;
    if (!isWalkable(pt.x, pt.y)) break;
    
    const manhattan = Math.abs(pt.x - prevX) + Math.abs(pt.y - prevY);
    if (manhattan > 1) {
      const bridge = findPath(prevX, prevY, pt.x, pt.y);
      if (bridge && bridge.length > 0) {
        valid.push(...bridge);
        prevX = pt.x; prevY = pt.y;
        continue;
      }
    }
    valid.push({ x: pt.x, y: pt.y });
    prevX = pt.x; prevY = pt.y;
  }
  robot.path = valid;
  robot.pathIndex = 0;
  robot.pathTimestamp = typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0;
  
  // Re-broadcast intent immediately so peers see the new path
  if (typeof zenohMesh !== 'undefined') {
      const intentTube = robot.path.slice(0, 21).map(pt => [pt.x, pt.y]);
      zenohMesh.publishHeartbeat(robot.id, robot.x, robot.y, {
        robot_id: robot.id,
        seq: (robot.heartbeatSeq || 0) + 1,
        pose: { x: Number(robot.x.toFixed(2)), y: Number(robot.y.toFixed(2)), theta: Number(robot.heading.toFixed(2)) },
        pose_confidence: Number((robot.pose_confidence || 1.0).toFixed(2)),
        intent_tube: intentTube,
        status_flags: 0,
        priority: typeof getRobotPriority === 'function' ? getRobotPriority(robot) : 50,
        path_timestamp: robot.pathTimestamp,
        active_jam: null
      });
  }
}
