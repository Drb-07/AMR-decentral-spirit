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

          // Inherit the highest SLA importance across the batched orders
          if (computeTaskPriorityScore(ordB) > computeTaskPriorityScore(ordA)) {
            ordA.importance = ordB.importance;
          }

          ordA.totalWeight = Number((ordA.totalWeight + ordB.totalWeight).toFixed(1));
          ordA.totalItems += ordB.totalItems;
          ordA.itemsToPick.push(...ordB.itemsToPick);

          ordB.status = 'MERGED';
          ordB.mergedIntoOrderId = ordA.orderId;
          mergedCount++;
        }

        if (mergedCount > 0) {
          ordA.itemsToPick = sortItemsByProximity(ordA.itemsToPick, ordA.bayX, ordA.bayY);
          logTerminal('DISPATCH', 'tag-outbound', `📦 <strong>Wave Batch Created:</strong> Consolidated ${mergedCount + 1} orders into master batch <strong>${ordA.orderId}</strong> (${ordA.totalItems} items, ${ordA.totalWeight.toFixed(1)}kg) for optimal picking density.`);
        }
      }
    }

    // Helper: Sort picking sequence using 2-opt TSP heuristic
    function sortItemsByProximity(items, startX, startY) {
      if (!items || items.length <= 1) return items;
      const sorted = [];
      const remaining = [...items];
      let curX = startX;
      let curY = startY;

      while (remaining.length > 0) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const r = remaining[i].rack;
          if (!r) continue;
          const dist = Math.abs(r.x - curX) + Math.abs(r.y - curY);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        if (bestIdx !== -1) {
          const nextPick = remaining.splice(bestIdx, 1)[0];
          sorted.push(nextPick);
          curX = nextPick.rack.x;
          curY = nextPick.rack.y;
        } else {
          sorted.push(remaining.shift());
        }
      }

      // 2-Opt Optimization Step: Uncross path loops if 3 or more picks
      if (sorted.length >= 3) {
        let improved = true;
        let iter = 0;
        while (improved && iter < 6) {
          improved = false;
          iter++;
          for (let i = 0; i < sorted.length - 1; i++) {
            for (let k = i + 1; k < sorted.length; k++) {
              const pA = sorted[i].rack, pB = sorted[i+1].rack;
              const pC = sorted[k].rack, pD = (k + 1 < sorted.length) ? sorted[k+1].rack : null;
              if (!pA || !pB || !pC) continue;

              const dCurrent = (Math.abs(pA.x - pB.x) + Math.abs(pA.y - pB.y)) + (pD ? (Math.abs(pC.x - pD.x) + Math.abs(pC.y - pD.y)) : 0);
              const dReversed = (Math.abs(pA.x - pC.x) + Math.abs(pA.y - pC.y)) + (pD ? (Math.abs(pB.x - pD.x) + Math.abs(pB.y - pD.y)) : 0);

              if (dReversed < dCurrent - 0.5) {
                const segment = sorted.slice(i + 1, k + 1).reverse();
                sorted.splice(i + 1, segment.length, ...segment);
                improved = true;
              }
            }
          }
        }
      }

      return sorted;
    }

    // Dynamic SLA Multiplier & Urgency Calculation
    function computeTaskPriorityScore(mission) {
      let score = 50;
      if (mission.importance) {
        if (mission.importance.code === 'VIP_EXPRESS') score += 50;
        else if (mission.importance.code === 'STANDARD_PRIORITY') score += 25;
        else if (mission.importance.code === 'ECONOMY_SAVER') score += 5;
      }
      if (mission.createdSimTimeSec !== undefined) {
        const elapsed = totalSimSeconds - mission.createdSimTimeSec;
        score += Math.min(40, elapsed * 0.8);
      }
      return score;
    }

    // Safe fallback in case releaseTerminalClaim is called anywhere
    function releaseTerminalClaim(robotId, x, y) {
      if (typeof releaseAllTerminalClaimsForRobot === 'function') {
        releaseAllTerminalClaimsForRobot(robotId);
      }
    }

    // Helper function executed by either CBBA Consensus or Hungarian Allocator
    function executeTaskAssignment(robot, task, evalResult, bestBid) {
      if (!task || !task.ref) {
        console.warn(`[Assignment] Aborted: Missing 'ref' for task ID: ${task ? task.id : 'unknown'}`);
        return;
      }

      const mission = task.ref;
      const bidReason = (bestBid && bestBid.reason) ? ` (${bestBid.reason})` : '';
      const evalRes = evalResult || robot.lastFeasibilityCheck || null;

      if (task.kind === 'INBOUND') {
        if (typeof undockFromCharger === 'function') undockFromCharger(robot.id);
        mission.status = 'ASSIGNED';
        mission.assignedRobotId = robot.id;
        robot.state = 'MOVING_TO_PICKUP';
        robot.inboundMission = mission;
        robot.missionStartTime = Date.now();
        robot.targetDesc = `Dock ${mission.dockId} (Inbound Load: ${mission.parcels.length} pkgs)`;
        claimTerminalDestination(robot.id, mission.dockX, mission.dockY);
        setRobotPath(robot, findPath(robot.gridX, robot.gridY, mission.dockX, mission.dockY));

        const strategyTag = DECENTRALIZED_CBBA_MODE ? 'CBBA Consensus' : 'Hungarian Opt';
        logTerminal('DISPATCH', 'tag-inbound', `⚡ <strong>${robot.id}</strong> Assigned (${strategyTag}, SLA: <span style="color:${mission.importance.color};font-weight:700;">${mission.importance.shortLabel || mission.importance.code}</span>): Dock <strong>${mission.dockId}</strong> (${mission.parcels.length} pkgs, +${evalRes ? evalRes.margin : '0'}% margin, SoC: <strong>${robot.battery.toFixed(1)}%</strong>). Undocked from charger.${bidReason}`);

        if (robot.path.length === 0) onRobotReachedDestination(robot);

      } else if (task.kind === 'OUTBOUND') {
        if (!mission || mission.status === 'MERGED' || !mission.itemsToPick || mission.itemsToPick.length === 0) {
          if (typeof logTerminal === 'function') {
            logTerminal('ALERT', 'tag-yield', `⚠️ <strong>${robot.id}</strong> claimed stale/consumed task <strong>${task.id || (mission && mission.orderId)}</strong> (likely merged into a wave batch). Dropping claim, returning to IDLE.`);
          }
          robot.state = 'IDLE';
          return;
        }

        if (typeof undockFromCharger === 'function') undockFromCharger(robot.id);
        mission.status = 'ASSIGNED';
        mission.assignedRobotId = robot.id;
        mission.itemsToPick = sortItemsByProximity(mission.itemsToPick, robot.gridX, robot.gridY);
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

        const strategyTag = DECENTRALIZED_CBBA_MODE ? 'CBBA Consensus' : 'Hungarian Opt';
        logTerminal('DISPATCH', 'tag-outbound', `⚡ <strong>${robot.id}</strong> Assigned (${strategyTag}, SLA: <span style="color:${mission.importance.color};font-weight:700;">${mission.importance.shortLabel || mission.importance.code}</span>): ${mission.isWaveBatch ? 'Wave Batch' : 'Order'} <strong>${mission.orderId}</strong> (${mission.totalItems} items, ${mission.totalWeight.toFixed(1)}kg, +${evalRes ? evalRes.margin : '0'}% margin, SoC: <strong>${robot.battery.toFixed(1)}%</strong>). Undocked from charger.${bidReason}`);

        if (access) {
          setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
          if (robot.path.length === 0) onRobotReachedDestination(robot);
        }

      } else if (task.kind === 'RETURN') {
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
        logTerminal('DISPATCH', 'tag-inbound', `♻️ <strong>${robot.id}</strong> dispatched for Returns Putback: Dock <strong>${mission.dockId}</strong> (${mission.parcels.length} item(s), ${mission.totalWeight.toFixed(1)}kg)${bidReason}`);
        if (robot.path.length === 0) onRobotReachedDestination(robot);
      }
    }

    function dispatchFleet() {
      planOutboundWaveBatches();

      const candidateTasks = [];

      for (const mission of inboundMissions) {
        if (mission.status === 'PENDING') {
          const dockBusy = inboundMissions.some(m => m.status === 'ASSIGNED' && m.dockId === mission.dockId) ||
                           AMR_FLEET.some(b => (b.inboundMission && b.inboundMission.dockId === mission.dockId) ||
                                               (Math.hypot(b.x - mission.dockX, b.y - mission.dockY) < 1.5));
          if (!dockBusy) {
            candidateTasks.push({
              kind: 'INBOUND',
              type: 'INBOUND',
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

      for (const mission of outboundMissions) {
        if (mission.status === 'PENDING' && mission.itemsToPick && mission.itemsToPick.length > 0) {
          const firstPick = mission.itemsToPick[0];
          if (firstPick && firstPick.rack) {
            candidateTasks.push({
              kind: 'OUTBOUND',
              type: 'OUTBOUND',
              ref: mission,
              orderId: mission.orderId,
              bayId: mission.bayId,
              bayX: mission.bayX,
              bayY: mission.bayY,
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

      for (const mission of returnMissions) {
        if (mission.status === 'PENDING') {
          const dockBusy = returnMissions.some(m => m.status === 'ASSIGNED' && m.dockId === mission.dockId) ||
                           AMR_FLEET.some(b => b.returnMission && b.returnMission.dockId === mission.dockId);
          if (!dockBusy) {
            candidateTasks.push({
              kind: 'RETURN',
              type: 'RETURN',
              ref: mission,
              dockId: mission.dockId,
              targetX: mission.dockX,
              targetY: mission.dockY,
              totalWeight: mission.totalWeight,
              parcels: mission.parcels,
              importance: mission.importance,
              createdAt: mission.createdAt,
              slaPriority: computeTaskPriorityScore(mission) - 5,
              desc: `Returns Putback at Dock ${mission.dockId}`
            });
          }
        }
      }

      candidateTasks.sort((a, b) => b.slaPriority - a.slaPriority);

      const eligibleRobots = [];
      for (const robot of AMR_FLEET) {
        if (robot.isFaulted || robot.isUnderMaintenance || robot.state === 'HARDWARE_FAULT' || robot.state === 'MARKED_FOR_MAINTENANCE') continue;
        const isEligibleState = (robot.state === 'IDLE' || robot.state === 'IDLE_CHARGING' || robot.state === 'RETURNING_HOME');
        if (!isEligibleState) continue;

        const threshold = robot.proactiveChargeThreshold || 32.0;
        if (robot.battery < threshold) {
          if (robot.state === 'IDLE') {
            routeRobotToNearestCharger(robot, 'PROACTIVE_STAGGERED_CHARGE');
          }
          continue;
        }

        if (robot.state === 'IDLE_CHARGING' && robot.battery < 75.0) continue;

        eligibleRobots.push(robot);
      }

      if (DECENTRALIZED_CBBA_MODE) {
         for (const task of candidateTasks) {
            task.id = task.kind === 'INBOUND' ? task.ref.id : (task.kind === 'OUTBOUND' ? task.ref.orderId : task.ref.id);
            zenohMesh.announceTask(task);
         }
         
         if (typeof CHARGING_PORTS !== 'undefined') {
           for (const port of CHARGING_PORTS) {
             if (!port.isFaulted && !port.occupiedBy && !port.reservedBy) {
               zenohMesh.announceChargeBay({ id: port.id, x: port.x, y: port.y, zone: port.zone });
             }
           }
         }
      } else {
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
                 utilityMatrix[i][j] = -10000;
                 continue;
               }

               const dist = Math.abs(robot.gridX - task.targetX) + Math.abs(robot.gridY - task.targetY);
               const distScore = Math.max(0, 100 - dist);
               const slaScore = task.slaPriority * 1.5;
               const battScore = robot.battery * 0.4;
               utilityMatrix[i][j] = distScore + slaScore + battScore;
             }
           }

           const maxDim = Math.max(N, M);
           const costMatrix = [];
           for (let i = 0; i < maxDim; i++) {
             costMatrix[i] = [];
             for (let j = 0; j < maxDim; j++) {
               if (i < N && j < M) {
                 costMatrix[i][j] = 10000 - utilityMatrix[i][j];
               } else {
                 costMatrix[i][j] = 10000;
               }
             }
           }

           const assignments = solveAssignmentHungarian(costMatrix);

           for (let i = 0; i < N; i++) {
             const j = assignments[i];
             if (j !== undefined && j < M) {
               const utility = utilityMatrix[i][j];
               if (utility > -5000) {
                 const robot = eligibleRobots[i];
                 const task = candidateTasks[j];
                 const evalResult = evalCache[`${i}_${j}`];
                 executeTaskAssignment(robot, task, evalResult, null);
               }
             }
           }
         }
      }

      if (!DECENTRALIZED_CBBA_MODE) {
        for (const robot of AMR_FLEET) {
          if (robot.state === 'IDLE' && robot.battery < 80.0) {
            routeRobotToNearestCharger(robot, 'OPPORTUNITY_CHARGE');
          }
        }
      }
    }

    // Complete Kuhn-Munkres (Hungarian Algorithm) for Optimal Fleet Assignment
    function solveAssignmentHungarian(matrix) {
      const n = matrix.length;
      const u = new Array(n + 1).fill(0);
      const v = new Array(n + 1).fill(0);
      const p = new Array(n + 1).fill(0);
      const way = new Array(n + 1).fill(0);

      for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(n + 1).fill(Infinity);
        const used = new Array(n + 1).fill(false);

        do {
          used[j0] = true;
          const i0 = p[j0];
          let delta = Infinity;
          let j1 = 0;

          for (let j = 1; j <= n; j++) {
            if (!used[j]) {
              const cur = matrix[i0 - 1][j - 1] - u[i0] - v[j];
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

          for (let j = 0; j <= n; j++) {
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

      const result = new Array(n);
      for (let j = 1; j <= n; j++) {
        if (p[j] !== 0) {
          result[p[j] - 1] = j - 1;
        }
      }
      return result;
    }
