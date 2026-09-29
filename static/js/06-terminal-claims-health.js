    // =========================================================================
    // SINGLE-OCCUPANCY TERMINAL CELL RESERVATIONS & STAGING QUEUES
    // Prevents multiple robots from converging on the exact same terminal coordinate
    // (charging pad, rack access point, dock bay).
    // =========================================================================
    const TERMINAL_OCCUPANCY_CLAIMS = new Map(); // key "x,y" -> robotId
    const TERMINAL_STAGING_QUEUES = new Map();   // key "x,y" -> [robotId, ...]

    function getTerminalCellKey(x, y) {
      return `${Math.round(x)},${Math.round(y)}`;
    }

    function isTerminalCellOccupiedOrClaimed(x, y, requestingRobotId = null) {
      const key = getTerminalCellKey(x, y);
      const claimant = TERMINAL_OCCUPANCY_CLAIMS.get(key);
      if (claimant && claimant !== requestingRobotId) return true;
      for (const b of AMR_FLEET) {
        if (b.id !== requestingRobotId && b.gridX === Math.round(x) && b.gridY === Math.round(y)) {
          return true;
        }
      }
      return false;
    }

    function claimTerminalDestination(robotId, destX, destY) {
      releaseAllTerminalClaimsForRobot(robotId);
      const key = getTerminalCellKey(destX, destY);
      TERMINAL_OCCUPANCY_CLAIMS.set(key, robotId);
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (r) {
        r.claimedTerminalCell = { x: destX, y: destY };
      }
    }

    function releaseAllTerminalClaimsForRobot(robotId) {
      for (const [key, holderId] of TERMINAL_OCCUPANCY_CLAIMS.entries()) {
        if (holderId === robotId) {
          TERMINAL_OCCUPANCY_CLAIMS.delete(key);
          const queue = TERMINAL_STAGING_QUEUES.get(key);
          if (queue && queue.length > 0) {
            const nextBotId = queue.shift();
            const nextBot = AMR_FLEET.find(b => b.id === nextBotId);
            if (nextBot && nextBot.pendingTargetTerminal) {
              const tgt = nextBot.pendingTargetTerminal;
              TERMINAL_OCCUPANCY_CLAIMS.set(key, nextBotId);
              nextBot.claimedTerminalCell = { x: tgt.x, y: tgt.y };
              nextBot.pendingTargetTerminal = null;
              nextBot.isStagingWait = false;
              nextBot.isWaiting = false;
              nextBot._wasWaitingThisFrame = false;
              const p = findPath(nextBot.gridX, nextBot.gridY, tgt.x, tgt.y);
              if (p && p.length > 0) {
                setRobotPath(nextBot, p);
              } else {
                onRobotReachedDestination(nextBot);
              }
            }
          }
        }
      }
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (r) {
        r.claimedTerminalCell = null;
      }
    }

    function registerRobotAtStagingQueue(robot, targetX, targetY) {
      const key = getTerminalCellKey(targetX, targetY);
      let queue = TERMINAL_STAGING_QUEUES.get(key);
      if (!queue) {
        queue = [];
        TERMINAL_STAGING_QUEUES.set(key, queue);
      }
      if (!queue.includes(robot.id)) {
        queue.push(robot.id);
      }
      robot.pendingTargetTerminal = { x: targetX, y: targetY };
      robot.isStagingWait = true;
    }

    // Dynamic Charger Pool Search: Finds nearest free or claimable operational charger
    function getNearestAvailableCharger(fromX, fromY, robotId, allowYielding = false) {
      let bestPort = null;
      let minDistance = Infinity;

      // 1. Unreserved & unoccupied operational ports with no active terminal claim
      for (const port of CHARGING_PORTS) {
        if (port.isFaulted) continue; // Exclude faulted chargers!
        const isFree = (port.occupiedBy === null || port.occupiedBy === robotId) &&
                       (port.reservedBy === null || port.reservedBy === robotId) &&
                       !isTerminalCellOccupiedOrClaimed(port.x, port.y, robotId);
        if (isFree) {
          const d = Math.abs(port.x - fromX) + Math.abs(port.y - fromY);
          if (d < minDistance) {
            minDistance = d;
            bestPort = port;
          }
        }
      }

      // 2. If all ports busy and allowYielding enabled, find port whose occupant is charged enough to yield
      if (!bestPort && allowYielding) {
        let bestOccupantSoC = 0;
        const candidateRobot = AMR_FLEET.find(b => b.id === robotId);
        const reqSoc = (candidateRobot && candidateRobot.battery < 15.0) ? 75.0 : 80.0;
        for (const port of CHARGING_PORTS) {
          if (port.isFaulted) continue;
          if (port.occupiedBy && port.occupiedBy !== robotId) {
            const occupant = AMR_FLEET.find(b => b.id === port.occupiedBy);
            if (occupant && occupant.battery >= reqSoc && occupant.battery > bestOccupantSoC) {
              bestOccupantSoC = occupant.battery;
              bestPort = port;
              minDistance = Math.abs(port.x - fromX) + Math.abs(port.y - fromY);
            }
          }
        }
      }

      // 3. Fallback to closest operational port with approach staging queue cell
      let isStaging = false;
      let stagingX = fromX;
      let stagingY = fromY;
      if (!bestPort) {
        for (const port of CHARGING_PORTS) {
          if (port.isFaulted) continue;
          const d = Math.abs(port.x - fromX) + Math.abs(port.y - fromY);
          if (d < minDistance) {
            minDistance = d;
            bestPort = port;
          }
        }
        // If ALL ports are faulted, fallback to first port so robot doesn't crash
        if (!bestPort && CHARGING_PORTS.length > 0) {
          bestPort = CHARGING_PORTS[0];
          minDistance = Math.abs(bestPort.x - fromX) + Math.abs(bestPort.y - fromY);
        }
        isStaging = true;
        if (bestPort) {
          stagingX = bestPort.x;
          stagingY = bestPort.y === 1 ? 2 : 47;
        }
      }

      const energyReq = calculateEnergyCost(minDistance, 0, 0) + DOCKING_ENERGY_BUFFER;
      return {
        charger: bestPort,
        distance: minDistance,
        isStaging,
        stagingX,
        stagingY,
        energyNeeded: Math.max(0.4, Math.round(energyReq * 10) / 10)
      };
    }

    function reserveCharger(portId, robotId) {
      for (const p of CHARGING_PORTS) {
        if (p.reservedBy === robotId && p.id !== portId) {
          p.reservedBy = null;
        }
      }
      const port = CHARGING_PORTS.find(p => p.id === portId);
      if (port && !port.isFaulted) {
        port.reservedBy = robotId;
      }
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (r) {
        r.targetChargerId = portId;
      }
    }

    function dockAtCharger(portId, robotId) {
      const port = CHARGING_PORTS.find(p => p.id === portId);
      if (port && !port.isFaulted) {
        if (port.occupiedBy && port.occupiedBy !== robotId) {
          const prev = AMR_FLEET.find(b => b.id === port.occupiedBy);
          if (prev) {
            prev.currentChargerId = null;
            releaseAllTerminalClaimsForRobot(prev.id);
          }
        }
        port.occupiedBy = robotId;
        if (port.reservedBy === robotId) port.reservedBy = null;
        claimTerminalDestination(robotId, port.x, port.y);
      }
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (r) {
        r.currentChargerId = portId;
        r.targetChargerId = null;
        r.assignedBayId = portId;
        r.homeBayId = portId;
        // Remove from waiting queue if was queued
        const qIdx = CHARGER_WAITING_QUEUE.findIndex(q => q.robotId === robotId);
        if (qIdx !== -1) {
          const entry = CHARGER_WAITING_QUEUE.splice(qIdx, 1)[0];
          const waitSec = Math.max(0, (totalSimSeconds || 0) - (entry.joinTime || 0));
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds += waitSec;
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued++;
          FLEET_FAILURE_MAINTENANCE_METRICS.averageChargerQueueWaitSeconds = Number((FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds / FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued).toFixed(1));
          if (waitSec > FLEET_FAILURE_MAINTENANCE_METRICS.maxChargerQueueWaitSeconds) {
            FLEET_FAILURE_MAINTENANCE_METRICS.maxChargerQueueWaitSeconds = Number(waitSec.toFixed(1));
          }
        }
      }
    }

    function undockFromCharger(robotOrId) {
      const robotId = typeof robotOrId === 'string' ? robotOrId : (robotOrId ? robotOrId.id : null);
      if (!robotId) return;
      for (const p of CHARGING_PORTS) {
        if (p.occupiedBy === robotId) {
          p.occupiedBy = null;
          TERMINAL_OCCUPANCY_CLAIMS.delete(getTerminalCellKey(p.x, p.y));
        }
        if (p.reservedBy === robotId) {
          p.reservedBy = null;
          TERMINAL_OCCUPANCY_CLAIMS.delete(getTerminalCellKey(p.x, p.y));
        }
      }
      releaseAllTerminalClaimsForRobot(robotId);
      const r = AMR_FLEET.find(b => b.id === robotId) || (typeof robotOrId === 'object' ? robotOrId : null);
      if (r) {
        r.currentChargerId = null;
        r.targetChargerId = null;
        r.isCharging = false;
        r.chargingPort = null;
        r.powerWatts = 0;
        r.chargeRateKw = 0;
      }

      // Check if there are low-battery robots waiting in queue
      if (CHARGER_WAITING_QUEUE.length > 0) {
        const nextEntry = CHARGER_WAITING_QUEUE.shift();
        const nextBot = AMR_FLEET.find(b => b.id === nextEntry.robotId);
        if (nextBot && nextBot.state !== 'IDLE_CHARGING' && !nextBot.isFaulted) {
          const waitSec = Math.max(0, (totalSimSeconds || 0) - (nextEntry.joinTime || 0));
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds += waitSec;
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued++;
          FLEET_FAILURE_MAINTENANCE_METRICS.averageChargerQueueWaitSeconds = Number((FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds / FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued).toFixed(1));
          if (waitSec > FLEET_FAILURE_MAINTENANCE_METRICS.maxChargerQueueWaitSeconds) {
            FLEET_FAILURE_MAINTENANCE_METRICS.maxChargerQueueWaitSeconds = Number(waitSec.toFixed(1));
          }
          logTerminal('BMS', 'tag-inbound', `⚡ <strong>${nextBot.id}</strong> dequeued from charger waiting line (Waited ${waitSec.toFixed(1)}s). Routing to open charger.`);
          routeRobotToNearestCharger(nextBot, 'DEQUEUED_TO_FREE_CHARGER');
        }
      }
    }

    function routeRobotToNearestCharger(robot, reason = 'OPPORTUNITY_CHARGE', context = null) {
      if (robot.state === 'IDLE_CHARGING') return;
      if (robot.orderBox || (robot.carriedParcels && robot.carriedParcels.length > 0)) {
        return; // Don't abandon active cargo in aisle
      }

      const allowYield = robot.battery < 25.0;
      const nearest = getNearestAvailableCharger(robot.gridX, robot.gridY, robot.id, allowYield);
      const port = nearest.charger;
      if (!port) return;

      // If claiming from a yielding occupant
      if (port.occupiedBy && port.occupiedBy !== robot.id) {
        const occupant = AMR_FLEET.find(b => b.id === port.occupiedBy);
        const yieldThreshold = robot.battery < 15.0 ? 75.0 : 80.0;
        if (occupant && occupant.battery >= yieldThreshold) {
          logTerminal('BMS', 'tag-yield', `⚡ <strong>${occupant.id}</strong> (${occupant.battery.toFixed(1)}% SoC) yielding Charger <strong>${port.id}</strong> to low-energy <strong>${robot.id}</strong> (${robot.battery.toFixed(1)}% SoC).`);
          undockFromCharger(occupant.id);
          occupant.state = 'IDLE';
          occupant.targetDesc = 'Yielded Charger to Low SoC Peer (Staging)';
          const stagingY = port.y === 1 ? 2 : 47;
          setRobotPath(occupant, findPath(occupant.gridX, occupant.gridY, port.x, stagingY));
        }
      }

      if (nearest.isStaging) {
        // Priority Charger Contention Queue under heavy load
        let qEntry = CHARGER_WAITING_QUEUE.find(q => q.robotId === robot.id);
        const urgency = robot.battery < 15.0 ? 'CRITICAL' : (robot.battery < 25.0 ? 'URGENT' : 'OPPORTUNITY');
        if (!qEntry) {
          qEntry = {
            robotId: robot.id,
            battery: Number(robot.battery.toFixed(1)),
            urgency,
            targetPortId: port.id,
            joinTime: totalSimSeconds || 0
          };
          CHARGER_WAITING_QUEUE.push(qEntry);
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerContentionEvents++;
        } else {
          qEntry.battery = Number(robot.battery.toFixed(1));
          qEntry.urgency = urgency;
        }

        // Sort queue by priority: CRITICAL > URGENT > OPPORTUNITY, then battery ascending
        CHARGER_WAITING_QUEUE.sort((a, b) => {
          const tierWeight = { CRITICAL: 0, URGENT: 1, OPPORTUNITY: 2 };
          if (tierWeight[a.urgency] !== tierWeight[b.urgency]) {
            return tierWeight[a.urgency] - tierWeight[b.urgency];
          }
          return a.battery - b.battery;
        });

        const qIdx = CHARGER_WAITING_QUEUE.findIndex(q => q.robotId === robot.id);
        let sX = nearest.stagingX;
        let sY = nearest.stagingY;
        if (sY <= 24) {
          sY = 2 + (qIdx % 2);
          sX = 35 + ((qIdx * 2) % 12);
        } else {
          sY = 47 - (qIdx % 2);
          sX = 35 + ((qIdx * 2) % 12);
        }
        if (typeof isWalkable === 'function' && !isWalkable(sX, sY)) {
          sX = nearest.stagingX;
          sY = nearest.stagingY;
        }

        robot.state = 'RETURNING_HOME';
        robot.statusBadge = `CHG QUEUE #${qIdx + 1}`;
        robot.targetDesc = `En route to Charger ${port.id} Priority Queue (#${qIdx + 1}) at (${sX}, ${sY})`;
        setRobotPath(robot, findPath(robot.gridX, robot.gridY, sX, sY));
      } else {
        reserveCharger(port.id, robot.id);
        claimTerminalDestination(robot.id, port.x, port.y);
        robot.state = 'RETURNING_HOME';
        robot.statusBadge = robot.battery <= 25.0 ? 'LOW BATT' : 'TO CHG';
        robot.targetDesc = `Navigating to Nearest Charger ${port.id} (${nearest.distance}m | ~${nearest.energyNeeded}% SoC)`;
        setRobotPath(robot, findPath(robot.gridX, robot.gridY, port.x, port.y));
      }

      if (robot.path.length === 0 && robot.gridX === port.x && robot.gridY === port.y) {
        dockAtCharger(port.id, robot.id);
        robot.state = 'IDLE_CHARGING';
        robot.statusBadge = null;
        robot.targetDesc = `Parked at Fast Charger ${port.id} (${robot.battery.toFixed(1)}%)`;
        logTerminal('BMS', 'tag-inbound', `⚡ <strong>${robot.id}</strong> engaged charging contacts at <strong>${port.id}</strong> (${port.zone}). SoC: ${robot.battery.toFixed(1)}%.`);
      } else {
        if (reason === 'FEASIBILITY_REJECTION') {
          logTerminal('BMS', 'tag-yield', `🚨 <strong>${robot.id}</strong> rejected ${context ? context.missionDesc : 'Task'}: BMS Energy Deficit (Req: <strong>${context.eRequired}% SoC</strong>, Current: <strong>${robot.battery.toFixed(1)}%</strong>). Diverting to nearest charger <strong>${port.id}</strong>.`);
        } else if (reason === 'DYNAMIC_SAFETY_ABORT') {
          logTerminal('BMS', 'tag-yield', `⚠️ <strong>${robot.id}</strong> reached critical energy boundary (${robot.battery.toFixed(1)}% SoC). Diverting directly to nearest charger <strong>${port.id}</strong>.`);
        } else if (reason === 'OPERATOR_RECALL') {
          logTerminal('BMS', 'tag-yield', `⚡ <strong>${robot.id}</strong> recalled by operator. Routing to nearest available charger <strong>${port.id}</strong> (${nearest.distance}m, ~${nearest.energyNeeded}% SoC).`);
        } else if (reason === 'PROACTIVE_STAGGERED_CHARGE') {
          logTerminal('BMS', 'tag-inbound', `🔋 <strong>${robot.id}</strong> (${robot.battery.toFixed(1)}% SoC) initiated proactive recharge at <strong>${port.id}</strong> (Threshold: ${(robot.proactiveChargeThreshold || 32).toFixed(0)}% SoC).`);
        } else if (reason === 'CHARGER_FAULT_REROUTE') {
          logTerminal('BMS', 'tag-yield', `⚡ <strong>${robot.id}</strong> (${robot.battery.toFixed(1)}% SoC) rerouted from tripped charger to alternative port <strong>${port.id}</strong>.`);
        } else {
          logTerminal('BMS', 'tag-inbound', `🔋 <strong>${robot.id}</strong> (${robot.battery.toFixed(1)}% SoC) navigating to nearest charger <strong>${port.id}</strong> (${nearest.distance}m, Est: ~${nearest.energyNeeded}% SoC).`);
        }
      }
    }

    // Charger Fault Injection & Recovery
    function injectChargerFault(chargerId = null, faultReason = 'POWER_CONVERTER_TRIP') {
      let port = null;
      if (chargerId) {
        port = CHARGING_PORTS.find(p => p.id === chargerId);
      } else {
        const operational = CHARGING_PORTS.filter(p => !p.isFaulted);
        if (operational.length > 0) {
          port = operational[Math.floor(Math.random() * operational.length)];
        }
      }

      if (!port) return null;

      port.isFaulted = true;
      port.faultReason = faultReason;
      port.faultSimTime = Number((totalSimSeconds || 0).toFixed(2));
      FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerFaultsIncurred++;

      logTerminal('BMS', 'tag-yield', `⚡💥 <strong>CHARGER FAULT:</strong> Fast Charger <strong>${port.id}</strong> tripped with <strong>${faultReason}</strong>!`);

      // If a robot is currently docked at this charger, interrupt charging & reroute immediately
      if (port.occupiedBy) {
        const dockedBot = AMR_FLEET.find(b => b.id === port.occupiedBy);
        if (dockedBot) {
          dockedBot.powerWatts = 0;
          dockedBot.chargeRateKw = 0;
          undockFromCharger(dockedBot.id);
          dockedBot.state = 'RETURNING_HOME';
          dockedBot.statusBadge = 'CHG TRIP';
          logTerminal('BMS', 'tag-yield', `⚡ <strong>${dockedBot.id}</strong> lost shore power at faulted <strong>${port.id}</strong>. Undocking and rerouting to operational charger.`);
          routeRobotToNearestCharger(dockedBot, 'CHARGER_FAULT_REROUTE');
        }
      }

      // If a robot has reserved this charger, cancel reservation and reroute
      if (port.reservedBy) {
        const reservingBot = AMR_FLEET.find(b => b.id === port.reservedBy);
        port.reservedBy = null;
        if (reservingBot) {
          routeRobotToNearestCharger(reservingBot, 'CHARGER_FAULT_REROUTE');
        }
      }

      updateHudStats();
      return {
        chargerId: port.id,
        faultReason,
        simTime: port.faultSimTime
      };
    }

    function recoverChargerFault(chargerId = null) {
      let port = null;
      if (chargerId) {
        port = CHARGING_PORTS.find(p => p.id === chargerId);
      } else {
        port = CHARGING_PORTS.find(p => p.isFaulted);
      }

      if (!port) return false;

      port.isFaulted = false;
      port.faultReason = null;
      FLEET_FAILURE_MAINTENANCE_METRICS.totalMaintenanceServicesCompleted++;

      logTerminal('BMS', 'tag-complete', `⚡🛠️ <strong>CHARGER RESTORED:</strong> Fast Charger <strong>${port.id}</strong> repaired and re-energized.`);

      // Check if any queued robot can now dock here
      if (CHARGER_WAITING_QUEUE.length > 0) {
        const nextEntry = CHARGER_WAITING_QUEUE.shift();
        const nextBot = AMR_FLEET.find(b => b.id === nextEntry.robotId);
        if (nextBot && nextBot.state !== 'IDLE_CHARGING' && !nextBot.isFaulted) {
          const waitSec = Math.max(0, (totalSimSeconds || 0) - (nextEntry.joinTime || 0));
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds += waitSec;
          FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued++;
          FLEET_FAILURE_MAINTENANCE_METRICS.averageChargerQueueWaitSeconds = Number((FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerQueueWaitSeconds / FLEET_FAILURE_MAINTENANCE_METRICS.totalChargerSessionsQueued).toFixed(1));
          routeRobotToNearestCharger(nextBot, 'DEQUEUED_TO_RESTORED_CHARGER');
        }
      }

      updateHudStats();
      return true;
    }

    function evaluateMissionEnergyFeasibility(robot, task) {
      let d1 = 0, e1 = 0, d2 = 0, e2 = 0, d3 = 0, e3 = 0;
      let finalX = robot.gridX, finalY = robot.gridY;
      let nearestCharger = null;

      // Realistic Aisle Tortuosity Multiplier: In a warehouse grid with rack pods,
      // actual paths are ~28% longer than straight Manhattan distance |x1-x2| + |y1-y2|
      const AISLE_TORTUOSITY = 1.28;
      // Traffic delay & maneuvering energy margin (+2.0% SoC for turns, yields, and acceleration surges)
      const TRAFFIC_RESERVE_SOC = 2.0;
      const BATTERY_FLOOR_CUTOFF = 15.0; // 15.0% Safety Reserve: guarantees vehicle never approaches 10.0% floor

      if (task.type === 'INBOUND') {
        const dockX = task.dockX !== undefined ? task.dockX : 1;
        const dockY = task.dockY !== undefined ? task.dockY : 5;
        d1 = Math.round((Math.abs(robot.gridX - dockX) + Math.abs(robot.gridY - dockY)) * AISLE_TORTUOSITY);
        e1 = calculateEnergyCost(d1, 0, 0);

        const parcels = task.parcels || [];
        const weight = task.totalWeight || 10;
        let currX = dockX, currY = dockY;
        const unvisited = parcels.filter(p => p.rackSlot && p.rackSlot.rack);
        while (unvisited.length > 0) {
          let bestIdx = 0, bestDist = Infinity;
          for (let i = 0; i < unvisited.length; i++) {
            const rx = unvisited[i].rackSlot.rack.x, ry = unvisited[i].rackSlot.rack.y;
            const dist = Math.abs(currX - rx) + Math.abs(currY - ry);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          const [p] = unvisited.splice(bestIdx, 1);
          d2 += bestDist;
          currX = p.rackSlot.rack.x;
          currY = p.rackSlot.rack.y;
        }
        if (parcels.length === 0) d2 = 24;
        d2 = Math.round(d2 * AISLE_TORTUOSITY);
        finalX = currX; finalY = currY;
        e2 = calculateEnergyCost(d2, weight, parcels.length || 1);

        const chgInfo = getNearestAvailableCharger(finalX, finalY, robot.id);
        nearestCharger = chgInfo.charger;
        d3 = Math.round(chgInfo.distance * AISLE_TORTUOSITY);
        e3 = calculateEnergyCost(d3, 0, 0) + DOCKING_ENERGY_BUFFER;
      } else { // OUTBOUND
        const firstRack = task.rack || { x: 30, y: 15 };
        d1 = Math.round((Math.abs(robot.gridX - firstRack.x) + Math.abs(robot.gridY - firstRack.y)) * AISLE_TORTUOSITY);
        e1 = calculateEnergyCost(d1, 0, 0);

        const items = task.itemsToPick || [];
        const weight = task.totalWeight || 8;
        const bayX = task.bayX !== undefined ? task.bayX : 1;
        const bayY = task.bayY !== undefined ? task.bayY : 27;

        let currX = firstRack.x, currY = firstRack.y;
        const unvisited = items.slice(1).filter(it => it.rack);
        while (unvisited.length > 0) {
          let bestIdx = 0, bestDist = Infinity;
          for (let i = 0; i < unvisited.length; i++) {
            const rx = unvisited[i].rack.x, ry = unvisited[i].rack.y;
            const dist = Math.abs(currX - rx) + Math.abs(currY - ry);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          const [it] = unvisited.splice(bestIdx, 1);
          d2 += bestDist;
          currX = it.rack.x;
          currY = it.rack.y;
        }
        d2 += (Math.abs(currX - bayX) + Math.abs(currY - bayY));
        d2 = Math.round(d2 * AISLE_TORTUOSITY);
        finalX = bayX; finalY = bayY;
        e2 = calculateEnergyCost(d2, weight, items.length || 1);

        const chgInfo = getNearestAvailableCharger(finalX, finalY, robot.id);
        nearestCharger = chgInfo.charger;
        d3 = Math.round(chgInfo.distance * AISLE_TORTUOSITY);
        e3 = calculateEnergyCost(d3, 0, 0) + DOCKING_ENERGY_BUFFER;
      }

      // =========================================================================
      // USER TWO-TIER ENERGY DECISION ALGORITHM:
      // "when their next assignment is there:
      //  1. see if there is a chance of going <10% -> if yes, go charge.
      //  2. if no then calculate if doing that task+going back to charge port
      //     charge is there or not -> if no charge. if yes go on"
      // =========================================================================

      // TIER 1: Check if there is ANY chance of dropping near reserve buffer during immediate transit/legs
      const proThreshold = robot.proactiveChargeThreshold || 32.0;
      const chanceGoingBelow10 = (robot.battery <= proThreshold) ||
                                 ((robot.battery - e1) < (BATTERY_FLOOR_CUTOFF + 0.5)) ||
                                 ((robot.battery - (e1 + e2)) < BATTERY_FLOOR_CUTOFF);

      if (chanceGoingBelow10) {
        // "if yes, go charge"
        return {
          feasible: false,
          decision: 'GO_CHARGE_RISK_BELOW_10',
          chanceGoingBelow10: true,
          hasEnoughForTaskAndReturn: false,
          reason: `High risk of dropping near buffer during task (Current: ${robot.battery.toFixed(1)}%, Threshold: ${proThreshold.toFixed(0)}%, Leg1: ${e1.toFixed(1)}%). Must go charge!`,
          currentBattery: robot.battery,
          e1: Math.round(e1 * 10) / 10,
          e2: Math.round(e2 * 10) / 10,
          e3: Math.round(e3 * 10) / 10,
          eTrip: Math.round((e1 + e2 + e3) * 10) / 10,
          eRequired: Math.round((e1 + e2 + e3 + BATTERY_FLOOR_CUTOFF) * 10) / 10,
          remainingAfterReturn: Math.round((robot.battery - (e1 + e2 + e3)) * 10) / 10,
          margin: Math.round((robot.battery - (e1 + e2 + e3 + BATTERY_FLOOR_CUTOFF)) * 10) / 10,
          nearestCharger,
          nearestChargerDist: d3,
          finalX,
          finalY
        };
      }

      // TIER 2: "if no then calculate if doing that task+going back to charge port charge is there or not."
      const eTask = e1 + e2;
      const eReturn = e3;
      const totalTripEnergy = eTask + eReturn + TRAFFIC_RESERVE_SOC;
      const projectedAfterReturn = robot.battery - totalTripEnergy;
      const hasEnoughForTaskAndReturn = projectedAfterReturn >= BATTERY_FLOOR_CUTOFF;

      if (!hasEnoughForTaskAndReturn) {
        // "if no charge" -> Must go charge!
        return {
          feasible: false,
          decision: 'GO_CHARGE_INSUFFICIENT_RETURN',
          chanceGoingBelow10: false,
          hasEnoughForTaskAndReturn: false,
          reason: `Insufficient charge for Task + Return to port (Requires: ${totalTripEnergy.toFixed(1)}% SoC, leaves ${projectedAfterReturn.toFixed(1)}% < 10% floor). Must go charge!`,
          currentBattery: robot.battery,
          e1: Math.round(e1 * 10) / 10,
          e2: Math.round(e2 * 10) / 10,
          e3: Math.round(e3 * 10) / 10,
          eTrip: Math.round(totalTripEnergy * 10) / 10,
          eRequired: Math.round((totalTripEnergy + BATTERY_FLOOR_CUTOFF) * 10) / 10,
          remainingAfterReturn: Math.round(projectedAfterReturn * 10) / 10,
          margin: Math.round((projectedAfterReturn - BATTERY_FLOOR_CUTOFF) * 10) / 10,
          nearestCharger,
          nearestChargerDist: d3,
          finalX,
          finalY
        };
      }

      // "if yes go on" -> Authorized!
      return {
        feasible: true,
        decision: 'GO_ON',
        chanceGoingBelow10: false,
        hasEnoughForTaskAndReturn: true,
        reason: `Energy verified: Task (${eTask.toFixed(1)}%) + Return to port (${eReturn.toFixed(1)}%) leaves ${projectedAfterReturn.toFixed(1)}% SoC (>= 10% floor). Authorized to go on!`,
        currentBattery: robot.battery,
        e1: Math.round(e1 * 10) / 10,
        e2: Math.round(e2 * 10) / 10,
        e3: Math.round(e3 * 10) / 10,
        eTrip: Math.round(totalTripEnergy * 10) / 10,
        eRequired: Math.round((totalTripEnergy + BATTERY_FLOOR_CUTOFF) * 10) / 10,
        remainingAfterReturn: Math.round(projectedAfterReturn * 10) / 10,
        margin: Math.round((projectedAfterReturn - BATTERY_FLOOR_CUTOFF) * 10) / 10,
        nearestCharger,
        nearestChargerDist: d3,
        finalX,
        finalY
      };
    }

    function sendBotToCharger(robotId) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;
      if (r.state === 'IDLE_CHARGING') {
        logTerminal('BMS', 'tag-inbound', `ℹ️ <strong>${r.id}</strong> is already connected to Fast Charger <strong>${r.currentChargerId || r.homeBayId}</strong>.`);
        return;
      }
      if (r.orderBox || (r.carriedParcels && r.carriedParcels.length > 0)) {
        logTerminal('BMS', 'tag-yield', `⚠️ <strong>${r.id}</strong> is carrying active payload. Will route to nearest charger immediately upon mission completion.`);
        return;
      }
      routeRobotToNearestCharger(r, 'OPERATOR_RECALL');
      updateHudStats();
      updateBotsHealthDashboard();
    }

    function recallAllIdleBots() {
      let count = 0;
      for (const r of AMR_FLEET) {
        if (r.state === 'IDLE') {
          routeRobotToNearestCharger(r, 'OPERATOR_RECALL');
          count++;
        }
      }
      logTerminal('BMS', 'tag-yield', `⚡ Operator recalled all idle robots (${count} units) to their nearest available fast chargers.`);
      updateHudStats();
      updateBotsHealthDashboard();
    }

    function updateBotsHealthDashboard() {
      const container = document.getElementById('bots-cards-grid');
      if (!container || !AMR_FLEET) return;

      // Compute fleet KPI summaries
      let totalBatt = 0;
      let activeCount = 0;
      let chargingCount = 0;
      let totalNetPowerKw = 0;
      let totalPayloadKg = 0;
      let lowBattCount = 0;

      for (const r of AMR_FLEET) {
        totalBatt += r.battery;
        if (r.state === 'IDLE_CHARGING') {
          chargingCount++;
          totalNetPowerKw += (r.chargeRateKw || 0);
        } else {
          activeCount++;
          totalNetPowerKw -= ((r.powerWatts || 165) / 1000.0);
        }
        totalPayloadKg += (r.payloadWeight || 0);
        if (r.battery <= 28.0 && r.state !== 'IDLE_CHARGING') lowBattCount++;
      }

      const avgBatt = AMR_FLEET.length > 0 ? (totalBatt / AMR_FLEET.length).toFixed(1) : 0;
      const kpiFleet = document.getElementById('kpi-fleet-status');
      const kpiAvgBatt = document.getElementById('kpi-avg-battery');
      const kpiPower = document.getElementById('kpi-net-power');
      const kpiFreight = document.getElementById('kpi-total-freight');
      const summaryBadge = document.getElementById('bots-status-summary');

      if (kpiFleet) kpiFleet.innerText = `8 Online (${chargingCount} Chg | ${activeCount} Active${lowBattCount > 0 ? ` | ${lowBattCount} Low SoC` : ''})`;
      if (kpiAvgBatt) {
        kpiAvgBatt.innerText = `${avgBatt}%`;
        kpiAvgBatt.style.color = avgBatt > 50 ? '#22c55e' : (avgBatt > 25 ? '#f59e0b' : '#ef4444');
      }
      if (kpiPower) {
        const sign = totalNetPowerKw >= 0 ? '+' : '';
        kpiPower.innerText = `${sign}${totalNetPowerKw.toFixed(1)} kW Net`;
        kpiPower.style.color = totalNetPowerKw >= 0 ? '#4ade80' : '#38bdf8';
      }
      if (kpiFreight) kpiFreight.innerText = `${totalPayloadKg.toFixed(1)} kg`;
      if (summaryBadge) summaryBadge.innerText = `${chargingCount} Charging | ${activeCount} On Duty`;

      let freeChargers = 0;
      for (const p of CHARGING_PORTS) {
        if (!p.occupiedBy && !p.reservedBy) freeChargers++;
      }
      const kpiChg = document.getElementById('kpi-chargers-avail');
      if (kpiChg) kpiChg.innerText = `${freeChargers}/8 Available`;

      // Render 8 bot cards
      container.innerHTML = AMR_FLEET.map(r => {
        const isCharging = r.state === 'IDLE_CHARGING';
        const isLowBatt = r.battery <= 25.0 && !isCharging;

        let badgeText = 'STANDBY';
        let badgeBg = '#334155';
        let badgeColor = '#cbd5e1';

        if (isCharging) {
          badgeText = `⚡ CHARGING ${Math.round(r.battery)}%`;
          badgeBg = 'rgba(34, 197, 94, 0.2)';
          badgeColor = '#4ade80';
        } else if (isLowBatt) {
          badgeText = '🚨 LOW BATTERY';
          badgeBg = 'rgba(239, 68, 68, 0.25)';
          badgeColor = '#f87171';
        } else if (r.isOvertaking) {
          badgeText = '🏎️ OVERTAKE (1.35x)';
          badgeBg = 'rgba(56, 189, 248, 0.25)';
          badgeColor = '#38bdf8';
        } else if (r.isWaiting) {
          badgeText = `⏳ YIELDING TO ${r.yieldTo || 'AMR'}`;
          badgeBg = 'rgba(245, 158, 11, 0.25)';
          badgeColor = '#f59e0b';
        } else if (r.isRerouting) {
          badgeText = '🔄 DYNAMIC REROUTE';
          badgeBg = 'rgba(168, 85, 247, 0.25)';
          badgeColor = '#c084fc';
        } else if (r.state === 'LOADING_INBOUND') {
          badgeText = '📥 LOADING SHIPMENT';
          badgeBg = 'rgba(250, 204, 21, 0.25)';
          badgeColor = '#facc15';
        } else if (r.state === 'CARRYING_TO_RACK') {
          badgeText = `📥 SHELVING (${r.carriedParcels ? r.carriedParcels.length : 0} left)`;
          badgeBg = 'rgba(250, 204, 21, 0.25)';
          badgeColor = '#facc15';
        } else if (r.state === 'ORDER_PICKING' && r.orderBox) {
          badgeText = `📦 PICK ${r.orderBox.items.length}/${r.orderBox.totalItems}`;
          badgeBg = 'rgba(217, 119, 6, 0.25)';
          badgeColor = '#fbbf24';
        } else if (r.state === 'DELIVERING_ORDER_TO_BAY') {
          badgeText = '🚚 ORDER BOX DELIVERY';
          badgeBg = 'rgba(234, 88, 12, 0.25)';
          badgeColor = '#fb923c';
        } else if (r.state === 'RETURNING_HOME') {
          badgeText = '🏠 RETURNING TO DOCK';
          badgeBg = 'rgba(16, 185, 129, 0.2)';
          badgeColor = '#34d399';
        } else if (r.state === 'MOVING_TO_PICKUP') {
          badgeText = '🏃 TRANSIT TO DOCK';
          badgeBg = 'rgba(56, 189, 248, 0.2)';
          badgeColor = '#38bdf8';
        }

        let barColor = '#22c55e';
        if (r.battery <= 25.0) barColor = '#ef4444';
        else if (r.battery <= 50.0) barColor = '#f59e0b';

        let rateText = '';
        let etaText = '';
        if (isCharging) {
          const kw = (r.chargeRateKw || 30.0).toFixed(1);
          const chgRate = (r.batteryDeltaRate || 3.5).toFixed(1);
          rateText = `+${kw} kW (+${chgRate}%/s)`;
          const secRem = Math.max(0, Math.round((100 - r.battery) / Math.max(0.2, r.batteryDeltaRate || 2.5)));
          etaText = `Full in ~${secRem}s`;
        } else {
          const pTot = Math.round(r.powerWatts || 165);
          const drain = (r.batteryDeltaRate || 0.38).toFixed(2);
          rateText = `-${pTot} W (-${drain}%/s)`;
          const minRem = (Math.max(1, Math.round((r.battery - 15) / Math.max(0.08, r.batteryDeltaRate || 0.38))) / 60).toFixed(1);
          etaText = `~${minRem} min range`;
        }

        const spd = (r.currentSpeed || ROBOT_BASE_SPEED).toFixed(2);
        const throttlePct = r.payloadDamping ? Math.round(r.payloadDamping * 100) : 100;

        let cargoDesc = 'Deck Empty (0 kg)';
        if (r.orderBox) {
          cargoDesc = `Giant Box (${r.orderBox.items.length}/${r.orderBox.totalItems}, ${(r.payloadWeight || 5).toFixed(1)}kg)`;
        } else if (r.carriedParcels && r.carriedParcels.length > 0) {
          cargoDesc = `Tote (${r.carriedParcels.length} pkgs, ${(r.payloadWeight || 5).toFixed(1)}kg)`;
        }

        const urgency = calculateRobotUrgency(r);
        const nearestChg = getNearestAvailableCharger(r.gridX, r.gridY, r.id);
        const minReqSoC = nearestChg.energyNeeded + SAFETY_RESERVE_SOC;
        const isFeasible = r.battery >= minReqSoC;
        const reserveMargin = r.battery - minReqSoC;
        const currentBayLabel = r.currentChargerId ? `⚡ ${r.currentChargerId}` : (r.targetChargerId ? `En route ${r.targetChargerId}` : (nearestChg.charger ? nearestChg.charger.id : 'CH-01'));

        return `
          <div class="bot-card ${isLowBatt ? 'is-low-batt' : ''} ${isCharging ? 'is-charging' : ''}">
            <div class="bot-card-top">
              <div class="bot-id-title">
                <span style="color:#38bdf8;">🤖</span>
                <span>${r.id}</span>
                <span class="bot-zone-tag">(${currentBayLabel})</span>
              </div>
              <span class="bot-status-pill" style="background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeColor}40;">${badgeText}</span>
            </div>

            <div class="bot-soc-section">
              <div class="bot-soc-header">
                <span class="bot-soc-val" style="color:${barColor};">${r.battery.toFixed(1)}%</span>
                <span class="bot-soc-rate">${rateText}</span>
              </div>
              <div class="bot-soc-bar-bg">
                <div class="bot-soc-bar-fill" style="width:${r.battery.toFixed(1)}%; background:${barColor};"></div>
              </div>
              <div class="bot-soc-footer">
                <span>48V LiFePO4 BMS</span>
                <span style="font-weight:600; color:${barColor};">${etaText}</span>
              </div>
            </div>

            <div class="bot-metrics-grid">
              <div class="bot-metric-box">
                <span class="bot-metric-lbl">Kinematic Speed</span>
                <div class="bot-metric-val" style="color:#38bdf8;">${spd} c/s <span style="font-size:10px; color:#94a3b8;">(${throttlePct}%)</span></div>
              </div>
              <div class="bot-metric-box">
                <span class="bot-metric-lbl">Active Payload</span>
                <div class="bot-metric-val" style="color:#facc15;" title="${cargoDesc}">${cargoDesc}</div>
              </div>
              <div class="bot-metric-box">
                <span class="bot-metric-lbl">Nearest Charger</span>
                <div class="bot-metric-val" style="color:#4ade80;" title="Nearest available charging port distance & energy required">
                  ${nearestChg.charger ? nearestChg.charger.id : 'CH-01'} (${nearestChg.distance}m | ~${nearestChg.energyNeeded.toFixed(1)}%)
                </div>
              </div>
              <div class="bot-metric-box">
                <span class="bot-metric-lbl">BMS Energy Budget</span>
                <div class="bot-metric-val">
                  ${isFeasible ? `<span style="color:#22c55e;font-weight:700;">✔ OK (+${reserveMargin.toFixed(1)}%)</span>` : `<span style="color:#ef4444;font-weight:700;">🚨 RECHARGE (${reserveMargin.toFixed(1)}%)</span>`}
                </div>
              </div>
              <div class="bot-metric-box" style="grid-column: span 2;">
                <span class="bot-metric-lbl">Target / Mission</span>
                <div class="bot-metric-val" title="${r.targetDesc}">${r.targetDesc || 'Standby'}</div>
              </div>
              <div class="bot-metric-box" style="grid-column: span 2; background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.2);">
                <span class="bot-metric-lbl" style="color:#38bdf8;">🧠 Inner Sim Thought Process</span>
                <div class="bot-metric-val" style="color:#cbd5e1; font-size:9px; white-space:normal; line-height:1.3; min-height: 28px;">
                  ${r.thoughtProcess ? r.thoughtProcess.map(t => `<div>> ${t}</div>`).join('') : '<span style="color:#64748b;">> Path projection nominal. No conflicts detected.</span>'}
                </div>
              </div>
            </div>

            <div class="bot-card-actions">
              <button class="bot-act-btn recall" onclick="sendBotToCharger('${r.id}')" title="Recall to Nearest Fast Charger">
                <span>⚡ Dock Nearest</span>
              </button>
              <button class="bot-act-btn track" onclick="trackBot('${r.id}', true)" title="Engage targeting lock and follow camera on ${r.id}">
                <span>🎯 Track</span>
              </button>
              <button class="bot-act-btn locate" onclick="locateBotOnMap('${r.id}')" title="Locate and Center 2D Map on ${r.id}">
                <span>📍 Map</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

