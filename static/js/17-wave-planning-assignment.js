    // Order Batching & Wave Planning (Multi-Order Spatial Centroid Clustering)
    // Deeply packs nearby outbound orders into dense consolidated wave trips up to payload capacity
    function planOutboundWaveBatches() {
      if (!outboundMissions || outboundMissions.length < 2) return;

      const pendingOrders = outboundMissions.filter(m => m.status === 'PENDING' && !m.assignedRobotId && m.itemsToPick && m.itemsToPick.length > 0);
      if (pendingOrders.length < 2) return;

      // 1. Calculate spatial center-of-mass (centroid) for all pending orders
      pendingOrders.forEach(ord => {
        let sumX = 0, sumY = 0, validRacks = 0;
        ord.itemsToPick.forEach(it => {
          if (it.rack) { sumX += it.rack.x; sumY += it.rack.y; validRacks++; }
        });
        ord.centroid = validRacks > 0 ? { x: sumX / validRacks, y: sumY / validRacks } : { x: ord.bayX || 0, y: ord.bayY || 0 };
      });

      for (let i = 0; i < pendingOrders.length; i++) {
        const ordA = pendingOrders[i];
        if (ordA.status !== 'PENDING' || ordA.assignedRobotId) continue;

        let mergedCount = 0;
        const candidateIndices = [];
        
        // 2. Identify all other unassigned orders in the same zone
        for (let j = i + 1; j < pendingOrders.length; j++) {
          const ordB = pendingOrders[j];
          if (ordB.status !== 'PENDING' || ordB.assignedRobotId) continue;
          
          const centroidDist = Math.abs(ordA.centroid.x - ordB.centroid.x) + Math.abs(ordA.centroid.y - ordB.centroid.y);
          const sameBay = (ordA.bayId === ordB.bayId);
          if (centroidDist <= 28 || sameBay) {
             candidateIndices.push(j);
          }
        }

        // 3. Sort candidates greedily by proximity to the anchor order's centroid
        candidateIndices.sort((idx1, idx2) => {
           const b1 = pendingOrders[idx1];
           const b2 = pendingOrders[idx2];
           const d1 = Math.abs(ordA.centroid.x - b1.centroid.x) + Math.abs(ordA.centroid.y - b1.centroid.y);
           const d2 = Math.abs(ordA.centroid.x - b2.centroid.x) + Math.abs(ordA.centroid.y - b2.centroid.y);
           return d1 - d2;
        });

        // 4. Continuously pack nearest orders until physical tote maxes out
        for (const j of candidateIndices) {
          const ordB = pendingOrders[j];
          if (ordB.status !== 'PENDING' || ordB.assignedRobotId) continue;

          if ((ordA.totalWeight + ordB.totalWeight) > 55.0) continue;
          if ((ordA.totalItems + ordB.totalItems) > 10) continue;

          if (!ordA.isWaveBatch) {
            ordA.isWaveBatch = true;
            ordA.waveOrderIds = [ordA.orderId];
            ordA.pendingDeliveries = [{
              bayId: ordA.bayId, bayX: ordA.bayX, bayY: ordA.bayY, orderId: ordA.orderId, itemsCount: ordA.totalItems, weight: ordA.totalWeight, importance: ordA.importance, createdSimTimeSec: ordA.createdSimTimeSec || totalSimSeconds
            }];
          }

          ordA.waveOrderIds.push(ordB.orderId);
          ordA.pendingDeliveries.push({
            bayId: ordB.bayId, bayX: ordB.bayX, bayY: ordB.bayY, orderId: ordB.orderId, itemsCount: ordB.totalItems, weight: ordB.totalWeight, importance: ordB.importance, createdSimTimeSec: ordB.createdSimTimeSec || totalSimSeconds
          });

          ordA.itemsToPick.forEach(it => { if (!it.forOrderId) it.forOrderId = ordA.orderId; });
          ordB.itemsToPick.forEach(it => { it.forOrderId = ordB.orderId; });

          ordA.itemsToPick.push(...ordB.itemsToPick);
          ordA.totalItems += ordB.totalItems;
          ordA.totalWeight += ordB.totalWeight;
          
          // Dynamically shift the routing centroid as the batch grows
          ordA.centroid.x = (ordA.centroid.x + ordB.centroid.x) / 2;
          ordA.centroid.y = (ordA.centroid.y + ordB.centroid.y) / 2;

          if ((ordB.importance && ordB.importance.baseUrgency) > (ordA.importance && ordA.importance.baseUrgency)) {
            ordA.importance = ordB.importance;
          }

          ordB.status = 'MERGED'; // Mark for cleanup
          ordB.itemsToPick = []; // Prevent stale execution: items now live on ordA
          // Retract any outstanding mesh announcement/bids for the merged-away order,
          // so a robot mid-bid on ordB doesn't later claim a task whose mission is gone.
          if (typeof zenohMesh !== 'undefined') {
            zenohMesh.taskAnnouncements.delete(ordB.orderId);
            zenohMesh.taskBids.delete(ordB.orderId);
          }
          mergedCount++;
        }
        
        if (mergedCount > 0) {
          if (typeof logTerminal === 'function') logTerminal('DISPATCH', 'tag-outbound', `🌊 <strong>Dense Wave Batch Formed</strong>: Clustered <strong>${mergedCount + 1} orders</strong> (Anchor: <strong>${ordA.orderId}</strong>) into a single pick tour (${ordA.totalItems} items, ${ordA.totalWeight.toFixed(1)}kg) via spatial centroid grouping!`);
        }
      }

      // 5. Sweep global queue for merged components
      for (let i = outboundMissions.length - 1; i >= 0; i--) {
         if (outboundMissions[i].status === 'MERGED') {
            outboundMissions.splice(i, 1);
         }
      }
    }

    // Kuhn-Munkres (Hungarian) Algorithm for Maximum Utility Bipartite Assignment
    // Finds global optimal robot -> task assignment minimizing total fleet travel & deadheading
    function solveOptimalFleetAssignment(costMatrix) {
      const n = costMatrix.length;
      if (n === 0) return [];
      const m = costMatrix[0].length;
      if (m === 0) return [];

      const dim = Math.max(n, m);
      const u = new Array(dim + 1).fill(0);
      const v = new Array(dim + 1).fill(0);
      const p = new Array(dim + 1).fill(0);
      const way = new Array(dim + 1).fill(0);

      for (let i = 1; i <= dim; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(dim + 1).fill(Infinity);
        const used = new Array(dim + 1).fill(false);

        do {
          used[j0] = true;
          const i0 = p[j0];
          let delta = Infinity;
          let j1 = 0;

          for (let j = 1; j <= dim; j++) {
            if (!used[j]) {
              const cost = (i0 <= n && j <= m) ? costMatrix[i0 - 1][j - 1] : 1e9;
              const cur = cost - u[i0] - v[j];
              if (cur < minv[j]) {
                minv[j] = cur;
                way[j] = j0;
              }
              if (minv[j] < delta) {
                delta = minv[j];
                j1 = j;
              }
            }
          }

          for (let j = 0; j <= dim; j++) {
            if (used[j]) {
              u[p[j]] += delta;
              v[j] -= delta;
            } else {
              minv[j] -= delta;
            }
          }
          j0 = j1;
        } while (p[j0] !== 0);

        do {
          const j1 = way[j0];
          p[j0] = p[j1];
          j0 = j1;
        } while (j0 !== 0);
      }

      const matches = [];
      for (let j = 1; j <= m; j++) {
        const worker = p[j] - 1;
        if (worker >= 0 && worker < n) {
          matches.push({ robotIdx: worker, taskIdx: j - 1 });
        }
      }
      return matches;
    }

    // High-Efficiency AMR Task Assignment (Multi-Objective Scoring)
    function getBestRobotForTask(task) {
      let bestRobot = null;
      let bestScore = -Infinity;

      for (const robot of AMR_FLEET) {
        const isEligible = (robot.state === 'IDLE' || robot.state === 'IDLE_CHARGING' || robot.state === 'RETURNING_HOME');
        if (!isEligible) continue;

        // Proactive Staggered Charging Safeguard:
        const threshold = robot.proactiveChargeThreshold || 32.0;
        if (robot.battery < threshold) {
          if (robot.state === 'IDLE') {
            routeRobotToNearestCharger(robot, 'PROACTIVE_STAGGERED_CHARGE');
          }
          continue;
        }

        const evalResult = evaluateMissionEnergyFeasibility(robot, task);
        robot.lastFeasibilityCheck = evalResult;

        if (!evalResult.feasible) {
          if (robot.state === 'IDLE') {
            const reasonTag = evalResult.chanceGoingBelow10 ? 'CHANCE_BELOW_10_PERCENT' : 'INSUFFICIENT_MISSION_CHARGE';
            routeRobotToNearestCharger(robot, reasonTag, {
              missionDesc: task.desc || task.type,
              eRequired: evalResult.eRequired
            });
          }
          continue;
        }

        if (robot.state === 'IDLE_CHARGING' && robot.battery < 75.0) continue;

        let targetX = task.type === 'INBOUND' ? task.dockX : (task.rack ? task.rack.x : 40);
        let targetY = task.type === 'INBOUND' ? task.dockY : (task.rack ? task.rack.y : 25);

        const dist = Math.hypot(robot.x - targetX, robot.y - targetY);
        const slaScore = computeTaskPriorityScore(task);

        let score = (slaScore * 2.5) - (dist * 2.2) + ((robot.battery / 100) * 40.0) + (evalResult.margin * 1.5);
        if (robot.state === 'IDLE') score += 30;
        else if (robot.state === 'RETURNING_HOME') score += 15;

        const seg = getNarrowAisleSegment(targetX, targetY);
        if (seg && getNarrowAisleOccupant(seg, robot.id)) score -= 35;

        if (score > bestScore) {
          bestScore = score;
          bestRobot = robot;
        }
      }
      return bestRobot;
    }

    // Helper function executed by either CBBA Consensus or Hungarian Allocator
    // Helper function executed by either CBBA Consensus or Hungarian Allocator
    function executeTaskAssignment(robot, task, evalResult, bestBid) {
      // 1. CRASH GUARD: Abort if the task reference is missing or corrupted
      if (!task || !task.ref) {
          console.warn(`[Assignment] Aborted: Missing 'ref' for task ID: ${task ? task.id : 'unknown'}`);
          return;
      }

      // Safely define the bid reason string to prevent ReferenceErrors
      const bidReason = (bestBid && bestBid.details) ? ` [Bid details: ${bestBid.details}]` : '';

      if (task.kind === 'INBOUND') {
        const mission = task.ref;
        if (typeof undockFromCharger === 'function') undockFromCharger(robot.id);
        mission.status = 'ASSIGNED';
        mission.assignedRobotId = robot.id;
        robot.state = 'MOVING_TO_PICKUP';
        robot.inboundMission = mission;
        robot.missionStartTime = Date.now();
        robot.targetDesc = `Dock ${mission.dockId} (Inbound Load: ${mission.parcels.length} pkgs)`;
        claimTerminalDestination(robot.id, mission.dockX, mission.dockY);
        setRobotPath(robot, findPath(robot.gridX, robot.gridY, mission.dockX, mission.dockY));

        const strategyTag = (typeof DECENTRALIZED_CBBA_MODE !== 'undefined' && DECENTRALIZED_CBBA_MODE) ? 'CBBA Consensus' : 'Hungarian Opt';
        if (typeof logTerminal === 'function') {
           logTerminal('DISPATCH', 'tag-inbound', `⚡ <strong>${robot.id}</strong> Assigned (${strategyTag}, SLA: <span style="color:${mission.importance.color};font-weight:700;">${mission.importance.shortLabel || mission.importance.code}</span>): Dock <strong>${mission.dockId}</strong> (${mission.parcels.length} pkgs, +${evalResult ? evalResult.margin : '0'}% margin, SoC: <strong>${robot.battery.toFixed(1)}%</strong>). Undocked from charger.${bidReason}`);
        }

        if (robot.path.length === 0 && typeof onRobotReachedDestination === 'function') onRobotReachedDestination(robot);

      } else if (task.kind === 'OUTBOUND') {
        const mission = task.ref;

        if (!mission || mission.status === 'MERGED' || !mission.itemsToPick || mission.itemsToPick.length === 0) {
          if (typeof logTerminal === 'function') {
            logTerminal('ALERT', 'tag-yield', `⚠️ <strong>${robot.id}</strong> claimed stale/consumed task <strong>${task.id || (mission && mission.orderId)}</strong>. Dropping claim, returning to IDLE.`);
          }
          robot.state = 'IDLE';
          return;
        }

        if (typeof undockFromCharger === 'function') undockFromCharger(robot.id);
        mission.status = 'ASSIGNED';
        mission.assignedRobotId = robot.id;
        if (typeof sortItemsByProximity === 'function') {
            mission.itemsToPick = sortItemsByProximity(mission.itemsToPick, robot.gridX, robot.gridY);
        }
        const currentPick = mission.itemsToPick[0];
        robot.state = 'ORDER_PICKING';
        robot.outboundMission = mission;
        robot.missionStartTime = Date.now();
        robot.orderBox = {
          orderId: mission.orderId,
          bayId: mission.bayId,
          totalItems: mission.totalItems,
          items: [],
          importance: mission.importance,
          totalWeight: mission.totalWeight,
          isWaveBatch: !!mission.isWaveBatch
        };
        const access = getAccessPointForRack(currentPick.rack.x, currentPick.rack.y, robot.gridX, robot.gridY, robot.id);
        robot.targetDesc = `${mission.isWaveBatch ? 'Wave Pick' : 'Order Pick'} 1/${mission.totalItems} for ${mission.orderId} at Rack (${currentPick.rack.x},${currentPick.rack.y})`;
        robot.statusBadge = `PICK 0/${mission.totalItems}`;

        const strategyTag = (typeof DECENTRALIZED_CBBA_MODE !== 'undefined' && DECENTRALIZED_CBBA_MODE) ? 'CBBA Consensus' : 'Hungarian Opt';
        if (typeof logTerminal === 'function') {
           logTerminal('DISPATCH', 'tag-outbound', `⚡ <strong>${robot.id}</strong> Assigned (${strategyTag}, SLA: <span style="color:${mission.importance.color};font-weight:700;">${mission.importance.shortLabel || mission.importance.code}</span>): ${mission.isWaveBatch ? 'Wave Batch' : 'Order'} <strong>${mission.orderId}</strong> (${mission.totalItems} items, ${mission.totalWeight.toFixed(1)}kg, +${evalResult ? evalResult.margin : '0'}% margin, SoC: <strong>${robot.battery.toFixed(1)}%</strong>). Undocked from charger.${bidReason}`);
        }

        if (access) {
          setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
          if (robot.path.length === 0 && typeof onRobotReachedDestination === 'function') onRobotReachedDestination(robot);
        }

      } else if (task.kind === 'RETURN') {
        const mission = task.ref;
        if (typeof undockFromCharger === 'function') undockFromCharger(robot.id);
        mission.status = 'ASSIGNED';
        mission.assignedRobotId = robot.id;
        robot.state = 'MOVING_TO_RETURN_DOCK';
        robot.returnMission = mission;
        robot.missionStartTime = Date.now();
        robot.targetDesc = `Returns Dock ${mission.dockId} (Putback: ${mission.parcels.length} item(s))`;
        robot.statusBadge = 'RETURN';
        claimTerminalDestination(robot.id, mission.dockX, mission.dockY);
        setRobotPath(robot, findPath(robot.gridX, robot.gridY, mission.dockX, mission.dockY));
        
        if (typeof logTerminal === 'function') {
           logTerminal('DISPATCH', 'tag-inbound', `♻️ <strong>${robot.id}</strong> dispatched for Returns Putback: Dock <strong>${mission.dockId}</strong> (${mission.parcels.length} item(s), ${mission.totalWeight.toFixed(1)}kg)${bidReason}`);
        }
        
        if (robot.path.length === 0 && typeof onRobotReachedDestination === 'function') onRobotReachedDestination(robot);
      }
    }

    function dispatchFleet() {
      // 1. Wave Planning: Consolidate compatible pending outbound orders into wave batches
      planOutboundWaveBatches();

      // 2. Identify candidate tasks (Inbound & Outbound)
      const candidateTasks = [];

      // Collect available Inbound missions where dock is not currently busy or reserved
      for (const mission of inboundMissions) {
        if (mission.status === 'PENDING') {
          const dockBusy = inboundMissions.some(m => m.status === 'ASSIGNED' && m.dockId === mission.dockId) ||
                           AMR_FLEET.some(b => (b.inboundMission && b.inboundMission.dockId === mission.dockId) ||
                                               (Math.hypot(b.x - mission.dockX, b.y - mission.dockY) < 1.5));
          if (!dockBusy) {
            candidateTasks.push({
              kind: 'INBOUND',
              ref: mission,
              dockId: mission.dockId,
              targetX: mission.dockX,
              targetY: mission.dockY,
              totalWeight: mission.totalWeight,
              parcels: mission.parcels,
              importance: mission.importance,
              createdAt: mission.createdAt,
              slaPriority: computeTaskPriorityScore(mission),
              desc: `Inbound Load at Dock ${mission.dockId}`
            });
          }
        }
      }

      // Collect available Outbound missions
      for (const mission of outboundMissions) {
        if (mission.status === 'PENDING' && mission.itemsToPick && mission.itemsToPick.length > 0) {
          const firstPick = mission.itemsToPick[0];
          if (firstPick && firstPick.rack) {
            candidateTasks.push({
              kind: 'OUTBOUND',
              ref: mission,
              orderId: mission.orderId,
              bayId: mission.bayId,
              targetX: firstPick.rack.x,
              targetY: firstPick.rack.y,
              totalWeight: mission.totalWeight,
              totalItems: mission.totalItems,
              itemsToPick: mission.itemsToPick,
              importance: mission.importance,
              createdAt: mission.createdAt,
              slaPriority: computeTaskPriorityScore(mission),
              desc: mission.isWaveBatch ? `Wave Order ${mission.orderId}` : `Order ${mission.orderId}`
            });
          }
        }
      }

      // Feature 9A: Collect available Return missions
      for (const mission of returnMissions) {
        if (mission.status === 'PENDING') {
          const dockBusy = returnMissions.some(m => m.status === 'ASSIGNED' && m.dockId === mission.dockId) ||
                           AMR_FLEET.some(b => b.returnMission && b.returnMission.dockId === mission.dockId);
          if (!dockBusy) {
            candidateTasks.push({
              kind: 'RETURN',
              ref: mission,
              dockId: mission.dockId,
              targetX: mission.dockX,
              targetY: mission.dockY,
              totalWeight: mission.totalWeight,
              parcels: mission.parcels,
              importance: mission.importance,
              createdAt: mission.createdAt,
              slaPriority: computeTaskPriorityScore(mission) - 5, // Lower priority than fresh inbound
              desc: `Returns Putback at Dock ${mission.dockId}`
            });
          }
        }
      }


      // Sort candidate tasks by SLA priority (VIP Express preempts Standard & Economy)
      candidateTasks.sort((a, b) => b.slaPriority - a.slaPriority);

      // 3. Identify eligible robots
      const eligibleRobots = [];
      for (const robot of AMR_FLEET) {
        if (robot.isFaulted || robot.isUnderMaintenance || robot.state === 'HARDWARE_FAULT' || robot.state === 'MARKED_FOR_MAINTENANCE') continue;
        const isEligibleState = (robot.state === 'IDLE' || robot.state === 'IDLE_CHARGING' || robot.state === 'RETURNING_HOME');
        if (!isEligibleState) continue;

        // Proactive Staggered Charging Safeguard:
        const threshold = robot.proactiveChargeThreshold || 32.0;
        if (robot.battery < threshold) {
          if (robot.state === 'IDLE') {
            routeRobotToNearestCharger(robot, 'PROACTIVE_STAGGERED_CHARGE');
          }
          continue;
        }

        // Charging undock readiness (bulk >=75% SoC)
        if (robot.state === 'IDLE_CHARGING' && robot.battery < 75.0) continue;

        eligibleRobots.push(robot);
      }

      // 4. Task Assignment (CBBA vs Hungarian Baseline)
      if (DECENTRALIZED_CBBA_MODE) {
         // PHASE 5: WMS Announce (Decentralized Mode)
         for (const task of candidateTasks) {
            task.id = task.kind === 'INBOUND' ? task.ref.id : (task.kind === 'OUTBOUND' ? task.ref.orderId : task.ref.id);
            zenohMesh.announceTask(task);
         }
         
         // PHASE 8: Chargers Announce Availability to Mesh
         if (typeof CHARGING_PORTS !== 'undefined') {
           for (const port of CHARGING_PORTS) {
             if (!port.isFaulted && !port.occupiedBy && !port.reservedBy) {
               zenohMesh.announceChargeBay({ id: port.id, x: port.x, y: port.y, zone: port.zone });
             }
           }
         }
      } else {
         // BASELINE: Batch Assignment Optimization (Hungarian Algorithm)
         if (candidateTasks.length > 0 && eligibleRobots.length > 0) {
           const N = eligibleRobots.length;
           const M = candidateTasks.length;
        const utilityMatrix = [];
        const evalCache = {};

        for (let i = 0; i < N; i++) {
          utilityMatrix[i] = [];
          const robot = eligibleRobots[i];

          for (let j = 0; j < M; j++) {
            const task = candidateTasks[j];
            const taskSpec = task.kind === 'INBOUND' ? {
              type: 'INBOUND',
              dockId: task.dockId,
              dockX: task.targetX,
              dockY: task.targetY,
              parcels: task.parcels,
              totalWeight: task.totalWeight,
              desc: task.desc
            } : {
              type: 'OUTBOUND',
              rack: { x: task.targetX, y: task.targetY },
              itemsToPick: task.itemsToPick,
              bayId: task.bayId,
              bayX: task.ref.bayX,
              bayY: task.ref.bayY,
              totalWeight: task.totalWeight,
              desc: task.desc
            };

            const evalResult = evaluateMissionEnergyFeasibility(robot, taskSpec);
            evalCache[`${i}_${j}`] = evalResult;

            if (!evalResult.feasible) {
              utilityMatrix[i][j] = -1e7; // Infeasible! Never match
              continue;
            }

            // Multi-Objective Scoring:
            // 1. Travel distance to mission starting point
            const dist = Math.hypot(robot.x - task.targetX, robot.y - task.targetY);

            // 2. SLA Urgency weight: VIP Express tasks receive heavy score dominance
            const slaWeight = task.slaPriority * 2.5;

            // 3. Distance penalty: minimize total fleet travel
            const distPenalty = dist * 2.2;

            // 4. Battery SoC and safety margin bonus: prefer healthier bots with larger margin
            const battBonus = (robot.battery / 100) * 40.0 + evalResult.margin * 1.5;

            // 5. Active floor readiness: IDLE bots on floor don't suffer undocking delay
            const readinessBonus = (robot.state === 'IDLE' ? 30.0 : (robot.state === 'RETURNING_HOME' ? 15.0 : 0.0));

            // 6. Traffic / Narrow aisle congestion avoidance
            const seg = getNarrowAisleSegment(task.targetX, task.targetY);
            const aisleBusy = seg ? (getNarrowAisleOccupant(seg, robot.id) !== null) : false;
            const congestionPenalty = aisleBusy ? 35.0 : 0.0;

            utilityMatrix[i][j] = slaWeight - distPenalty + battBonus + readinessBonus - congestionPenalty;
          }
        }

        // Convert Utility Matrix to Cost Matrix for Hungarian minimization
        let maxU = -Infinity;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < M; j++) {
            if (utilityMatrix[i][j] > -1e6 && utilityMatrix[i][j] > maxU) {
              maxU = utilityMatrix[i][j];
            }
          }
        }
        if (maxU === -Infinity) maxU = 100;

        const costMatrix = [];
        for (let i = 0; i < N; i++) {
          costMatrix[i] = [];
          for (let j = 0; j < M; j++) {
            if (utilityMatrix[i][j] <= -1e6) {
              costMatrix[i][j] = 1e8; // Penalty for infeasible
            } else {
              costMatrix[i][j] = Math.max(0, maxU - utilityMatrix[i][j]);
            }
          }
        }

        const assignments = solveOptimalFleetAssignment(costMatrix);

        // Execute optimal matched assignments
        for (const match of assignments) {
          if (costMatrix[match.robotIdx][match.taskIdx] >= 1e7) continue; // Infeasible

          const robot = eligibleRobots[match.robotIdx];
          const task = candidateTasks[match.taskIdx];
          const evalRes = evalCache[`${match.robotIdx}_${match.taskIdx}`];
          robot.lastFeasibilityCheck = evalRes;
          
          executeTaskAssignment(robot, task, evalRes);
        }
      }

      // 5. Any robot with no work routes to the NEAREST AVAILABLE CHARGER
      for (const robot of AMR_FLEET) {
        if (robot.state === 'IDLE') {
          if (!DECENTRALIZED_CBBA_MODE) {
             routeRobotToNearestCharger(robot, 'IDLE_OPPORTUNITY_CHARGE');
          }
          // If DECENTRALIZED_CBBA_MODE is true, Phase 8 local bidding handles this organically!
        }
      }

      // Feature 9C: Kiva Mode pod dispatch
      if (KIVA_MODE_ENABLED) dispatchKivaMissions();

      updateHudStats();
    }
    }


    function onRobotReachedDestination(robot) {
      if (robot.isStagingWait) {
        if (robot.pendingTargetTerminal) {
          const tgt = robot.pendingTargetTerminal;
          const key = getTerminalCellKey(tgt.x, tgt.y);
          const claimant = TERMINAL_OCCUPANCY_CLAIMS.get(key);
          const isOcc = AMR_FLEET.some(o => o.id !== robot.id && Math.hypot(o.x - tgt.x, o.y - tgt.y) < 0.85);
          const queue = TERMINAL_STAGING_QUEUES.get(key);
          const isMyTurn = !queue || queue.length === 0 || queue[0] === robot.id;
          const seg = getNarrowAisleSegment(tgt.x, tgt.y);
          const isAisleBusy = seg ? (getNarrowAisleOccupant(seg, robot.id) !== null) : false;

          if ((!claimant || claimant === robot.id) && !isOcc && isMyTurn && !isAisleBusy) {
            // Target terminal is free right now upon arrival! Advance immediately!
            if (queue && queue[0] === robot.id) queue.shift();
            claimTerminalDestination(robot.id, tgt.x, tgt.y);
            robot.isStagingWait = false;
            robot.pendingTargetTerminal = null;
            robot.isWaiting = false;
            robot._wasWaitingThisFrame = false;
            if (robot.statusBadge === 'STAGE') robot.statusBadge = null;
            const advancePath = findPath(robot.gridX, robot.gridY, tgt.x, tgt.y, null, robot.id);
            if (advancePath && advancePath.length > 0) {
              setRobotPath(robot, advancePath);
              return;
            }
          }
        }
        // Robot arrived at designated staging cell: wait patiently until terminal cell is freed
        robot.isWaiting = true;
        robot._wasWaitingThisFrame = true;
        robot.statusBadge = 'STAGE';
        robot.path = [];
        robot.pathIndex = 0;
        robot.currentSpeed = 0;
        return;
      }

      if (robot.isBackingUp) {
        robot.isBackingUp = false;
        robot.isWaiting = true;
        robot._wasWaitingThisFrame = true;
        robot.statusBadge = 'WAIT';
        robot.path = [];
        robot.pathIndex = 0;
        // Once backed up into previous box, wait until opposing bot has cleared
        return;
      }
      if (robot.isSideStepping) {
        robot.isSideStepping = false;
        robot.isWaiting = true;
        robot._wasWaitingThisFrame = true;
        robot.statusBadge = 'WAIT';
        robot.path = [];
        robot.pathIndex = 0;
        return;
      }

      if (robot.state === 'MOVING_TO_PICKUP') {
        const mission = robot.inboundMission;
        if (!mission) {
          robot.state = 'IDLE';
          dispatchFleet();
          return;
        }

        // Arrival at Inbound Dock: Trigger collection animation and yellow illumination
        robot.state = 'LOADING_INBOUND';
        robot.loadingTimer = 0.85;
        robot.isLoadedYellow = true; // Turn golden yellow!
        robot.statusBadge = 'LOAD';
        recordDockLoadingStarted(mission.dockId, mission.createdSimTimeSec);

        // Transfer parcel batch from dock queue onto robot's carrier tote, sorted by proximity
        robot.carriedParcels = sortParcelsByProximity(mission.parcels, robot.gridX, robot.gridY);
        inboundQueues[mission.dockId] = []; // Dock queue emptied -> Dock turns back to Blue P!
        updateHudStats();

        const idRange = mission.parcels.length > 1 ? `${mission.parcels[0].parcel_id}..${mission.parcels[mission.parcels.length - 1].parcel_id}` : mission.parcels[0].parcel_id;
        const dampingPct = Math.round(Math.max(65, (1.0 - (mission.totalWeight / 60.0)) * 100));
        logTerminal('PICKUP', 'tag-inbound', `📦 <strong>${robot.id}</strong> arrived at <strong>${mission.dockId}</strong>: Collected shipment of <strong>${mission.parcels.length} parcels</strong> (${idRange}, ${mission.totalWeight.toFixed(1)}kg, ${mission.importance.label}) into carrier tote | Load Speed Throttle: <span style="color:#f59e0b;font-weight:700;">${dampingPct}%</span> | Robot illuminated <span style="color:#facc15;font-weight:700;">GOLDEN YELLOW</span> | Dock returned to <span style="color:#38bdf8;font-weight:700;">BLUE</span>`);

      } else if (robot.state === 'CARRYING_TO_RACK') {
        if (!robot.carriedParcels || robot.carriedParcels.length === 0) {
          releaseAllTerminalClaimsForRobot(robot.id);
          robot.state = 'IDLE';
          robot.isLoadedYellow = false;
          robot.statusBadge = null;
          robot.payloadWeight = 0;
          robot.payloadDamping = 1.0;
          dispatchFleet();
          return;
        }

        // Deposit current parcel into its reserved rack slot
        const shelved = robot.carriedParcels.shift();
        shelved.rackSlot.rack.floors[shelved.rackSlot.floorIndex] = shelved;
        recordParcelShelved();
        if (robot.logStats) {
          robot.logStats.totalParcelsShelved++;
          robot.logStats.totalWeightTransportedKg += (parseFloat(shelved.weight) || 3.0);
        }
        recordRobotEvent(robot, 'PARCEL_SHELVED', `Shelved ${shelved.parcel_id} (${shelved.weight}) at Rack (${shelved.rackSlot.rack.x}, ${shelved.rackSlot.rack.y}) Tier ${shelved.rackSlot.floorNum}`, { parcelId: shelved.parcel_id, rackX: shelved.rackSlot.rack.x, rackY: shelved.rackSlot.rack.y, tier: shelved.rackSlot.floorNum, weight: shelved.weight });

        logTerminal('SHELVING', 'tag-complete', `📥 <strong>${robot.id}</strong> placed <strong>${shelved.parcel_id}</strong> (${shelved.name}, ${shelved.weight}) at Rack <strong>(${shelved.rackSlot.rack.x}, ${shelved.rackSlot.rack.y}) Tier ${shelved.rackSlot.floorNum}</strong> [${shelved.rackSlot.rack.categoryName}] (${robot.carriedParcels.length} left in tote)`);
        updateHudStats();

        if (robot.carriedParcels.length > 0) {
          // Route to next parcel in the shipment batch!
          const nextP = robot.carriedParcels[0];
          const access = getAccessPointForRack(nextP.rackSlot.rack.x, nextP.rackSlot.rack.y, robot.gridX, robot.gridY, robot.id);
          robot.targetDesc = `Shelving ${nextP.parcel_id} (${robot.carriedParcels.length} left) at Rack (${nextP.rackSlot.rack.x},${nextP.rackSlot.rack.y})`;
          robot.statusBadge = `SHELVE ${robot.carriedParcels.length}`;
          if (access) {
            setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
            if (robot.path.length === 0) {
              onRobotReachedDestination(robot);
            }
          }
        } else {
          // All items for the customer order are collected in the giant box!
          releaseAllTerminalClaimsForRobot(robot.id);
          const firstTargetBayX = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayX
            : mission.bayX;
          const firstTargetBayY = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayY
            : mission.bayY;
          const firstTargetBayId = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayId
            : mission.bayId;

          // Route to the buffer cell (x=167) instead of the exact dock (x=168)
          const stagingX = firstTargetBayX > 100 ? firstTargetBayX - 1 : firstTargetBayX + 1;
          
          claimTerminalDestination(robot.id, stagingX, firstTargetBayY);
          robot.state = 'DELIVERING_ORDER_TO_BAY';
          robot.targetDesc = `Delivering Giant Order Box (${robot.orderBox.totalItems} items) to Bay ${firstTargetBayId}`;
          robot.statusBadge = 'DELIVER';
          setRobotPath(robot, findPath(robot.gridX, robot.gridY, stagingX, firstTargetBayY));
          
          const dampingPct = Math.round(Math.max(65, (1.0 - (mission.totalWeight / 60.0)) * 100));
          if (typeof logTerminal === 'function') logTerminal('DISPATCH', 'tag-outbound', `📦 <strong>${robot.id}</strong> completed ${mission.isWaveBatch ? 'Wave Batch' : 'Giant Box'} consolidation (all <strong>${robot.orderBox.totalItems} items</strong>, ${mission.totalWeight.toFixed(1)}kg, ${mission.importance.label}, Load Speed Throttle: <span style="color:#f59e0b;font-weight:700;">${dampingPct}%</span>) for Order <strong>${mission.orderId}</strong>! Transporting to Departure Bay <strong>${firstTargetBayId}</strong>`);
          
          if (robot.path.length === 0) {
            onRobotReachedDestination(robot);
          }
        }

      } else if (robot.state === 'ORDER_PICKING') {
        const mission = robot.outboundMission;
        if (!mission || !robot.orderBox) {
          releaseAllTerminalClaimsForRobot(robot.id);
          robot.state = 'IDLE';
          dispatchFleet();
          return;
        }

        // Pick item from shelf and place into robot's Giant Box
        const pickItem = mission.itemsToPick.shift();

        // Defensive validation: a stale/duplicate/race-corrupted itemsToPick
        // entry should never crash the sim - skip it and try the next item
        // (or end the pick run cleanly) instead of throwing.
        if (!pickItem || !pickItem.parcel || !pickItem.rack) {
          if (typeof logTerminal === 'function') {
            logTerminal('ALERT', 'tag-yield', `⚠️ <strong>${robot.id}</strong> encountered an invalid pick-item entry for ${mission.orderId ? mission.orderId : 'unknown order'} (missing parcel/rack data). Skipping item.`);
          }
          if (mission.itemsToPick.length > 0) {
            // Re-run this same reached-destination check to try the next queued item
            onRobotReachedDestination(robot);
          } else {
            // No items left to pick: treat as pick-run complete, fall through to
            // whatever normally happens once orderBox has no more pending items
            robot.state = 'IDLE';
            releaseAllTerminalClaimsForRobot(robot.id);
            dispatchFleet();
          }
          return;
        }

        pickItem.rack.floors[pickItem.floorIndex] = null; // Clears the rack tier!
        robot.orderBox.items.push(pickItem.parcel);
        if (robot.logStats) {
          robot.logStats.totalItemsConsolidated++;
          robot.logStats.totalWeightTransportedKg += (parseFloat(pickItem.parcel.weight) || 3.0);
        }
        recordItemPicked();
        recordRobotEvent(robot, 'ITEM_PICKED', `Collected item ${pickItem.parcel.parcel_id} (${pickItem.parcel.name}) into Giant Box for ${mission.orderId} [${robot.orderBox.items.length}/${robot.orderBox.totalItems}]`, { parcelId: pickItem.parcel.parcel_id, rackX: pickItem.rack.x, rackY: pickItem.rack.y, floorIndex: pickItem.floorIndex });

        logTerminal('PICKUP', 'tag-outbound', `📦 <strong>${robot.id}</strong> collected item <strong>${pickItem.parcel.parcel_id}</strong> (${pickItem.parcel.name}, ${pickItem.parcel.weight}) into Giant Box for <strong>${mission.orderId}</strong> [${robot.orderBox.items.length}/${robot.orderBox.totalItems} items consolidated]`);
        updateHudStats();

        if (mission.itemsToPick.length > 0) {
          // Move to next pick item for this order
          const nextPick = mission.itemsToPick[0];
          const access = getAccessPointForRack(nextPick.rack.x, nextPick.rack.y, robot.gridX, robot.gridY, robot.id);
          robot.targetDesc = `Order Pick ${robot.orderBox.items.length + 1}/${robot.orderBox.totalItems} for ${mission.orderId} at Rack (${nextPick.rack.x},${nextPick.rack.y})`;
          robot.statusBadge = `PICK ${robot.orderBox.items.length}/${robot.orderBox.totalItems}`;
          if (access) {
            setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
            if (robot.path.length === 0) {
              onRobotReachedDestination(robot);
            }
          }
        } else {
          // All items for the customer order are collected in the giant box!
          releaseAllTerminalClaimsForRobot(robot.id);
          const firstTargetBayX = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayX
            : mission.bayX;
          const firstTargetBayY = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayY
            : mission.bayY;
          const firstTargetBayId = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
            ? mission.pendingDeliveries[0].bayId
            : mission.bayId;

          claimTerminalDestination(robot.id, firstTargetBayX, firstTargetBayY);
          robot.state = 'DELIVERING_ORDER_TO_BAY';
          robot.targetDesc = `Delivering Giant Order Box (${robot.orderBox.totalItems} items) to Bay ${firstTargetBayId}`;
          robot.statusBadge = 'DELIVER';
          setRobotPath(robot, findPath(robot.gridX, robot.gridY, firstTargetBayX, firstTargetBayY));
          const dampingPct = Math.round(Math.max(65, (1.0 - (mission.totalWeight / 60.0)) * 100));
          logTerminal('DISPATCH', 'tag-outbound', `📦 <strong>${robot.id}</strong> completed ${mission.isWaveBatch ? 'Wave Batch' : 'Giant Box'} consolidation (all <strong>${robot.orderBox.totalItems} items</strong>, ${mission.totalWeight.toFixed(1)}kg, ${mission.importance.label}, Load Speed Throttle: <span style="color:#f59e0b;font-weight:700;">${dampingPct}%</span>) for Order <strong>${mission.orderId}</strong>! Transporting to Departure Bay <strong>${firstTargetBayId}</strong>`);
          if (robot.path.length === 0) {
            onRobotReachedDestination(robot);
          }
        }

      } else if (robot.state === 'DELIVERING_ORDER_TO_BAY') {
        const mission = robot.outboundMission;
        if (!mission || !robot.orderBox) {
          robot.state = 'IDLE';
          return;
        }

        const targetBayId = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
          ? mission.pendingDeliveries[0].bayId
          : mission.bayId;

        const station = (typeof PACK_STATIONS !== 'undefined' && PACK_STATIONS) ? PACK_STATIONS[targetBayId] : null;
        const isStationBusy = station && (station.state === 'PACKING' || station.state === 'HANDOFF' || (station.queue && station.queue.length > 0 && station.queue[0] !== robot.id));

        if (isStationBusy) {
          // Packer occupied: enter WAITING_FOR_PACKER backpressure state in the staging cell
          robot.state = 'WAITING_FOR_PACKER';
          robot.isWaiting = true;
          robot._wasWaitingThisFrame = true;
          robot.statusBadge = 'STATION BUSY';
          robot.targetDesc = `Staging Queue: Waiting for Packer at Bay ${targetBayId}`;
          if (station && station.queue && !station.queue.includes(robot.id)) {
            station.queue.push(robot.id);
            station.backpressureIncidents = (station.backpressureIncidents || 0) + 1;
            if (typeof trafficMetrics !== 'undefined') trafficMetrics.packStationBackpressureCount = (trafficMetrics.packStationBackpressureCount || 0) + 1;
            if (typeof logTerminal === 'function') logTerminal('BACKPRESSURE', 'tag-yield', `⚠️ <strong>Backpressure at Bay ${targetBayId}</strong>: Packer occupied! <strong>${robot.id}</strong> queued in staging (Queue Depth: ${station.queue.length})`);
          }
          if (typeof updateHudStats === 'function') updateHudStats();
          return; 
        }

        // Pack Station is ready for handoff! Move into the actual dock cell.
        if (station && station.queue && station.queue.includes(robot.id)) {
          station.queue = station.queue.filter(id => id !== robot.id);
        }
        
        robot.state = 'HANDOFF_TO_PACKER';
        robot.handoffTimer = 1.2;
        robot.isWaiting = false;
        robot._wasWaitingThisFrame = false;
        robot.statusBadge = 'HANDOFF';
        robot.targetDesc = `Handoff to Packer at Bay ${targetBayId}`;
        
        // Drive into the final bay cell (x=168)
        const finalDockX = station ? station.x : 168;
        const finalDockY = station ? station.y : robot.gridY;
        robot.path = [{x: finalDockX, y: finalDockY}];
        robot.pathIndex = 0;

        if (station) {
          station.state = 'HANDOFF';
          station.assignedRobotId = robot.id;
        }
        if (typeof logTerminal === 'function') logTerminal('PACKER', 'tag-outbound', `🤝 <strong>${robot.id}</strong> initiating parcel handoff to Packer at Bay <strong>${targetBayId}</strong>`);
        if (typeof updateHudStats === 'function') updateHudStats();
        return;

      } else if (robot.state === 'RETURNING_HOME') {
        const port = CHARGING_PORTS.find(p => p.x === robot.gridX && p.y === robot.gridY) || 
                     CHARGING_PORTS.find(p => p.id === robot.targetChargerId) ||
                     CHARGING_PORTS[0];
        dockAtCharger(port.id, robot.id);
        robot.state = 'IDLE_CHARGING';
        robot.targetDesc = `Parked at Fast Charger ${port.id} (${robot.battery.toFixed(1)}%)`;
        robot.path = [];
        robot.pathIndex = 0;
        robot.statusBadge = null;
        robot.currentSpeed = 0;
        robot.payloadWeight = 0;
        robot.payloadDamping = 1.0;
        if (robot.logStats) {
          robot.logStats.chargeCyclesCount++;
        }
        onRobotJamEnd(robot, 'DOCKED_AT_CHARGER');
        recordRobotEvent(robot, 'DOCKED_AT_CHARGER', `Docked at Charger ${port.id} (${robot.battery.toFixed(1)}% SoC)`, { chargerId: port.id, battery: robot.battery });
        logTerminal('BMS', 'tag-inbound', `⚡ <strong>${robot.id}</strong> precision docked at Fast Charger <strong>${port.id}</strong> (${port.zone}). SoC: <strong>${robot.battery.toFixed(1)}%</strong>. 30kW CC Fast Charge engaged.`);
        updateHudStats();

      // ==========================================
      // FEATURE 9A: RETURNS / PUTBACK STATE MACHINE
      // ==========================================
      } else if (robot.state === 'MOVING_TO_RETURN_DOCK') {
        const mission = robot.returnMission;
        if (!mission) { robot.state = 'IDLE'; dispatchFleet(); return; }

        // Arrived at return dock — pick up returned items
        robot.state = 'LOADING_RETURN';
        robot.loadingTimer = 0.85;
        robot.isLoadedYellow = true;
        robot.statusBadge = 'LOAD↩';
        robot.carriedParcels = mission.parcels.slice();
        inboundQueues[mission.dockId] = []; // Clear dock queue visual
        logTerminal('RETURNS', 'tag-inbound', `♻️ <strong>${robot.id}</strong> collected <strong>${mission.parcels.length} returned item(s)</strong> from Dock <strong>${mission.dockId}</strong>. Starting putback stow.`);
        updateHudStats();

      } else if (robot.state === 'CARRYING_RETURN') {
        if (!robot.carriedParcels || robot.carriedParcels.length === 0) {
          // All returned items stowed!
          releaseAllTerminalClaimsForRobot(robot.id);
          const completedMission = robot.returnMission;
          if (completedMission) {
            const mIdx = returnMissions.findIndex(m => m.id === completedMission.id);
            if (mIdx !== -1) returnMissions.splice(mIdx, 1);
          }
          WAREHOUSE_RETURNS_METRICS.totalReturnsParcelsStowed += (completedMission ? completedMission.parcels.length : 0);
          robot.returnMission = null;
          robot.isLoadedYellow = false;
          robot.statusBadge = null;
          robot.payloadWeight = 0;
          robot.payloadDamping = 1.0;
          logTerminal('COMPLETE', 'tag-complete', `✅ <strong>${robot.id}</strong> completed returns putback — all items restocked into 3D racks.`);
          updateHudStats();
          robot.state = 'IDLE';
          dispatchFleet();
          return;
        }
        // Stow next returned parcel into its pre-reserved rack slot
        const shelved = robot.carriedParcels.shift();
        if (shelved.rackSlot) {
          shelved.rackSlot.rack.floors[shelved.rackSlot.floorIndex] = shelved;
          WAREHOUSE_RETURNS_METRICS.totalReturnsParcelsStowed++;
        }
        logTerminal('RETURNS', 'tag-complete', `♻️ <strong>${robot.id}</strong> putback <strong>${shelved.parcel_id}</strong> (${shelved.name}) into rack (${shelved.rackSlot ? shelved.rackSlot.rack.x + ',' + shelved.rackSlot.rack.y : '?'}). ${robot.carriedParcels.length} left.`);
        updateHudStats();

        if (robot.carriedParcels.length > 0) {
          const nextP = robot.carriedParcels[0];
          const access = getAccessPointForRack(nextP.rackSlot.rack.x, nextP.rackSlot.rack.y, robot.gridX, robot.gridY, robot.id);
          robot.targetDesc = `Returns Stow ${nextP.parcel_id} at Rack (${nextP.rackSlot.rack.x},${nextP.rackSlot.rack.y})`;
          robot.statusBadge = `STOW↩ ${robot.carriedParcels.length}`;
          if (access) {
            setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
            if (robot.path.length === 0) onRobotReachedDestination(robot);
          }
        } else {
          // All done — transition to completion (handled above on next call)
          onRobotReachedDestination(robot);
        }

      // ==========================================
      // FEATURE 9C: KIVA / POD-TO-PICKER STATE MACHINE
      // ==========================================
      } else if (robot.state === 'DRIVING_TO_POD') {
        const pod = robot.kivaAssignedPod;
        if (!pod) { robot.state = 'IDLE'; return; }
        // Arrived at pod — lift it (brief timer)
        robot.state = 'LIFTING_POD';
        robot.loadingTimer = 0.5;
        robot.statusBadge = 'KIVA LIFT';
        robot.targetDesc = `Lifting Pod ${pod.id}`;
        logTerminal('KIVA', 'tag-inbound', `🏭 <strong>${robot.id}</strong> lifting Pod <strong>${pod.id}</strong>`);

      } else if (robot.state === 'DELIVERING_POD_TO_PICKER') {
        const pod = robot.kivaAssignedPod;
        const station = robot.kivaTargetStation;
        if (!pod || !station) { robot.state = 'IDLE'; return; }
        // Arrived at picker station — human scans items (wait timer)
        robot.state = 'WAITING_AT_PICKER';
        robot.kivaPickTimer = 3.0 + Math.random() * 2.0; // 3-5s scan time
        robot.isWaiting = true;
        robot.statusBadge = 'KIVA SCAN';
        robot.targetDesc = `Waiting at Picker ${station.bayId} for human scan`;
        pod.state = 'AT_PICKER';
        if (station) station.state = 'SCANNING';
        WAREHOUSE_RETURNS_METRICS.kivaPodsDelivered++;
        logTerminal('KIVA', 'tag-inbound', `🏭 Pod <strong>${pod.id}</strong> at Picker <strong>${station.bayId}</strong> — Human scanning items`);
        updateHudStats();

      } else if (robot.state === 'RETURNING_POD_TO_HOME') {
        const pod = robot.kivaAssignedPod;
        const station = robot.kivaTargetStation;
        if (!pod) { robot.state = 'IDLE'; return; }
        // Pod returned to home position
        pod.x = pod.homeX; pod.y = pod.homeY;
        pod.state = 'IDLE';
        pod.carriedByBotId = null;
        pod.pickerStationId = null;
        if (station) {
          station.state = 'IDLE';
          station.assignedPodId = null;
          station.totalPicksCompleted++;
          WAREHOUSE_RETURNS_METRICS.kivaPicksCompleted++;
        }
        robot.kivaAssignedPod = null;
        robot.kivaTargetStation = null;
        robot.isLoadedYellow = false;
        robot.statusBadge = null;
        robot.payloadWeight = 0;
        robot.payloadDamping = 1.0;
        robot.state = 'IDLE';
        logTerminal('KIVA', 'tag-complete', `✅ <strong>${robot.id}</strong> returned Pod <strong>${pod.id}</strong> to home. Station <strong>${station ? station.bayId : '?'}</strong> pick complete.`);
        updateHudStats();
        dispatchFleet();
      }
    }


