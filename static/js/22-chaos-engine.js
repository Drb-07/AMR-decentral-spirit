    // =========================================================================
    // CHAOS TEST ENGINE (Fault Injection & Resilient Mission Reassignment)
    // =========================================================================
    function reassignTasksFromFaultedRobot(targetBot) {
      let reassigned = false;
      // 1. Inbound mission recovery
      if (targetBot.inboundMission) {
        const m = targetBot.inboundMission;
        const dId = m.dockId || m.sourceDockId;
        logTerminal('MAINTENANCE', 'tag-yield', `🔄 <strong>TASK REASSIGNMENT:</strong> Inbound Mission <strong>${m.id}</strong> (Dock ${dId || 'P1'}) recovered from faulted ${targetBot.id}.`);
        if (targetBot.carriedParcels && targetBot.carriedParcels.length > 0) {
          m.parcels = [...targetBot.carriedParcels, ...(m.parcels || [])];
          if (dId && typeof inboundQueues !== 'undefined') {
            if (!inboundQueues[dId]) inboundQueues[dId] = [];
            inboundQueues[dId].unshift(...targetBot.carriedParcels);
          }
          targetBot.carriedParcels = [];
          targetBot.cargo = null;
        }
        m.status = 'PENDING';
        m.assignedRobotId = null;
        targetBot.inboundMission = null;
        reassigned = true;
      }

      // 2. Outbound mission recovery
      if (targetBot.outboundMission) {
        const m = targetBot.outboundMission;
        const bId = m.bayId || m.departureBayId;
        logTerminal('MAINTENANCE', 'tag-yield', `🔄 <strong>TASK REASSIGNMENT:</strong> Outbound Order <strong>${m.orderId}</strong> (Bay ${bId || 'D1'}) recovered from faulted ${targetBot.id}.`);
        if (targetBot.orderBox && targetBot.orderBox.items && targetBot.orderBox.items.length > 0) {
          if (!m.itemsToPick) m.itemsToPick = [];
          for (const it of targetBot.orderBox.items) {
            if (it && it.parcel_id) {
              const rx = (it.rack && it.rack.x) || it.rackX || 40;
              const ry = (it.rack && it.rack.y) || it.rackY || 20;
              const fl = it.floor !== undefined ? it.floor : (it.floorIndex !== undefined ? it.floorIndex : 0);
              m.itemsToPick.unshift({
                rack: { x: rx, y: ry, floors: [it] },
                floorIndex: fl,
                parcel: it,
                forOrderId: m.orderId
              });
              const rkKey = `${rx},${ry}`;
              if (typeof rackMemory !== 'undefined' && rackMemory[rkKey]) {
                rackMemory[rkKey].floors[fl] = it;
                delete it.isReservedOutbound;
              }
            }
          }
          targetBot.orderBox = null;
        }
        m.status = 'PENDING';
        m.assignedRobotId = null;
        if (bId && typeof outboundOrders !== 'undefined' && !outboundOrders[bId]) {
          outboundOrders[bId] = {
            orderId: m.orderId,
            bayId: bId,
            totalCount: (m.items || m.itemsToPick || []).length,
            deliveredCount: 0
          };
        }
        targetBot.outboundMission = null;
        reassigned = true;
      }

      return reassigned;
    }

    function injectRobotChaosFault(robotId = null, faultType = 'COMMS_DROPOUT') {
      let targetBot = null;
      if (robotId) {
        targetBot = AMR_FLEET.find(b => b.id === robotId);
      } else {
        const activeBots = AMR_FLEET.filter(b => 
          !b.isFaulted && b.state !== 'HARDWARE_FAULT' && b.state !== 'MARKED_FOR_MAINTENANCE' && !b.isUnderMaintenance &&
          (b.state === 'CARRYING_TO_RACK' || b.state === 'ORDER_PICKING' || b.state === 'DELIVERING_ORDER_TO_BAY' || b.state === 'MOVING_TO_PICKUP')
        );
        if (activeBots.length > 0) {
          targetBot = activeBots[Math.floor(Math.random() * activeBots.length)];
        } else {
          targetBot = AMR_FLEET.find(b => !b.isFaulted && b.state !== 'HARDWARE_FAULT' && b.state !== 'MARKED_FOR_MAINTENANCE' && !b.isUnderMaintenance && b.state !== 'IDLE_CHARGING');
        }
      }

      if (!targetBot) return null;

      targetBot.isFaulted = true;
      targetBot.isUnderMaintenance = true;
      targetBot.faultType = faultType;
      targetBot.maintenanceReason = faultType;
      targetBot.faultSimTime = Number((totalSimSeconds || 0).toFixed(2));
      targetBot.markedForMaintenanceTime = targetBot.faultSimTime;

      // Backward-compatible state assignment:
      // Legacy chaos tests expect HARDWARE_FAULT for legacy chaos types
      if (faultType === 'MOTOR_CONTROLLER_STALL' || faultType === 'BMS_OVERTEMP_CUTOFF' || faultType === 'LIDAR_SENSOR_BLINDING' || faultType === 'WHEEL_ENCODER_SLIP_LOCK' || faultType === 'MOTOR_STALL') {
        targetBot.state = 'HARDWARE_FAULT';
        targetBot.statusBadge = 'FAULT';
      } else {
        targetBot.state = 'MARKED_FOR_MAINTENANCE';
        if (faultType === 'COMMS_DROPOUT') targetBot.statusBadge = 'FAULT: COMMS';
        else if (faultType === 'SENSOR_FAULT') targetBot.statusBadge = 'FAULT: SENSOR';
        else if (faultType === 'STUCK_WHEEL') targetBot.statusBadge = 'FAULT: WHEEL';
        else targetBot.statusBadge = 'MAINTENANCE';
      }

      targetBot.currentSpeed = 0;
      targetBot.targetSpeed = 0;
      targetBot.isBraking = true;
      targetBot.path = [];
      targetBot.pathIndex = 0;

      // Release any terminal claim held by this faulted bot
      releaseAllTerminalClaimsForRobot(targetBot.id);

      // PHASE 6: DECENTRALIZED RECOVERY (Centralized dispatch disabled)
      // The mesh will natively detect the dead node via heartbeat timeout and re-bid!
      // const wasReassigned = reassignTasksFromFaultedRobot(targetBot);
      // if (wasReassigned) FLEET_FAILURE_MAINTENANCE_METRICS.totalTasksReassigned++;
      
      FLEET_FAILURE_MAINTENANCE_METRICS.totalRobotFaultsIncurred++;
      FLEET_FAILURE_MAINTENANCE_METRICS.faultHistory.push({
        type: 'ROBOT',
        robotId: targetBot.id,
        faultType,
        simTime: targetBot.faultSimTime
      });

      logTerminal('MAINTENANCE', 'tag-yield', `🚨 <strong>ROBOT MARKED FOR MAINTENANCE:</strong> <strong>${targetBot.id}</strong> suffered <strong>${faultType}</strong> at (${targetBot.gridX}, ${targetBot.gridY}) mid-mission! Tasks automatically reassigned.`);

      // Trigger immediate watchdog recovery to reassign orphaned tasks and dispatch available fleet
      runFleetWatchdog(Date.now() + 5000);
      dispatchFleet();
      updateHudStats();

      return {
        robotId: targetBot.id,
        faultType,
        state: targetBot.state,
        location: { x: targetBot.gridX, y: targetBot.gridY },
        simTime: targetBot.faultSimTime
      };
    }

    function serviceRobotMaintenance(robotId = null) {
      let targetBot = null;
      if (robotId) {
        targetBot = AMR_FLEET.find(b => b.id === robotId);
      } else {
        targetBot = AMR_FLEET.find(b => b.isFaulted || b.state === 'HARDWARE_FAULT' || b.state === 'MARKED_FOR_MAINTENANCE' || b.isUnderMaintenance);
      }

      if (!targetBot) return false;

      targetBot.isFaulted = false;
      targetBot.isUnderMaintenance = false;
      targetBot.faultType = null;
      targetBot.maintenanceReason = null;
      targetBot.state = 'IDLE';
      targetBot.statusBadge = null;
      targetBot.currentSpeed = ROBOT_BASE_SPEED;

      FLEET_FAILURE_MAINTENANCE_METRICS.totalMaintenanceServicesCompleted++;

      logTerminal('MAINTENANCE', 'tag-complete', `🛠️ <strong>MAINTENANCE COMPLETE:</strong> <strong>${targetBot.id}</strong> serviced and restored to active fleet duty.`);

      if (targetBot.battery < 25.0) {
        routeRobotToNearestCharger(targetBot, 'DYNAMIC_SAFETY_ABORT');
      } else {
        dispatchFleet();
      }
      updateHudStats();
      return true;
    }

    function recoverRobotChaosFault(robotId = null) {
      return serviceRobotMaintenance(robotId);
    }

    function serviceAllMaintenance() {
      let botsServiced = 0;
      for (const b of AMR_FLEET) {
        if (b.isFaulted || b.state === 'HARDWARE_FAULT' || b.state === 'MARKED_FOR_MAINTENANCE' || b.isUnderMaintenance) {
          serviceRobotMaintenance(b.id);
          botsServiced++;
        }
      }

      let chargersRestored = 0;
      for (const p of CHARGING_PORTS) {
        if (p.isFaulted) {
          recoverChargerFault(p.id);
          chargersRestored++;
        }
      }

      logTerminal('MAINTENANCE', 'tag-complete', `🛠️ <strong>FLEET OVERHAUL:</strong> Serviced ${botsServiced} AMRs and restored ${chargersRestored} chargers.`);
      updateHudStats();
      return { botsServiced, chargersRestored };
    }

    function triggerRandomFaultMenu() {
      const isCharger = Math.random() < 0.25;
      if (isCharger) {
        const port = CHARGING_PORTS.find(p => !p.isFaulted);
        if (port) injectChargerFault(port.id, 'POWER_CONVERTER_TRIP');
      } else {
        const types = ['COMMS_DROPOUT', 'SENSOR_FAULT', 'STUCK_WHEEL'];
        const chosen = types[Math.floor(Math.random() * types.length)];
        injectRobotChaosFault(null, chosen);
      }
    }

