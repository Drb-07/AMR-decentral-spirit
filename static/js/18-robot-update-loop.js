// Active Collision Avoidance, Overtaking, Yielding & Movement Engine
    // Fixed-Time Physics Sub-Stepping (Accumulator Pattern):
    // Guaranteed <= 0.01667s micro-ticks (max ~0.07c displacement per step) across 1x-10x
    function updateRobots(dt) {
      // Run the mesh network layer first so bots have fresh peer data
      tickDecentralizedNetwork(dt);
      if (dt > 0.02) {
        const subStepCount = Math.ceil(dt / 0.01667);
        const subDt = dt / subStepCount;
        for (let s = 0; s < subStepCount; s++) {
          _updateRobotsSubStep(subDt);
        }
        return;
      }
      _updateRobotsSubStep(dt);
    }

    function _updateRobotsSubStep(dt) {
      totalSimSeconds += dt;
      if (typeof Traffic !== 'undefined') Traffic.tick(AMR_FLEET);
      if (typeof updateHumanWorkers === 'function') updateHumanWorkers(dt);
      if (typeof updatePackStations === 'function') updatePackStations(dt);

      // 0. Update onboard perception suite for all robots
      if (typeof AMR_FLEET !== 'undefined' && AMR_FLEET) {
        for (const robot of AMR_FLEET) {
          updateRobotPerception(robot, dt);
        }
      }
      const baseSpeed = ROBOT_BASE_SPEED;

      // 1. Update battery & action timers
      for (const robot of AMR_FLEET) {
        if (!robot.logStats) {
          robot.logStats = {
            startTime: Date.now(),
            startSimTime: totalSimSeconds,
            totalSimTime: 0,
            activeMovingTime: 0,
            jamWaitTime: 0,
            chargingTime: 0,
            loadingTime: 0,
            idleTime: 0,
            totalDistanceTraveled: 0,
            totalCellsTraversed: 0,
            totalJamsEncountered: 0,
            totalBackupsToPreviousBox: 0,
            totalSideSteps: 0,
            totalOvertakesInitiated: 0,
            totalOvertakesCompleted: 0,
            totalReroutes: 0,
            totalEmergencyBraking: 0,
            totalRightOfWayYields: 0,
            totalInboundCompleted: 0,
            totalOutboundCompleted: 0,
            totalParcelsShelved: 0,
            totalItemsConsolidated: 0,
            totalWeightTransportedKg: 0,
            initialBattery: robot.battery,
            minBatterySeen: robot.battery,
            totalEnergyConsumedSoC: 0,
            totalEnergyChargedSoC: 0,
            chargeCyclesCount: 1,
            maxSpeed: 0
          };
          robot.currentJam = null;
          robot.jamEpisodes = robot.jamEpisodes || [];
          robot.missionsHistory = robot.missionsHistory || [];
          robot.eventHistory = robot.eventHistory || [];
        }

        robot.logStats.totalSimTime += dt;
        if (robot.state === 'IDLE_CHARGING') {
          robot.logStats.chargingTime += dt;
        } else if (robot.state === 'LOADING_INBOUND') {
          robot.logStats.loadingTime += dt;
        } else if (robot.isWaiting) {
          if (!robot.isStagingWait) {
            robot.logStats.jamWaitTime += dt;
          }
        } else if (robot.state === 'IDLE') {
          robot.logStats.idleTime += dt;
        } else if (robot.path && robot.path.length > 0 && robot.pathIndex < robot.path.length) {
          robot.logStats.activeMovingTime += dt;
        }

        if (robot.state === 'IDLE_CHARGING') {
          // ==========================================
          // REALISTIC CC/CV FAST-CHARGING PROFILE
          // 48V 40Ah LiFePO4 (1,920 Wh) Pack
          // ==========================================
          let chargeRate = 0;
          let kw = 0;
          let phase = '';

          if (robot.battery < 75.0) {
            chargeRate = 3.5;
            kw = 30.0;
            phase = 'Bulk CC Phase (Fast)';
          } else if (robot.battery < 95.0) {
            const taper = 1.0 - ((robot.battery - 75.0) / 20.0) * 0.68;
            chargeRate = 3.5 * taper;
            kw = 30.0 * taper;
            phase = 'Absorption CV Phase (Tapered)';
          } else if (robot.battery < 100.0) {
            chargeRate = 0.55;
            kw = 2.4;
            phase = 'Cell Balancing / Float';
          } else {
            chargeRate = 0;
            kw = 0.1;
            phase = 'Fully Charged (100% Float)';
          }

          robot.battery = Math.min(100.0, robot.battery + chargeRate * dt);
          if (robot.logStats) {
            robot.logStats.totalEnergyChargedSoC += chargeRate * dt;
          }
          robot.chargeRateKw = kw;
          robot.chargePhase = phase;
          robot.batteryDeltaRate = chargeRate;
          robot.powerWatts = 0;
          robot.powerBreakdown = `Charger Input: +${kw.toFixed(1)}kW`;

          // Announce bulk charge readiness milestone (80% SoC)
          if (robot.battery >= 80.0 && !robot.hasAnnouncedBulkCharged) {
            robot.hasAnnouncedBulkCharged = true;
            robot.hasAnnouncedLowBatt = false; // Reset low batt announcement
            logTerminal('BMS', 'tag-inbound', `🔋 <strong>${robot.id}</strong> fast-charge reached <strong>${robot.battery.toFixed(1)}% SoC</strong> (${phase}). Ready for active warehouse dispatch.`);
          }
          if (robot.battery >= 99.9) {
            robot.battery = 100.0;
            robot.hasAnnouncedBulkCharged = true;
          }
        } else {
          // ==========================================
          // REALISTIC DYNAMIC DISCHARGE CONSUMPTION
          // P_total = P_avionics + P_traction + P_brake + P_rotate + P_maneuver + P_lift
          // Work-energy formulation: F = m*a + mu*m*g + 0.5*rho*Cd*v^2
          // ==========================================
          let pAvionics = 45; // 45W: LiDAR scanners, safety laser, depth cameras, onboard edge AI, mesh radio
          let pTraction = 0;
          let pBrake = 0;
          let pRotate = 0;
          let pManeuver = 0;
          let pLift = 0;

          const cargoW = robot.payloadWeight || 0;
          const TARE_MASS_KG = 145.0; // Chassis tare mass (kg)
          const totalMassKg = TARE_MASS_KG + cargoW;
          const curSpd = robot.currentSpeed || 0;
          const vMs = curSpd * 0.8; // Convert cells/s to m/s (~0.8m per cell)
          const isMoving = robot.path && robot.path.length > 0 && robot.pathIndex < robot.path.length && !robot.isWaiting;

          if (isMoving && curSpd > 0.05) {
            // Mechanical traction work: rolling friction + aerodynamic drag + acceleration inertia
            const fRoll = 0.016 * totalMassKg * 9.81; // Rolling resistance on warehouse concrete
            const fDrag = 0.25 * vMs * vMs;          // Aerodynamic & drivetrain air resistance
            const fAccel = totalMassKg * Math.max(0, (robot.acceleration || 0) * 0.8);
            const fTotal = fRoll + fDrag + fAccel;
            pTraction = Math.max(25, (fTotal * vMs) / 0.85); // 85% motor & inverter electrical efficiency
          } else {
            pTraction = 0; // Stationary while waiting or idle
          }

          // Sudden Braking Energy Dissipation:
          // Electromechanical brake solenoid coil draw + kinetic energy heat dissipation in braking circuit
          if (robot.isBraking || (robot.acceleration && robot.acceleration < -1.5)) {
            const decelMagnitude = Math.abs((robot.acceleration || -3.0) * 0.8);
            const fDecel = totalMassKg * decelMagnitude;
            pBrake = 75 + (fDecel * Math.max(0.4, vMs) * 0.35); // Peak braking electrical & dissipative surge
            if (robot.logStats) {
              robot.logStats.totalBrakingEnergyJoules = (robot.logStats.totalBrakingEnergyJoules || 0) + pBrake * dt;
            }
            robot.totalBrakingEnergyJoules = (robot.totalBrakingEnergyJoules || 0) + pBrake * dt;
          }

          // Cornering Rotation Energy:
          // Dual differential wheel counter-rotation overcoming tire-scrubbing friction
          if (robot.isTurning || (robot.angularVelocity && Math.abs(robot.angularVelocity) > 0.1)) {
            const maxOmega = 3.8 * Math.sqrt(TARE_MASS_KG / totalMassKg);
            const rotRatio = Math.min(1.0, Math.abs(robot.angularVelocity || 2.0) / maxOmega);
            pRotate = 85 * rotRatio * (totalMassKg / TARE_MASS_KG);
            if (robot.logStats) {
              robot.logStats.totalRotationTimeSec = (robot.logStats.totalRotationTimeSec || 0) + dt;
            }
            robot.totalRotationTimeSeconds = (robot.totalRotationTimeSeconds || 0) + dt;
          }

          // Dynamic maneuver surges
          if (robot.isOvertaking) pManeuver += 65;
          if (robot.isRerouting) pManeuver += 25;

          // Actuator mechanical lift during loading, shelving or picking
          if (robot.state === 'LOADING_INBOUND' || robot.state === 'CARRYING_TO_RACK' || robot.state === 'ORDER_PICKING') {
            pLift = 35 * (1.0 + (cargoW / 50.0) * 0.5);
          }

          const pTotal = pAvionics + pTraction + pBrake + pRotate + pManeuver + pLift;
          robot.powerWatts = pTotal;
          robot.powerBreakdown = `Avionics: ${pAvionics}W | Traction: ${Math.round(pTraction)}W${cargoW > 0 ? ` | Cargo (${cargoW.toFixed(1)}kg): +${Math.round(pTraction * (cargoW / totalMassKg))}W` : ''}${pBrake > 0 ? ` | Brake: +${Math.round(pBrake)}W` : ''}${pRotate > 0 ? ` | Turn: +${Math.round(pRotate)}W` : ''}`;

          // Calibrated drain rate: 165W base drain corresponds to ~0.16% / sec (~0.038% / tile) in simulation time
          const drainRate = (pTotal / 165.0) * 0.16;
          robot.battery = Math.max(10.0, robot.battery - drainRate * dt);
          if (robot.logStats) {
            robot.logStats.totalEnergyConsumedSoC += drainRate * dt;
            if (robot.battery < robot.logStats.minBatterySeen) {
              robot.logStats.minBatterySeen = robot.battery;
            }
          }
          robot.batteryDeltaRate = drainRate;
          robot.chargeRateKw = 0;
          robot.chargePhase = 'Discharging';

          // Out of charge check: Battery depleted to UVLO cut-off (10.0% Hard Floor, NEVER 4%)
          if (robot.battery <= 10.0) {
            if (typeof Traffic !== 'undefined') Traffic.release(robot);
            robot.battery = 10.0;
            if (robot.state !== 'OUT_OF_CHARGE') {
              robot.state = 'OUT_OF_CHARGE';
              robot.currentSpeed = 0;
              robot.statusBadge = 'LOW 10%';
              robot.targetDesc = `IMMOBILIZED: BMS Low-Voltage Cutoff at 10.0% SoC (Tow Required)`;
              robot.strandedTimer = 0;
              if (robot.logStats) robot.logStats.totalOutOfChargeEvents = (robot.logStats.totalOutOfChargeEvents || 0) + 1;

              logBotProblem('OUT_OF_CHARGE', robot.id, {
                x: robot.gridX,
                y: robot.gridY,
                severity: 'CRITICAL',
                desc: `🪫 BMS UVLO Protection Tripped: <strong>${robot.id}</strong> battery reached 10.0% safe discharge floor at (${robot.gridX}, ${robot.gridY}). Drive motor inverter deactivated. Vehicle immobilized.`
              });
              logTerminal('ALERT', 'tag-yield', `🪫 <strong>${robot.id}</strong> BATTERY AT 10% FLOOR. Vehicle stranded at (${robot.gridX}, ${robot.gridY}). Dispatching auto-recovery.`);
            }

            // Autonomous Rescue Fail-Safe:
            // If stranded for > 3s, autonomous warehouse recovery tug tows it to a charger so simulation never freezes
            robot.strandedTimer = (robot.strandedTimer || 0) + dt;
            if (robot.strandedTimer > 3.0) {
              logTerminal('SYSTEM', 'tag-complete', `🚜 Autonomous AGV Recovery Tug towed stranded <strong>${robot.id}</strong> from aisle (${robot.gridX}, ${robot.gridY}) to fast charger.`);
              rescueStrandedBot(robot.id);
            }
            continue; // Cannot move while dead!
          }

          // Reset bulk charge announcement flag once battery drops below 75%
          if (robot.battery < 75.0) {
            robot.hasAnnouncedBulkCharged = false;
          }

          // Autonomous Low-Battery Protection & Threshold Management
          if (robot.battery <= 28.0 && !robot.hasAnnouncedLowBatt) {
            robot.hasAnnouncedLowBatt = true;
            logTerminal('BMS', 'tag-yield', `⚠️ <strong>${robot.id}</strong> Battery Low (<strong>${robot.battery.toFixed(1)}% SoC</strong>, draw ${Math.round(pTotal)}W). Scheduling autonomous opportunity recharge.`);
          }

          // If robot is IDLE on the floor with battery < 40%, immediately route to nearest available charger
          if (robot.state === 'IDLE' && robot.battery < 40.0) {
            routeRobotToNearestCharger(robot, 'LOW_BATTERY');
          }

          // Proactive Early Charger Reservation:
          // When robot is on its delivery leg and battery drops near its proactive threshold,
          // reserve an available charger pad early so it never competes at the throat!
          if (robot.battery <= ((robot.proactiveChargeThreshold || 32.0) + 2.0) && !robot.targetChargerId) {
            const preChg = getNearestAvailableCharger(robot.gridX, robot.gridY, robot.id, false);
            if (preChg && preChg.charger && !preChg.charger.reservedBy && !preChg.charger.occupiedBy) {
              reserveCharger(preChg.charger.id, robot.id);
            }
          }

          // Real-World Amazon Dynamic In-Transit Energy Reserve Safeguard:
          // If robot is on floor and remaining SoC drops to <= 12.0%, immediately abort mission and divert to charger!
          if (robot.battery <= 12.0 && robot.state !== 'IDLE_CHARGING' && robot.state !== 'RETURNING_HOME' && robot.state !== 'OUT_OF_CHARGE') {
            abortMissionToCharger(robot.id, 'DYNAMIC_SAFETY_ABORT');
          }
        }

        if (robot.state === 'LOADING_INBOUND') {
          if (robot.loadingTimer > 0) {
            robot.loadingTimer -= dt;
            if (robot.loadingTimer <= 0) {
              // Finished loading at dock -> start moving to first shelf destination!
              robot.state = 'CARRYING_TO_RACK';
              if (robot.carriedParcels && robot.carriedParcels.length > 0) {
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
              }
            }
          }
        }

        // Feature 9A: LOADING_RETURN timer → CARRYING_RETURN
        if (robot.state === 'LOADING_RETURN') {
          if (robot.loadingTimer > 0) {
            robot.loadingTimer -= dt;
            if (robot.loadingTimer <= 0) {
              robot.state = 'CARRYING_RETURN';
              if (robot.carriedParcels && robot.carriedParcels.length > 0) {
                const nextP = robot.carriedParcels[0];
                const access = getAccessPointForRack(nextP.rackSlot.rack.x, nextP.rackSlot.rack.y, robot.gridX, robot.gridY, robot.id);
                robot.targetDesc = `Returns Stow ${nextP.parcel_id} at Rack (${nextP.rackSlot.rack.x},${nextP.rackSlot.rack.y})`;
                robot.statusBadge = `STOW↩ ${robot.carriedParcels.length}`;
                if (access) {
                  setRobotPath(robot, findPath(robot.gridX, robot.gridY, access.x, access.y));
                  if (robot.path.length === 0) onRobotReachedDestination(robot);
                }
              } else {
                onRobotReachedDestination(robot);
              }
            }
          }
        }

        // Feature 9C: LIFTING_POD timer → DELIVERING_POD_TO_PICKER
        if (robot.state === 'LIFTING_POD') {
          if (robot.loadingTimer > 0) {
            robot.loadingTimer -= dt;
            if (robot.loadingTimer <= 0) {
              const pod = robot.kivaAssignedPod;
              const station = robot.kivaTargetStation;
              if (!pod || !station) { robot.state = 'IDLE'; return; }
              robot.state = 'DELIVERING_POD_TO_PICKER';
              robot.isLoadedYellow = true;
              robot.statusBadge = 'KIVA→PKR';
              robot.targetDesc = `Delivering Pod ${pod.id} to Picker ${station.bayId}`;
              setRobotPath(robot, findPath(robot.gridX, robot.gridY, station.x, station.y));
              if (robot.path.length === 0) onRobotReachedDestination(robot);
            }
          }
        }

        // Feature 9C: WAITING_AT_PICKER timer → RETURNING_POD_TO_HOME
        if (robot.state === 'WAITING_AT_PICKER') {
          if (robot.kivaPickTimer > 0) {
            robot.kivaPickTimer -= dt;
            if (robot.kivaPickTimer <= 0) {
              const pod = robot.kivaAssignedPod;
              robot.isWaiting = false;
              robot._wasWaitingThisFrame = false;
              robot.state = 'RETURNING_POD_TO_HOME';
              robot.statusBadge = 'KIVA→HOME';
              if (pod) {
                robot.targetDesc = `Returning Pod ${pod.id} to home (${pod.homeX},${pod.homeY})`;
                setRobotPath(robot, findPath(robot.gridX, robot.gridY, pod.homeX, pod.homeY));
                if (robot.path.length === 0) onRobotReachedDestination(robot);
              } else {
                robot.state = 'IDLE';
              }
            }
          }
        }

        if (robot.state === 'HANDOFF_TO_PACKER') {
          if (robot.handoffTimer > 0) {
            robot.handoffTimer -= dt;
            robot.currentSpeed = 0;
            if (robot.handoffTimer <= 0) {
              const mission = robot.outboundMission;
              if (mission && robot.orderBox) {
                const targetBayId = (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0)
                  ? mission.pendingDeliveries[0].bayId
                  : mission.bayId;

                const station = (typeof PACK_STATIONS !== 'undefined' && PACK_STATIONS) ? PACK_STATIONS[targetBayId] : null;
                const itemsCount = robot.orderBox.totalItems || 1;
                // Realistic Human Packaging throughput:
                // Base taping & box forming: 3.5s + 2.0s per item barcode scanning & wrapping
                const packDuration = Number((3.5 + itemsCount * 2.0).toFixed(1));

                if (station) {
                  station.state = 'PACKING';
                  station.assignedRobotId = null;
                  station.currentOrder = {
                    orderId: robot.orderBox.orderId || mission.orderId,
                    itemsCount: itemsCount,
                    weight: mission.totalWeight,
                    totalDurationSec: packDuration,
                    remainingSec: packDuration
                  };
                  logTerminal('PACKER', 'tag-outbound', `📦 Packer at <strong>${station.id}</strong> commenced sealing Order <strong>${station.currentOrder.orderId}</strong> (${itemsCount} items, ETA: ${packDuration}s). <strong>${robot.id}</strong> custody released.`);
                }

                if (mission.isWaveBatch && mission.pendingDeliveries && mission.pendingDeliveries.length > 0) {
                  const currentDeliv = mission.pendingDeliveries.shift();
                  const oIdx = outboundMissions.findIndex(m => m.orderId === currentDeliv.orderId);
                  if (oIdx !== -1) outboundMissions.splice(oIdx, 1);
                  if (robot.logStats) robot.logStats.totalOutboundCompleted++;
                  if (robot.missionsHistory) {
                    robot.missionsHistory.push({
                      type: 'OUTBOUND',
                      orderId: currentDeliv.orderId,
                      bayId: currentDeliv.bayId,
                      itemsCount: currentDeliv.itemsCount,
                      totalWeightKg: currentDeliv.weight,
                      finishSimTimeSec: Number(totalSimSeconds.toFixed(2)),
                      durationSec: robot.missionStartTime ? Number(((Date.now() - robot.missionStartTime) / 1000).toFixed(1)) : 0
                    });
                  }
                  recordRobotEvent(robot, 'ORDER_DELIVERED', `Order ${currentDeliv.orderId} (${currentDeliv.itemsCount} items) handed off to Packer at Bay ${currentDeliv.bayId}`, { orderId: currentDeliv.orderId, bayId: currentDeliv.bayId });
                  recordOrderDelivered(currentDeliv);
                  if (window._benchStats) {
                      window._benchStats.tasksCompleted++;
                      window._benchStats.taskTimes.push(totalSimSeconds - (currentDeliv.createdSimTimeSec || 0));
                  }

                  if (mission.pendingDeliveries.length > 0) {
                    const nextDeliv = mission.pendingDeliveries[0];
                    releaseAllTerminalClaimsForRobot(robot.id);
                    if (typeof Traffic !== 'undefined') Traffic.release(robot);
                    claimTerminalDestination(robot.id, nextDeliv.bayX, nextDeliv.bayY);
                    robot.state = 'DELIVERING_ORDER_TO_BAY';
                    robot.targetDesc = `Delivering Wave Batch (${nextDeliv.itemsCount} items) to Bay ${nextDeliv.bayId}`;
                    robot.statusBadge = 'DELIVER';
                    setRobotPath(robot, findPath(robot.gridX, robot.gridY, nextDeliv.bayX, nextDeliv.bayY));
                    if (robot.path.length === 0) onRobotReachedDestination(robot);
                    updateHudStats();
                    continue;
                  }
                } else {
                  const oIdx = outboundMissions.findIndex(m => m.orderId === mission.orderId);
                  if (oIdx !== -1) outboundMissions.splice(oIdx, 1);
                  if (robot.logStats) robot.logStats.totalOutboundCompleted++;
                  if (robot.missionsHistory) {
                    robot.missionsHistory.push({
                      type: 'OUTBOUND',
                      orderId: mission.orderId,
                      bayId: mission.bayId,
                      itemsCount: robot.orderBox.totalItems,
                      totalWeightKg: mission.totalWeight,
                      finishSimTimeSec: Number(totalSimSeconds.toFixed(2)),
                      durationSec: robot.missionStartTime ? Number(((Date.now() - robot.missionStartTime) / 1000).toFixed(1)) : 0
                    });
                  }
                  recordRobotEvent(robot, 'ORDER_DELIVERED', `Customer Order ${robot.orderBox.orderId} handed off to Packer at Bay ${mission.bayId}`, { orderId: mission.orderId, bayId: mission.bayId });
                  recordOrderDelivered({
                    orderId: mission.orderId,
                    bayId: mission.bayId,
                    importance: mission.importance,
                    createdSimTimeSec: mission.createdSimTimeSec,
                    itemsCount: robot.orderBox ? robot.orderBox.totalItems : 1,
                    weight: mission.totalWeight
                  });
                  if (window._benchStats) {
                      window._benchStats.tasksCompleted++;
                      window._benchStats.taskTimes.push(totalSimSeconds - (mission.createdSimTimeSec || 0));
                  }
                }
              }

              releaseAllTerminalClaimsForRobot(robot.id);
              if (typeof Traffic !== 'undefined') Traffic.release(robot);
              robot.orderBox = null;
              robot.outboundMission = null;
              robot.statusBadge = null;
              robot.payloadWeight = 0;
              robot.payloadDamping = 1.0;
              robot.state = 'IDLE';
              updateHudStats();

              const threshold = robot.proactiveChargeThreshold || 32.0;
              if (robot.battery <= threshold) {
                routeRobotToNearestCharger(robot, 'PROACTIVE_STAGGERED_CHARGE');
              } else if (robot.battery < 80.0) {
                routeRobotToNearestCharger(robot, 'POST_MISSION_CHARGE');
              }
              dispatchFleet();
            }
          }
        }

        if (robot.rerouteTimer > 0) {
          robot.rerouteTimer -= dt;
          if (robot.rerouteTimer <= 0) {
            robot.isRerouting = false;
            if (robot.statusBadge === 'REROUTE') robot.statusBadge = null;
          }
        }
        if (robot.overtakeTimer > 0) {
          robot.overtakeTimer -= dt;
          if (robot.overtakeTimer <= 0) {
            robot.isOvertaking = false;
            robot.speedMultiplier = 1.0;
            if (robot.statusBadge === 'PASS') robot.statusBadge = null;
          }
        }
        // Auto-release bots that were pinned so a faster bot could overtake them
        if (robot._pinnedForOvertake && robot._pinnedTimer !== undefined) {
          robot._pinnedTimer -= dt;
          if (robot._pinnedTimer <= 0) {
            robot._pinnedForOvertake = false;
            robot._pinnedTimer = 0;
            robot.isWaiting = false;
            robot.waitTimer = 0;
            robot.yieldTo = null;
            if (robot.statusBadge === 'YIELD') robot.statusBadge = null;
          }
        }

        // NEW: Distance-based pinning ("bro you wait, I'll leave on my work")
        if (robot._pinnedUntilBotId && !robot.isBackingUp && !robot.isSideStepping) {
            const pinner = AMR_FLEET.find(b => b.id === robot._pinnedUntilBotId);
            // Wait until pinner is out of range (1.85 cells) or pinner is dead/idle
            if (pinner && pinner.state !== 'IDLE_CHARGING' && pinner.state !== 'OUT_OF_CHARGE' && Math.hypot(robot.x - pinner.x, robot.y - pinner.y) < 1.85) {
                robot.isWaiting = true;
                robot._wasWaitingThisFrame = true;
                robot.yieldTo = pinner.id;
                robot.targetSpeed = 0;
                if (!robot.statusBadge || robot.statusBadge === 'WAIT') robot.statusBadge = 'PINNED';
            } else {
                robot._pinnedUntilBotId = null;
                if (robot.statusBadge === 'PINNED') robot.statusBadge = null;
            }
        }


        robot._wasWaitingThisFrame = false;
      }

      // 1.5. Physical Collision & Close Contact Detection
      for (let i = 0; i < AMR_FLEET.length; i++) {
        const A = AMR_FLEET[i];
        if (A.state === 'IDLE_CHARGING' || A.state === 'OUT_OF_CHARGE') continue;

        for (let j = i + 1; j < AMR_FLEET.length; j++) {
          const B = AMR_FLEET[j];
          if (B.state === 'IDLE_CHARGING' || B.state === 'OUT_OF_CHARGE') continue;

          const distAB = Math.hypot(A.x - B.x, A.y - B.y);
          const sameCell = (A.gridX === B.gridX && A.gridY === B.gridY && distAB < 0.45);
          
          if (distAB < 0.85 && window._benchStats) {
             A._benchHits = A._benchHits || new Set();
             if (!A._benchHits.has(B.id)) {
                 window._benchStats.collisions++;
                 A._benchHits.add(B.id);
             }
          } else if (distAB >= 0.85 && A._benchHits && A._benchHits.has(B.id)) {
             A._benchHits.delete(B.id);
          }

          // Physical Collision Condition: Distance < 0.55 cells (actual chassis contact)
          if (distAB < 0.55 || sameCell) {
            A._collidedWith = A._collidedWith || new Set();
            B._collidedWith = B._collidedWith || new Set();

            if (!A._collidedWith.has(B.id)) {
              A._collidedWith.add(B.id);
              B._collidedWith.add(A.id);
              trafficMetrics.totalCollisions = (trafficMetrics.totalCollisions || 0) + 1;
              if (A.logStats) A.logStats.physicalCollisions = (A.logStats.physicalCollisions || 0) + 1;
              if (B.logStats) B.logStats.physicalCollisions = (B.logStats.physicalCollisions || 0) + 1;

              logBotProblem('COLLISION', A.id, {
                peerId: B.id,
                x: Math.round(A.x),
                y: Math.round(A.y),
                severity: 'CRITICAL',
                desc: `Physical collision between <strong>${A.id}</strong> and <strong>${B.id}</strong> at cell (${Math.round(A.x)}, ${Math.round(A.y)}) [Separation: ${distAB.toFixed(2)} cells]. AEB emergency override.`
              });

              COLLISION_SPARKS.push({
                x: (A.x + B.x) / 2,
                y: (A.y + B.y) / 2,
                timer: 1.5,
                maxTimer: 1.5
              });
            }

            // Kinematic bounce separation (clamped strictly to walkable floor cells)
            const overlap = 0.65 - distAB;
            if (overlap > 0) {
              const nx = distAB > 0.01 ? (A.x - B.x) / distAB : 0;
              const ny = distAB > 0.01 ? (A.y - B.y) / distAB : 1;
              const newAx = A.x + nx * (overlap * 0.5);
              const newAy = A.y + ny * (overlap * 0.5);
              const newBx = B.x - nx * (overlap * 0.5);
              const newBy = B.y - ny * (overlap * 0.5);
              if (isWalkable(Math.round(newAx), Math.round(newAy))) { A.x = newAx; A.y = newAy; }
              if (isWalkable(Math.round(newBx), Math.round(newBy))) { B.x = newBx; B.y = newBy; }
            }
          } else if (distAB > 0.85) {
            if (A._collidedWith) A._collidedWith.delete(B.id);
            if (B._collidedWith) B._collidedWith.delete(A.id);
          }
        }
      }

      if (typeof Traffic === 'undefined' || Traffic.TRAFFIC_MODE === 'legacy') {
          // =========================================================================
          // DEADLOCK RESOLVER (User Specification):
          // if (2 or more bots should be moving but not moving due to collision prevention) {
          //     the one with the highest, 2nd highest.... battery stops completely and the lowest moves.
          //     once it moves away. then 2nd highest moves, then highest....
          // }
          // =========================================================================
          for (let i = 0; i < AMR_FLEET.length; i++) {
            const A = AMR_FLEET[i];
            if (A.state === 'IDLE_CHARGING' || A.state === 'OUT_OF_CHARGE' || A.state === 'LOADING_INBOUND' || A.state === 'IDLE') continue;
            if (!A.path || A.path.length === 0 || A.pathIndex >= A.path.length) continue;

            for (let j = i + 1; j < AMR_FLEET.length; j++) {
              const B = AMR_FLEET[j];
              if (B.state === 'IDLE_CHARGING' || B.state === 'OUT_OF_CHARGE' || B.state === 'LOADING_INBOUND' || B.state === 'IDLE') continue;
              if (!B.path || B.path.length === 0 || B.pathIndex >= B.path.length) continue;

              const distAB = Math.hypot(A.x - B.x, A.y - B.y);
              if (distAB > 1.8) continue;

              // Check if an escape maneuver is already in flight between this exact pair
              const aEscapingFromB = (A.isBackingUp || A.isSideStepping) && (A.escapePartnerId === B.id || B.yieldTo === A.id);
              const bEscapingFromA = (B.isBackingUp || B.isSideStepping) && (B.escapePartnerId === A.id || A.yieldTo === B.id);

              if (aEscapingFromB) {
                // A is already executing an escape maneuver from B; B holds position and waits
                B._wasWaitingThisFrame = true;
                B.isWaiting = true;
                B.yieldTo = A.id;
                B.currentSpeed = 0;
                B.statusBadge = 'WAIT';
                continue;
              }
              if (bEscapingFromA) {
                // B is already executing an escape maneuver from A; A holds position and waits
                A._wasWaitingThisFrame = true;
                A.isWaiting = true;
                A.yieldTo = B.id;
                A.currentSpeed = 0;
                A.statusBadge = 'WAIT';
                continue;
              }

              // Check if bots should be moving but are NOT MOVING due to collision prevention
              const aNotMoving = A.isWaiting || A.currentSpeed < 0.05 || (A.waitTimer && A.waitTimer > 0.05);
              const bNotMoving = B.isWaiting || B.currentSpeed < 0.05 || (B.waitTimer && B.waitTimer > 0.05);
              const mutualBlock = (A.yieldTo === B.id && B.yieldTo === A.id);
              const kissing = distAB < 0.85; // Shrunk from 1.15 to allow adjacent passing

              if ((aNotMoving && bNotMoving) || mutualBlock || kissing) {
                // Mutual deadlock / collision stall: Lower battery bot moves!
                const aHasLowerBatt = isHigherPriority(A, B);
                const winner = aHasLowerBatt ? A : B;
                const loser = aHasLowerBatt ? B : A;

                // User Specification: When blocked, make bots try to move back to previous box,
                // and only the lowest charging moves!
                // First allow pausing: if waitTimer > 1.2s or face-to-face, execute back-up to previous box!
                if ((loser.waitTimer || 0) > 1.2 || distAB < 1.15 || mutualBlock) {
                  const backedUp = attemptMoveBackToPreviousBox(loser, winner);
                  if (!backedUp) {
                    executeSideStepYield(loser, winner);
                  }
                  // While loser is executing back-up or side-step, winner pauses until separation >= 1.2
                  winner._wasWaitingThisFrame = true;
                  winner.isWaiting = true;
                  winner.yieldTo = loser.id;
                  winner.escapePartnerId = loser.id;
                  loser.escapePartnerId = winner.id;
                  winner.currentSpeed = 0;
                  winner.waitTimer = (winner.waitTimer || 0) + dt;
                  winner.statusBadge = 'WAIT';
                  onRobotJamStart(winner, loser.id, 'WAITING_FOR_ESCAPE_MANEUVER');
                } else {
                  // Higher-battery bot stops completely and pauses patiently
                  loser.isWaiting = true;
                  loser._wasWaitingThisFrame = true;
                  loser.currentSpeed = 0;
                  loser.yieldTo = winner.id;
                  loser.statusBadge = 'WAIT';
                  loser.waitTimer = (loser.waitTimer || 0) + dt;
                  onRobotJamStart(loser, winner.id, 'HEAD_ON_DEADLOCK_PRIORITY_PAUSE');

                  // Lowest charging bot moves forward!
                  winner.isWaiting = false;
                  winner._wasWaitingThisFrame = false;
                  winner.yieldTo = null;
                  if (winner.statusBadge === 'WAIT') winner.statusBadge = null;
                  onRobotJamEnd(winner, 'RESUMED_NORMAL');
                }
              }
            }
          }
      }

      if (typeof Traffic === 'undefined' || Traffic.TRAFFIC_MODE === 'legacy') {
          // =========================================================================
          // 1.8. INNER SIMULATION TRAFFIC MONITOR & PROACTIVE PATH DISCARD
          // "simulation run inside simulation that checks for traffic problems.
          //  when to discard a path : if a bot stops or not moving in the speed
          //  it is supposed to, then compute new path."
          // =========================================================================
          for (const robot of AMR_FLEET) {
            if (robot.state === 'IDLE_CHARGING' || robot.state === 'OUT_OF_CHARGE' || robot.state === 'LOADING_INBOUND' || robot.state === 'IDLE') continue;
            if (robot.isBackingUp || robot.isSideStepping || robot._pinnedUntilBotId) continue;
            if (!robot.path || robot.path.length === 0 || robot.pathIndex >= robot.path.length) continue;

            const dest = robot.path[robot.path.length - 1];
            if (!dest || Math.hypot(robot.gridX - dest.x, robot.gridY - dest.y) <= 1) continue;

            const nominalSpeed = baseSpeed * (robot.speedMultiplier || 1.0) * (robot.payloadDamping || 1.0);
            const actualSpeed = (robot.currentSpeed !== undefined && robot.currentSpeed !== null) ? robot.currentSpeed : nominalSpeed;

            // Discard trigger A: bot stops or not moving in the speed it is supposed to
            const isBotStopped = robot.isWaiting || actualSpeed < 0.1 || (robot.waitTimer && robot.waitTimer > 0.25);
            const isSpeedDeficit = (actualSpeed < nominalSpeed * 0.70 && !robot.isWaiting);

            // Discard trigger B: inner simulation predicts conflict on current path ahead
            const simPrediction = runInnerTrafficSimulation(robot, null, 5.0);
            const hasProjectedJam = simPrediction.hasTrafficProblem && simPrediction.timeToConflict <= 4.0;

            let shouldRepath = false;
            
            if (hasProjectedJam) {
              const peer = robot.localPeerTable ? robot.localPeerTable.get(simPrediction.blockerId) : null;
              if (peer) {
                const myPathTime = robot.pathTimestamp || 0;
                const peerPathTime = peer.path_timestamp || 0;
                
                // "The first to choose path will go with its path. The second will respect..."
                const iAmFirstChooser = (myPathTime < peerPathTime) || (Math.abs(myPathTime - peerPathTime) < 0.05 && robot.id < peer.robot_id);
                
                if (!iAmFirstChooser) {
                  // I am the second chooser. I must respect the 1st chooser's path and reroute around them.
                  shouldRepath = true;
                } else {
                  // I am the first chooser! I keep my path. 
                  // I will go parallelly or slow down behind them, but I will NOT discard my path.
                  shouldRepath = false;
                  
                  // If moving too fast into the block, slow down instead of stopping completely
                  if (actualSpeed > nominalSpeed * 0.5) {
                      robot.currentSpeed = nominalSpeed * 0.5; 
                  }
                }
              } else {
                shouldRepath = true; // Peer not in mesh, default to avoiding
              }
            } else if (isBotStopped && robot.waitTimer > 1.5) {
              // If genuinely stuck for 1.5s+ with no projected jam (e.g. physical obstacle), try repathing
              shouldRepath = true;
            }

            if (shouldRepath) {
              const timeSinceRepath = totalSimSeconds - (robot._lastInnerSimRepathTime || -999);
              // 1.0s cooldown to prevent rapid-fire path discarding (SHM)
              if (timeSinceRepath >= 1.0) {
                const repathed = solveTrafficPathViaInnerSim(robot, dest, simPrediction.blocker, simPrediction.conflictCell);
                if (repathed) {
                  robot._lastInnerSimRepathTime = totalSimSeconds;
                }
              }
            }
          }
      }

      if (typeof Traffic === 'undefined' || Traffic.TRAFFIC_MODE === 'legacy') {
          // 2. Multi-Agent Conflict Detection, Overtaking & Right-of-Way Resolution
          for (let i = 0; i < AMR_FLEET.length; i++) {
            const A = AMR_FLEET[i];
            if (A.state === 'IDLE_CHARGING' || A.state === 'LOADING_INBOUND' || A.state === 'OUT_OF_CHARGE' || !A.path || A.path.length === 0 || A.pathIndex >= A.path.length) continue;
            if (A.isBackingUp || A.isSideStepping) continue; // Dedicated escape maneuver in progress: do not stall!

            const targetA = A.path[A.pathIndex];
            const urgA = calculateRobotUrgency(A);
            const speedA = (A.currentSpeed !== undefined && A.currentSpeed !== null) ? A.currentSpeed : (baseSpeed * (A.speedMultiplier || 1.0) * (A.payloadDamping || 1.0));

            // Perception Realism: Robot A reacts only to confirmed peer obstacles within its sensor horizon
            const perceivedPeerBots = (A.perception && A.perception.confirmedObstacles)
              ? A.perception.confirmedObstacles.filter(o => o.type === 'ROBOT').map(o => o.ref)
              : [];

            for (const B of perceivedPeerBots) {
              if (!B || B.id === A.id || B.state === 'IDLE_CHARGING' || B.state === 'OUT_OF_CHARGE') continue;

              const distAB = Math.hypot(A.x - B.x, A.y - B.y);
              if (distAB > 4.2) continue; // Long range: no immediate conflict

              const urgB = calculateRobotUrgency(B);
              const speedB = (B.currentSpeed !== undefined && B.currentSpeed !== null) ? B.currentSpeed : (baseSpeed * (B.speedMultiplier || 1.0) * (B.payloadDamping || 1.0));
              const targetB = (B.path && B.pathIndex < B.path.length) ? B.path[B.pathIndex] : null;

              // Check if B is ahead of A in A's planned trajectory (Trailing Encounter)
              const lookaheadSteps = Math.min(4, A.path.length - A.pathIndex);
              const aheadPath = A.path.slice(A.pathIndex, A.pathIndex + lookaheadSteps);
              const bInAHeadPath = aheadPath.some(pt => Math.hypot(B.x - pt.x, B.y - pt.y) < 1.15);
              const isTrailingB = bInAHeadPath || (distAB < 2.8 && Math.abs(A.heading - B.heading) < 1.2);

              // =========================================================================
              // CASE 1: PROACTIVE OVERTAKE OF SLOW BOTS BY FAST BOTS
              // =========================================================================
              if (isTrailingB && distAB < 3.2) {
                // A bot is considered slower if stopped/waiting, speed < 92% of A, or carrying heavier payload
                const isBSlower = B.isWaiting || (speedB < speedA * 0.92) || (A.payloadDamping > B.payloadDamping + 0.08) || (urgA > urgB + 5) || (B.waitTimer > 0);

                if (isBSlower && !A.isOvertaking) {
                  const took = attemptOvertake(A, B, urgA, urgB);
                  if (took) {
                    A.isWaiting = false;
                    A._wasWaitingThisFrame = false;
                    break; // Successfully branched into parallel passing lane!
                  }
                }

                // Adaptive Cruise Control (ACC): smoothly slow to match lead vehicle speed
                if (distAB < 1.6) {
                  A.currentSpeed = Math.min(A.currentSpeed, Math.max(0, speedB * 0.95));
                }

                // Chain-jam guard: only fully stop A if B is genuinely idle/stuck (not merely slow-moving).
                // A bot that is ITSELF waiting in a queue (B.isWaiting) propagates the chain;
                // we check B's actual speed rather than its isWaiting flag to break cascades.
                const bGenuinelyStopped = (B.isWaiting && B.waitTimer > 0.3) || speedB < 0.05;
                if (distAB < 1.0 || (bGenuinelyStopped && distAB < 1.3)) {
                  // Hold position at safe trailing distance behind stopped lead vehicle
                  A._wasWaitingThisFrame = true;
                  A.isWaiting = true;
                  A.yieldTo = B.id;
                  A.waitTimer += dt;
                  A.statusBadge = 'WAIT';
                  A.currentSpeed = 0;
                  onRobotJamStart(A, B.id, 'TRAILING_TRAFFIC_CONGESTION');

                  // Detect if blocker is doing active rack work (shelving/picking/loading at a rack).
                  // These are KNOWN long-duration stops — reroute quickly to prevent queue buildup.
                  const bAtRackWork = (
                    (B.state === 'CARRYING_TO_RACK' || B.state === 'ORDER_PICKING' || B.state === 'LOADING_INBOUND') &&
                    (!B.path || B.path.length === 0 || B.pathIndex >= B.path.length)
                  );
                  const rerouteThreshold = bAtRackWork ? 0.3 : 1.2;

                  // Proactive multi-stage inner simulation reroute
                  if (A.waitTimer > rerouteThreshold) {
                    const repathed = solveTrafficPathViaInnerSim(A, null, B, { x: B.gridX, y: B.gridY });
                    if (repathed) {
                      A.isWaiting = false;
                      A._wasWaitingThisFrame = false;
                      break;
                    }
                  }
                  break;
                }
                continue;
              }


              // =========================================================================
              // CASE 2: CROSSING PATHS, HEAD-ON & INTERSECTION CONFLICTS
              // =========================================================================
              const bAtTargetA = targetA && Math.hypot(B.x - targetA.x, B.y - targetA.y) < 0.85;
              const bAlsoTargetingA = targetB && targetA && targetB.x === targetA.x && targetB.y === targetA.y;
              const headOn = targetB && targetB.x === A.gridX && targetB.y === A.gridY && targetA.x === B.gridX && targetA.y === B.gridY;
              const isConflict = bAtTargetA || (bAlsoTargetingA && distAB < 2.0) || headOn || distAB < 1.25;

              if (isConflict) {
                trafficMetrics.collisionsPrevented++;

                // Strict deterministic total ordering: who yields?
                if (!isHigherPriority(A, B)) {
                  A._wasWaitingThisFrame = true;
                  A.isWaiting = true;
                  A.yieldTo = B.id;
                  A.waitTimer += dt;
                  A.statusBadge = 'WAIT';
                  A.currentSpeed = 0;

                  // Apply physical pin: A stays halted until B is out of range
                  A._pinnedUntilBotId = B.id;

                  if (A.logStats) A.logStats.totalRightOfWayYields++;
                  onRobotJamStart(A, B.id, 'RIGHT_OF_WAY_YIELD');

                  // Throttled yield terminal log
                  const now = Date.now();
                  if (now - (A.lastYieldLogTime || 0) > 4000) {
                    A.lastYieldLogTime = now;
                    trafficMetrics.totalYields++;
                    const bCargoDesc = B.orderBox ? `Consolidated Order (${B.orderBox.items.length}/${B.orderBox.totalItems})` : (B.isLoadedYellow ? `Inbound Load (${B.carriedParcels.length} pkgs)` : 'Higher Priority');
                    logTerminal('YIELD', 'tag-yield', `⚠️ <strong>${A.id}</strong> (Urgency ${urgA}%) yielding right-of-way to <strong>${B.id}</strong> (Urgency ${urgB}%, ${bCargoDesc})`);
                    updateHudStats();
                  }

                  // Dynamic Detour Rerouting via Inner Simulation if waiting persists
                  const bAtRackWork2 = (
                    (B.state === 'CARRYING_TO_RACK' || B.state === 'ORDER_PICKING' || B.state === 'LOADING_INBOUND') &&
                    (!B.path || B.path.length === 0 || B.pathIndex >= B.path.length)
                  );
                  const yieldRerouteThreshold = bAtRackWork2 ? 0.4 : 2.0;
                  if (A.waitTimer > yieldRerouteThreshold) {
                    const repathed = solveTrafficPathViaInnerSim(A, null, B, { x: B.gridX, y: B.gridY });
                    if (repathed) {
                      A.isWaiting = false;
                      A._wasWaitingThisFrame = false;
                      break;
                    }
                  }
                  break;
                } else {
                  // Higher priority robot A: Autonomous Emergency Braking (AEB)
                  // If B is in front or backing up, A halts cleanly at safe buffer distance without contacting B!
                  if (B.isBackingUp || B.isSideStepping) {
                    A._wasWaitingThisFrame = true;
                    A.isWaiting = true;
                    A.yieldTo = B.id;
                    A.statusBadge = 'WAIT';
                    A.currentSpeed = 0;
                    onRobotJamStart(A, B.id, 'WAITING_FOR_PEER_ESCAPE');
                  } else if (distAB < 0.85) {
                    A.currentSpeed = 0;
                  }
                }
              }
            }
          }
      }

      // 3. Kinematic motion integration with Autonomous Emergency Braking (AEB)
      for (const robot of AMR_FLEET) {
        if (robot.state === 'LOADING_INBOUND') {
          // Stationary at dock during loading animation
          continue;
        }

        // Active Staging Queue Poller: If robot is waiting at a staging cell for a terminal (rack, dock, charger)
        if (robot.isStagingWait && robot.pendingTargetTerminal) {
          const tgt = robot.pendingTargetTerminal;
          const key = getTerminalCellKey(tgt.x, tgt.y);
          const claimant = TERMINAL_OCCUPANCY_CLAIMS.get(key);
          const isOcc = AMR_FLEET.some(o => o.id !== robot.id && Math.hypot(o.x - tgt.x, o.y - tgt.y) < 0.85);
          const queue = TERMINAL_STAGING_QUEUES.get(key);
          const isMyTurn = !queue || queue.length === 0 || queue[0] === robot.id;
          const seg = typeof getNarrowAisleSegment === 'function' ? getNarrowAisleSegment(tgt.x, tgt.y) : null;
          const isAisleBusy = seg && typeof getNarrowAisleOccupant === 'function' ? (getNarrowAisleOccupant(seg, robot.id) !== null) : false;

          if ((!claimant || claimant === robot.id) && !isOcc && isMyTurn && !isAisleBusy) {
            // Target terminal is free and it's our turn! Advance from staging into target cell!
            if (queue && queue[0] === robot.id) queue.shift();
            claimTerminalDestination(robot.id, tgt.x, tgt.y);
            robot.isStagingWait = false;
            robot.pendingTargetTerminal = null;
            robot.isWaiting = false;
            robot._wasWaitingThisFrame = false;
            robot.waitTimer = 0;
            if (robot.statusBadge === 'STAGE') robot.statusBadge = null;
            const advancePath = findPath(robot.gridX, robot.gridY, tgt.x, tgt.y, null, robot.id);
            if (advancePath && advancePath.length > 0) {
              setRobotPath(robot, advancePath);
            } else {
              onRobotReachedDestination(robot);
            }
          }
        }

        // If robot was backed up or side-stepped and path is now clear, resume saved destination
        if (robot.savedDest && (robot.isWaiting || !robot.path || robot.path.length === 0 || robot.pathIndex >= robot.path.length)) {
          let clearAhead = true;
          for (const other of AMR_FLEET) {
            if (other.id === robot.id || other.state === 'IDLE_CHARGING' || other.state === 'OUT_OF_CHARGE') continue;
            if (Math.hypot(other.x - robot.x, other.y - robot.y) < 1.35) {
              clearAhead = false;
              break;
            }
          }
          if (clearAhead) {
            if (Math.hypot(robot.gridX - robot.savedDest.x, robot.gridY - robot.savedDest.y) < 0.5) {
              robot.isWaiting = false;
              robot.statusBadge = null;
              robot.savedDest = null;
              robot.escapePartnerId = null;
              onRobotReachedDestination(robot);
            } else {
              const resumePath = findPath(robot.gridX, robot.gridY, robot.savedDest.x, robot.savedDest.y);
              if (resumePath && resumePath.length > 0) {
                setRobotPath(robot, resumePath);
                robot.isWaiting = false;
                robot.statusBadge = null;
                robot.savedDest = null;
                robot.escapePartnerId = null;
              }
            }
          }
        }

        if (!robot._wasWaitingThisFrame) {
          robot._clearFrames = (robot._clearFrames || 0) + 1;
          if (robot._clearFrames >= 3) {
            if (robot.isWaiting) {
              robot.isWaiting = false;
              robot.yieldTo = null;
              robot.escapePartnerId = null;
              if (robot.statusBadge === 'WAIT') robot.statusBadge = null;
              robot.waitTimer = 0;
              onRobotJamEnd(robot, 'RESUMED_NORMAL');
            }
          }
        } else {
          robot._clearFrames = 0;
        }

        // =========================================================================
        // KINEMATICS & PHYSICAL REALISM MODEL (Payload Mass, Acceleration, Turns)
        // 1. Dynamic Payload Mass Scaling (Tare 145kg + Cargo kg)
        // 2. Continuous Acceleration / Deceleration Profiles (Trapezoidal Curves)
        // 3. Finite Turning Radius & Physical Rotation Time at Corners
        // 4. Sudden Braking Mechanics & Collision Avoidance Dissipation
        // =========================================================================

        let cargoWeight = 0;
        if (robot.orderBox) {
          cargoWeight = robot.orderBox.totalWeight || 0;
          if (cargoWeight === 0 && robot.orderBox.items) {
            cargoWeight = robot.orderBox.items.reduce((sum, it) => sum + (parseFloat(it.weight) || 3), 0);
          }
        } else if (robot.carriedParcels && robot.carriedParcels.length > 0) {
          cargoWeight = robot.carriedParcels.reduce((sum, p) => sum + (parseFloat(p.weight) || 3), 0);
        } else if (robot.cargo) {
          cargoWeight = parseFloat(robot.cargo.weight) || 0;
        }

        const TARE_MASS_KG = 145.0; // Standard AMR chassis tare mass (kg)
        const totalMassKg = TARE_MASS_KG + cargoWeight;
        robot.payloadWeight = cargoWeight;
        robot.totalMassKg = totalMassKg;

        // Kinematic Speed Damping Factor (Continuous Motor Work Limits):
        const payloadDamping = Math.max(0.65, 1.0 - (cargoWeight / 55.0) * 0.28);
        robot.payloadDamping = payloadDamping;

        // Physical Acceleration & Deceleration Limits (F = M * a):
        const maxAccel = 2.4 * (TARE_MASS_KG / totalMassKg); // cells/s² (~1.9 m/s² unladen)
        const maxDecel = 3.2 * Math.pow(TARE_MASS_KG / totalMassKg, 0.6); // cells/s² normal service braking
        const maxEmergencyDecel = 7.5 * Math.pow(TARE_MASS_KG / totalMassKg, 0.5); // cells/s² AEB stop
        const maxAngularVelocity = 3.8 * Math.sqrt(TARE_MASS_KG / totalMassKg); // rad/s corner rotation

        let cruiseSpeed = baseSpeed * (robot.speedMultiplier || 1.0) * payloadDamping;

        // =========================================================================
        // DYNAMIC SPEED ZONES & INTERSECTIONS
        // =========================================================================
        let isIntersection = false;
        let isBufferZone = false;
        
        const rx = robot.gridX;
        const ry = robot.gridY;
        
        // Proper intersection: We are on a horizontal highway AND in a column that has a rack aisle
        const isHighway = (ry >= 2 && ry <= 4) || (ry >= 23 && ry <= 26) || (ry >= 45 && ry <= 47);
        const isAisleCol = typeof NARROW_AISLE_COLS !== 'undefined' ? NARROW_AISLE_COLS.has(rx) : false;
        isIntersection = isHighway && isAisleCol;
        
        // Buffer Zone check
        if (typeof mapData !== 'undefined' && mapData.grid) {
            const w = mapData.width, h = mapData.height;
            isBufferZone = (rx > 0 && mapData.grid[rx-1][ry] === 1) || 
                           (rx < w-1 && mapData.grid[rx+1][ry] === 1) || 
                           (ry > 0 && mapData.grid[rx][ry-1] === 1) || 
                           (ry < h-1 && mapData.grid[rx][ry+1] === 1);
        }

        if (isIntersection) {
            cruiseSpeed *= 0.50; // Slow down ONLY at cross-traffic junctions
        } else if (isBufferZone) {
            cruiseSpeed *= 0.60; 
        }

        // =========================================================================
        // ISO 3691-4 / ANSI RIA R15.08 Speed & Separation Monitoring (SSM)
        // Dynamic Protective Fields: Progressive Slowdown + Safe Hysteresis Halt
        // =========================================================================
        let humanSlowdownFactor = 1.0;
        let inHumanProtectiveStop = false;
        let closestHumanDist = Infinity;
        let closestHuman = null;

        if ((typeof humansEnabled === 'undefined' || humansEnabled) && typeof HUMAN_WORKERS !== 'undefined' && HUMAN_WORKERS && HUMAN_WORKERS.length > 0 && robot.perception && robot.perception.confirmedObstacles) {
          const perceivedHumans = robot.perception.confirmedObstacles.filter(o => o.type === 'HUMAN');
          for (const track of perceivedHumans) {
            const h = track.ref;
            if (!h) continue;
            const distH = track.dist;
            if (distH < closestHumanDist) {
              closestHumanDist = distH;
              closestHuman = h;
            }

            // Directional approach cone: check if human is in robot's travel direction
            let relAngle = Math.abs(track.bearing);
            while (relAngle > Math.PI) relAngle = Math.abs(relAngle - 2 * Math.PI);
            const inForwardTravelCone = relAngle < (Math.PI * 0.60); // 108 degree forward cone

            const stopRadius = inForwardTravelCone ? 2.2 : 1.4;
            const resumeRadius = stopRadius + 0.6; // Hysteresis buffer (2.8c)
            const wasHalted = (robot.humanYieldPartnerId === h.id);
            const activeHaltDist = wasHalted ? resumeRadius : stopRadius;

            if (distH < activeHaltDist) {
              inHumanProtectiveStop = true;
              robot.humanYieldPartnerId = h.id;
              break;
            }

            // Caution Slowdown Zone (stopRadius <= dist <= 4.5 cells)
            const warnRadius = inForwardTravelCone ? 4.5 : 2.8;
            if (distH < warnRadius) {
              const ramp = Math.max(0, Math.min(1.0, (distH - stopRadius) / (warnRadius - stopRadius)));
              const factor = 0.20 + (0.80 * ramp);
              if (factor < humanSlowdownFactor) {
                humanSlowdownFactor = factor;
              }
            }
          }

          if (inHumanProtectiveStop) {
            cruiseSpeed = 0;
            robot.isWaiting = true;
            robot._wasWaitingThisFrame = true;
            robot.statusBadge = 'YIELD HUMAN';
            robot.waitTimer = (robot.waitTimer || 0) + dt;
            if (typeof trafficMetrics !== 'undefined') trafficMetrics.humanSafetyStops = (trafficMetrics.humanSafetyStops || 0) + 1;
            if (closestHuman) closestHuman.totalYieldsCaused = (closestHuman.totalYieldsCaused || 0) + 1;
            if (!robot._humanStopLogged) {
              robot._humanStopLogged = true;
              logTerminal('SAFETY', 'tag-yield', `👷 <strong>ISO 3691-4 Protective Stop</strong>: <strong>${robot.id}</strong> yielding to <strong>${closestHuman ? closestHuman.name : 'Floor Worker'}</strong> (Distance: ${closestHumanDist.toFixed(2)}c). Clean zero-contact.`);
            }
          } else {
            robot.humanYieldPartnerId = null;
            robot._humanStopLogged = false;
            if (humanSlowdownFactor < 0.98) {
              cruiseSpeed *= humanSlowdownFactor;
              if (typeof trafficMetrics !== 'undefined') trafficMetrics.humanSlowdowns = (trafficMetrics.humanSlowdowns || 0) + 1;
              if (!robot.statusBadge || robot.statusBadge === 'WAIT' || robot.statusBadge.startsWith('SLOW:')) {
                robot.statusBadge = `SLOW: ${Math.round(humanSlowdownFactor * 100)}%`;
              }
            } else if (robot.statusBadge && (robot.statusBadge.startsWith('SLOW:') || robot.statusBadge === 'YIELD HUMAN')) {
              robot.statusBadge = null;
            }
          }
        } else if (robot.statusBadge === 'YIELD HUMAN' || (robot.statusBadge && robot.statusBadge.startsWith('SLOW:'))) {
          robot.statusBadge = null;
          robot.humanYieldPartnerId = null;
          robot._humanStopLogged = false;
        }

        if (robot.isWaiting) {
          // Sharp deceleration for waiting / yield stop
          robot.targetSpeed = 0;
          const curV = robot.currentSpeed || 0;
          if (curV > 0.01) {
            const deltaV = Math.min(curV, maxEmergencyDecel * dt);
            robot.currentSpeed = curV - deltaV;
            robot.acceleration = -deltaV / dt;
            robot.isBraking = true;
            robot.brakeIntensity = Math.min(1.0, Math.abs(robot.acceleration) / maxEmergencyDecel);
            robot.brakeLightTimer = 0.45;
          } else {
            robot.currentSpeed = 0;
            robot.acceleration = 0;
          }

          // Preserve safety buffer: smoothly settle squarely into cell center
          let canSnap = true;
          for (const other of AMR_FLEET) {
            if (other.id === robot.id || other.state === 'IDLE_CHARGING' || other.state === 'OUT_OF_CHARGE') continue;
            const curD = Math.hypot(robot.x - other.x, robot.y - other.y);
            const targetD = Math.hypot(robot.gridX - other.x, robot.gridY - other.y);
            if ((curD < 1.35 && targetD < curD) || targetD < 0.75) {
              canSnap = false;
              break;
            }
          }
          if (canSnap) {
            const snapRate = Math.min(1.0, dt * 8.0);
            robot.x += (robot.gridX - robot.x) * snapRate;
            robot.y += (robot.gridY - robot.y) * snapRate;
            if (Math.abs(robot.x - robot.gridX) < 0.005) robot.x = robot.gridX;
            if (Math.abs(robot.y - robot.gridY) < 0.005) robot.y = robot.gridY;
          }
          if (!robot._wasBraking && robot.isBraking) {
            robot.totalBrakingEvents = (robot.totalBrakingEvents || 0) + 1;
            if (robot.logStats) robot.logStats.totalBrakingEvents = (robot.logStats.totalBrakingEvents || 0) + 1;
          }
          robot._wasBraking = robot.isBraking;
          robot._wasTurning = false;
          robot._wasWaitingThisFrame = true;
          robot._safeStep = 0;
          robot._isStationaryThisFrame = true;
          continue;
        }

        if (!robot.path || robot.path.length === 0 || robot.pathIndex >= robot.path.length) {
          robot.targetSpeed = 0;
          const curV = robot.currentSpeed || 0;
          if (curV > 0.01) {
            const deltaV = Math.min(curV, maxDecel * dt);
            robot.currentSpeed = curV - deltaV;
            robot.acceleration = -deltaV / dt;
          } else {
            robot.currentSpeed = 0;
            robot.acceleration = 0;
          }

          if (robot.savedDest) {
            robot._safeStep = 0;
            robot._isStationaryThisFrame = true;
            continue; // Wait for corridor to clear to resume journey
          }
          if (robot.state === 'IDLE' || robot.state === 'IDLE_CHARGING') {
            const snapRate = Math.min(1.0, dt * 8.0);
            robot.x += (robot.gridX - robot.x) * snapRate;
            robot.y += (robot.gridY - robot.y) * snapRate;
            if (Math.abs(robot.x - robot.gridX) < 0.005) robot.x = robot.gridX;
            if (Math.abs(robot.y - robot.gridY) < 0.005) robot.y = robot.gridY;
            robot._safeStep = 0;
            robot._isStationaryThisFrame = true;
            continue;
          }
          // Arrived at destination waypoint!
          onRobotReachedDestination(robot);
          robot._safeStep = 0;
          robot._isStationaryThisFrame = true;
          continue;
        }

        const targetCell = robot.path[robot.pathIndex];
        const nextCell = (robot.pathIndex + 1 < robot.path.length) ? robot.path[robot.pathIndex + 1] : null;

        // 45° Corner Fillet Curve Determination & Approach Deceleration
        let aimX = targetCell.x;
        let aimY = targetCell.y;
        let isCornerTurn = false;
        const distToTarget = Math.hypot(targetCell.x - robot.x, targetCell.y - robot.y);

        if (nextCell) {
          const inDx = targetCell.x - robot.gridX;
          const inDy = targetCell.y - robot.gridY;
          const outDx = nextCell.x - targetCell.x;
          const outDy = nextCell.y - targetCell.y;
          // Orthogonal corner turn detected (perpendicular direction change)
          isCornerTurn = (inDx !== 0 && outDy !== 0) || (inDy !== 0 && outDx !== 0);

          if (isCornerTurn) {
            if (distToTarget < 0.40) {
              // Smooth 45° beveled corner curve: blend aim point towards exit lane
              const blend = Math.max(0, Math.min(1.0, (0.40 - distToTarget) / 0.40));
              aimX = targetCell.x + outDx * 0.32 * blend;
              aimY = targetCell.y + outDy * 0.32 * blend;
            }
            // Decelerate to corner entry speed before the orthogonal turn
            if (distToTarget < 0.65) {
              cruiseSpeed = Math.min(cruiseSpeed, 1.15 * payloadDamping);
            }
          }
        }

        // Terminal approach deceleration: smooth S-curve slowdown into destination
        if (robot.path && robot.path.length > 0 && robot.pathIndex < robot.path.length) {
          let distToEnd = distToTarget;
          for (let k = robot.pathIndex + 1; k < robot.path.length; k++) {
            distToEnd += Math.hypot(robot.path[k].x - robot.path[k - 1].x, robot.path[k].y - robot.path[k - 1].y);
          }
          if (distToEnd < 2.2) {
            const approachLimit = Math.sqrt(2 * maxDecel * distToEnd + 0.12);
            cruiseSpeed = Math.min(cruiseSpeed, Math.max(0.45, approachLimit));
          }
        }

        // Acceleration / Deceleration Curve Application:
        let desiredSpeed = cruiseSpeed;
        robot.targetSpeed = desiredSpeed;

        let curSpeed = robot.currentSpeed;
        if (curSpeed === undefined || curSpeed === null) {
          curSpeed = desiredSpeed;
        }

        let accel = 0;
        if (desiredSpeed > curSpeed) {
          const deltaV = Math.min(desiredSpeed - curSpeed, maxAccel * dt);
          curSpeed += deltaV;
          accel = deltaV / dt;
          robot.isBraking = false;
          robot.brakeIntensity = 0;
        } else if (desiredSpeed < curSpeed) {
          const deltaV = Math.min(curSpeed - desiredSpeed, maxDecel * dt);
          curSpeed -= deltaV;
          accel = -deltaV / dt;
          if (accel < -1.8) {
            robot.isBraking = true;
            robot.brakeIntensity = Math.min(1.0, Math.abs(accel) / maxEmergencyDecel);
            robot.brakeLightTimer = 0.45;
          } else {
            robot.isBraking = false;
            robot.brakeIntensity = 0;
          }
        } else {
          accel = 0;
          robot.isBraking = false;
          robot.brakeIntensity = 0;
        }

        robot.currentSpeed = curSpeed;
        robot.acceleration = accel;
        if (robot.brakeLightTimer > 0) robot.brakeLightTimer = Math.max(0, robot.brakeLightTimer - dt);

        const dx = aimX - robot.x;
        const dy = aimY - robot.y;
        const dist = Math.hypot(dx, dy);

        // Heading rotation with finite angular velocity & physical corner rotation time
        let angularVel = 0;
        if (dist > 0.001) {
          const targetHeading = Math.atan2(dy, dx);
          let diff = targetHeading - robot.heading;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;

          if (Math.abs(diff) > 0.035) {
            robot.isTurning = true;
            robot.turnIndicatorTimer = 0.35;
            robot.turnDirection = diff > 0 ? 'LEFT' : 'RIGHT';
            const stepAngle = Math.sign(diff) * Math.min(Math.abs(diff), maxAngularVelocity * dt);
            robot.heading += stepAngle;
            angularVel = stepAngle / dt;
            while (robot.heading < -Math.PI) robot.heading += Math.PI * 2;
            while (robot.heading > Math.PI) robot.heading -= Math.PI * 2;

            // Forward speed gating during pivot: prevents skidding sideways before heading aligns
            if (Math.abs(diff) > 0.45) {
              curSpeed = Math.min(curSpeed, 0.40 * payloadDamping);
              robot.currentSpeed = curSpeed;
            }
          } else {
            robot.isTurning = false;
            robot.turnDirection = null;
          }
        }
        robot.angularVelocity = angularVel;
        if (robot.turnIndicatorTimer > 0) robot.turnIndicatorTimer = Math.max(0, robot.turnIndicatorTimer - dt);

        if (!robot._wasBraking && robot.isBraking) {
          robot.totalBrakingEvents = (robot.totalBrakingEvents || 0) + 1;
          if (robot.logStats) robot.logStats.totalBrakingEvents = (robot.logStats.totalBrakingEvents || 0) + 1;
        }
        robot._wasBraking = robot.isBraking;

        if (!robot._wasTurning && robot.isTurning) {
          robot.totalCornerRotations = (robot.totalCornerRotations || 0) + 1;
          if (robot.logStats) robot.logStats.totalCornerRotations = (robot.logStats.totalCornerRotations || 0) + 1;
        }
        robot._wasTurning = robot.isTurning;

        // Lane Centerline Lock: pull lateral drift back to the aisle center
        if (!isCornerTurn) {
          const moveDx = targetCell.x - robot.gridX;
          const moveDy = targetCell.y - robot.gridY;
          const lateralRate = Math.min(1.0, dt * 10.0);
          if (moveDx !== 0 && moveDy === 0) {
            robot.y += (targetCell.y - robot.y) * lateralRate;
          } else if (moveDy !== 0 && moveDx === 0) {
            robot.x += (targetCell.x - robot.x) * lateralRate;
          }
        }

        const nominalStep = curSpeed * dt;
        const desiredStep = Math.min(nominalStep, dist);
        robot._aimDx = dist > 0.0001 ? dx / dist : 0;
        robot._aimDy = dist > 0.0001 ? dy / dist : 0;
        robot._distToAim = dist;
        robot._safeStep = desiredStep;
        robot._isStationaryThisFrame = (desiredStep <= 0.0001 && curSpeed <= 0.001);
      }

      if (typeof Traffic === 'undefined' || Traffic.TRAFFIC_MODE === 'legacy') {
          // =========================================================================
          // Phase 3B: TWO-SIDED MUTUAL PREDICTIVE STEP CLAMPING PASS
          // Solves the sequential update gap: accounts for both robots' simultaneous
          // movement vectors in this frame to prevent closing distance < 0.72c.
          // Special-cases active escape maneuvers (isBackingUp / isSideStepping) to
          // prevent Phase 3B from overriding Deadlock Resolver's assigned escapes!
          // =========================================================================
          const SAFE_BUFFER = 0.60;
          const PASS_BUFFER = 0.55;

          for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < AMR_FLEET.length; i++) {
              const A = AMR_FLEET[i];
              if (A.state === 'IDLE_CHARGING' || A.state === 'OUT_OF_CHARGE' || A._isStationaryThisFrame) continue;

              for (let j = 0; j < AMR_FLEET.length; j++) {
                if (i === j) continue;
                const B = AMR_FLEET[j];
                if (B.state === 'IDLE_CHARGING' || B.state === 'OUT_OF_CHARGE') continue;

                const curDist = Math.hypot(A.x - B.x, A.y - B.y);
                if (curDist < 0.001) continue;

                const aStep = A._safeStep || 0;
                const bStep = B._safeStep || 0;
                if (aStep <= 0.0001 && bStep <= 0.0001) continue;

                // Shared state coordination: check if A and B are assigned escape partners
                const aIsEscaping = A.isBackingUp || A.isSideStepping;
                const bIsEscaping = B.isBackingUp || B.isSideStepping;
                const isEscapePair = (aIsEscaping && (A.escapePartnerId === B.id || B.yieldTo === A.id)) ||
                                     (bIsEscaping && (B.escapePartnerId === A.id || A.yieldTo === B.id));

                if (isEscapePair) {
                  // The Deadlock Resolver already assigned roles for this specific pair:
                  // One robot is intentionally escaping while the partner waits.
                  // Skip re-litigating priority for this pair so we do NOT veto the escape!
                  const escBot = aIsEscaping ? A : B;
                  const waitBot = aIsEscaping ? B : A;
                  // Ensure the designated waiting partner stays stationary
                  waitBot._safeStep = 0;
                  waitBot.currentSpeed = 0;

                  // Only clamp step if the escape motion would physically close into the waiting partner (< 0.65c)
                  const escStep = escBot._safeStep || 0;
                  if (escStep > 0.0001) {
                    const escDx = (escBot._aimDx || 0) * escStep;
                    const escDy = (escBot._aimDy || 0) * escStep;
                    const projDistToWait = Math.hypot((escBot.x + escDx) - waitBot.x, (escBot.y + escDy) - waitBot.y);
                    if (projDistToWait < 0.65 && projDistToWait < curDist) {
                      const allowed = Math.max(0, curDist - 0.65);
                      escBot._safeStep = Math.min(escBot._safeStep, allowed);
                      if (escBot._safeStep <= 0.001) {
                        escBot._safeStep = 0;
                        escBot.currentSpeed = 0;
                      }
                    }
                  }
                  continue; // Do NOT run generic priority arbitration on the assigned escape pair!
                }

                const aDx = (A._aimDx || 0) * aStep;
                const aDy = (A._aimDy || 0) * aStep;
                const bDx = (B._aimDx || 0) * bStep;
                const bDy = (B._aimDy || 0) * bStep;

                const projAx = A.x + aDx;
                const projAy = A.y + aDy;
                const projBx = B.x + bDx;
                const projBy = B.y + bDy;
                const projDist = Math.hypot(projAx - projBx, projAy - projBy);

                const relDx = aDx - bDx;
                const relDy = aDy - bDy;
                const relDistSq = relDx * relDx + relDy * relDy;

                let minContinuousDist = Math.min(curDist, projDist);
                if (relDistSq > 1e-6) {
                  const r0x = A.x - B.x;
                  const r0y = A.y - B.y;
                  const tStar = -(r0x * relDx + r0y * relDy) / relDistSq;
                  if (tStar > 0 && tStar < 1) {
                    const midX = r0x + tStar * relDx;
                    const midY = r0y + tStar * relDy;
                    minContinuousDist = Math.hypot(midX, midY);
                  }
                }

                const isBYielding = B.isWaiting || B._safeStep <= 0.0001;
                const buffer = isBYielding ? PASS_BUFFER : SAFE_BUFFER;

                if (minContinuousDist < buffer && minContinuousDist < curDist) {
                  if (typeof trafficMetrics !== 'undefined') trafficMetrics.collisionsPrevented++;

                  // Special handling if one robot is actively executing an escape maneuver against a third robot:
                  if (aIsEscaping && !bIsEscaping) {
                    // A is escaping; third bot B must yield to clear the area
                    if (!isBYielding) {
                      B._safeStep = 0;
                      B.currentSpeed = 0;
                      B.isWaiting = true;
                      B._wasWaitingThisFrame = true;
                      B.yieldTo = A.id;
                      B.statusBadge = 'WAIT';
                      B.waitTimer = (B.waitTimer || 0) + dt;
                      onRobotJamStart(B, A.id, 'YIELD_TO_ESCAPING_ROBOT');
                    }
                    // Shorten A's step if necessary against B's position, but NEVER freeze A into isWaiting
                    const aProjX = A.x + (A._aimDx || 0) * (A._safeStep || 0);
                    const aProjY = A.y + (A._aimDy || 0) * (A._safeStep || 0);
                    const aProjDist = Math.hypot(aProjX - B.x, aProjY - B.y);
                    if (aProjDist < buffer) {
                      const allowed = Math.max(0, curDist - (buffer + 0.02));
                      A._safeStep = Math.min(A._safeStep, allowed);
                      if (A._safeStep <= 0.001) {
                        A._safeStep = 0;
                        A.currentSpeed = 0;
                      }
                    }
                    continue;
                  } else if (bIsEscaping && !aIsEscaping) {
                    // B is escaping; third bot A must yield to clear the area
                    A._safeStep = 0;
                    A.currentSpeed = 0;
                    A.isWaiting = true;
                    A._wasWaitingThisFrame = true;
                    A.yieldTo = B.id;
                    A.statusBadge = 'WAIT';
                    A.waitTimer = (A.waitTimer || 0) + dt;
                    onRobotJamStart(A, B.id, 'YIELD_TO_ESCAPING_ROBOT');

                    // Shorten B's step if necessary against A's position, but NEVER freeze B into isWaiting
                    const bProjX = B.x + (B._aimDx || 0) * (B._safeStep || 0);
                    const bProjY = B.y + (B._aimDy || 0) * (B._safeStep || 0);
                    const bProjDist = Math.hypot(bProjX - A.x, bProjY - A.y);
                    if (bProjDist < buffer) {
                      const allowed = Math.max(0, curDist - (buffer + 0.02));
                      B._safeStep = Math.min(B._safeStep, allowed);
                      if (B._safeStep <= 0.001) {
                        B._safeStep = 0;
                        B.currentSpeed = 0;
                      }
                    }
                    break;
                  }

                  // Generic arbitration for normal robot pairs:
                  if (isHigherPriority(A, B)) {
                    if (!isBYielding) {
                      B._safeStep = 0;
                      B.currentSpeed = 0;
                      B.isWaiting = true;
                      B.isBraking = true;
                      B.brakeIntensity = 1.0;
                      B.brakeLightTimer = 0.45;
                      B._wasWaitingThisFrame = true;
                      B.yieldTo = A.id;
                      B.statusBadge = 'WAIT';
                      B.waitTimer = (B.waitTimer || 0) + dt;
                      
                      // Apply physical pin: B stays halted until A is out of range
                      B._pinnedUntilBotId = A.id;
                      
                      onRobotJamStart(B, A.id, 'AEB_MUTUAL_STEP_CLAMP');
                    }
                    const aProjX = A.x + (A._aimDx || 0) * (A._safeStep || 0);
                    const aProjY = A.y + (A._aimDy || 0) * (A._safeStep || 0);
                    const aProjDist = Math.hypot(aProjX - B.x, aProjY - B.y);
                    if (aProjDist < buffer) {
                      const allowed = Math.max(0, curDist - (buffer + 0.02));
                      A._safeStep = Math.min(A._safeStep, allowed);
                      if (A._safeStep <= 0.001) {
                        A._safeStep = 0;
                        A.currentSpeed = 0;
                        A.isBraking = true;
                        A.brakeIntensity = 0.8;
                        A.brakeLightTimer = 0.40;
                      }
                    }
                  } else {
                    A._safeStep = 0;
                    A.currentSpeed = 0;
                    A.isWaiting = true;
                    A.isBraking = true;
                    A.brakeIntensity = 1.0;
                    A.brakeLightTimer = 0.45;
                    A._wasWaitingThisFrame = true;
                    A.yieldTo = B.id;
                    A.statusBadge = 'WAIT';
                    A.waitTimer = (A.waitTimer || 0) + dt;

                    // Apply physical pin: A stays halted until B is out of range
                    A._pinnedUntilBotId = B.id;

                    onRobotJamStart(A, B.id, 'AEB_MUTUAL_STEP_CLAMP');
                    break;
                  }
                }
              }
            }
          }
      }

      // =========================================================================
      // Phase 3C: Kinematic Motion Application & Waypoint Advancement
      // =========================================================================
      for (const robot of AMR_FLEET) {
        if (robot.state === 'LOADING_INBOUND' || robot._isStationaryThisFrame) continue;
        if (!robot.path || robot.path.length === 0 || robot.pathIndex >= robot.path.length) continue;

        const targetCell = robot.path[robot.pathIndex];

        // -----------------------------------------------------------------------
        // THE TRAFFIC CORE CHOKE POINT
        // -----------------------------------------------------------------------
        if (typeof Traffic !== 'undefined' && Traffic.TRAFFIC_MODE !== 'legacy') {
            if (!Traffic.mayEnter(robot, targetCell, AMR_FLEET)) {
                robot._safeStep = 0;
                robot.currentSpeed = 0;
                robot.isWaiting = true;
                robot._wasWaitingThisFrame = true;
                robot.statusBadge = 'WAIT';
                continue;
            } else {
                robot.isWaiting = false;
                if (robot.statusBadge === 'WAIT') robot.statusBadge = null;
            }
        }
        // -----------------------------------------------------------------------

        const safeStep = robot._safeStep || 0;
        const distToTarget = Math.hypot(targetCell.x - robot.x, targetCell.y - robot.y);

        if (safeStep > 0.0001) {
          robot.x += (robot._aimDx || 0) * safeStep;
          robot.y += (robot._aimDy || 0) * safeStep;
          robot.gridX = Math.round(robot.x);
          robot.gridY = Math.round(robot.y);

          if (robot.logStats) {
            robot.logStats.totalDistanceTraveled += safeStep;
            if (robot.currentSpeed > robot.logStats.maxSpeed) {
              robot.logStats.maxSpeed = robot.currentSpeed;
            }
            const cW = robot.payloadWeight || 0;
            const tonKm = (cW / 1000.0) * (safeStep * 0.0008);
            robot.totalPayloadTonKm = (robot.totalPayloadTonKm || 0) + tonKm;
            robot.logStats.totalPayloadTonKm = (robot.logStats.totalPayloadTonKm || 0) + tonKm;
          }

          if (distToTarget <= safeStep + 0.02) {
            if (robot.gridX !== targetCell.x || robot.gridY !== targetCell.y) {
              robot.previousBox = { x: robot.gridX, y: robot.gridY };
              if (!robot.recentVisitedCells) robot.recentVisitedCells = [];
              robot.recentVisitedCells.push({ x: robot.gridX, y: robot.gridY });
              if (robot.recentVisitedCells.length > 8) robot.recentVisitedCells.shift();
            }
            if (robot.logStats) robot.logStats.totalCellsTraversed++;
            robot.x = targetCell.x;
            robot.y = targetCell.y;
            robot.gridX = targetCell.x;
            robot.gridY = targetCell.y;
            robot.pathIndex++;

            if (robot.pathIndex >= robot.path.length) {
              robot.x = targetCell.x;
              robot.y = targetCell.y;
              robot.path = [];
              robot.pathIndex = 0;
              if (robot.isOvertaking) {
                robot.isOvertaking = false;
                robot.speedMultiplier = 1.0;
                if (robot.statusBadge === 'PASS') robot.statusBadge = null;
              }
              onRobotReachedDestination(robot);
            }
          }
        }
      }
    }