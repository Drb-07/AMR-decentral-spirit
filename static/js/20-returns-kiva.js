    // ==========================================
    // FEATURE 9A: RETURNS / PUTBACK FLOW
    // Customer-returned parcels arrive at return dock → bot picks up → stows back into 3D rack
    // ==========================================
    function triggerReturnShipment() {
      if (!mapData || !mapData.stations) return;
      // Use P-type pickup docks as return receipt points (cycle through them)
      const pickups = Object.keys(mapData.stations).filter(id => id.startsWith('P'));
      if (pickups.length === 0) return;

      // Pick a dock not currently holding an inbound shipment
      const availableDocks = pickups.filter(id =>
        (inboundQueues[id] || []).length === 0 &&
        !inboundMissions.some(m => m.dockId === id) &&
        !returnMissions.some(m => m.dockId === id && m.status === 'PENDING')
      );
      if (availableDocks.length === 0) return;

      // How many returned items (1-3 per shipment — smaller than inbound)
      const numItems = Math.floor(Math.random() * 3) + 1;
      const chosenDock = availableDocks[Math.floor(Math.random() * availableDocks.length)];
      const st = mapData.stations[chosenDock];
      const batch = [];
      let totalWeight = 0;

      for (let i = 0; i < numItems; i++) {
        const skuInfo = SKU_CATALOG[Math.floor(Math.random() * SKU_CATALOG.length)];
        const weightVal = parseFloat((skuInfo.weight + (Math.random() * 2 - 1)).toFixed(1));
        totalWeight += weightVal;
        returnSequence++;
        batch.push({
          parcel_id: `RET-${returnSequence}`,
          sku: skuInfo.sku,
          name: skuInfo.name,
          weight: `${weightVal}kg`,
          weightVal,
          isReturn: true,
          dock: chosenDock,
          timestamp: new Date().toLocaleTimeString()
        });
      }

      // Reserve rack slots for returned items using ABC/velocity policy
      const validBatch = [];
      for (const parcel of batch) {
        const slot = findOptimalSlotForSku(parcel.sku, chosenDock, 'ABC_VELOCITY');
        if (slot) {
          slot.rack.floors[slot.floorIndex] = { isReservedInbound: true, parcel_id: parcel.parcel_id, parcel };
          parcel.rackSlot = slot;
          validBatch.push(parcel);
        }
      }
      if (validBatch.length === 0) return;

      // Push to inbound queue so dock lights up yellow (reuses dock visual)
      inboundQueues[chosenDock] = validBatch;

      WAREHOUSE_RETURNS_METRICS.totalReturnsMissionsCreated++;
      const idRange = validBatch.length > 1 ? `${validBatch[0].parcel_id}..${validBatch[validBatch.length-1].parcel_id}` : validBatch[0].parcel_id;
      logTerminal('RETURNS', 'tag-inbound', `♻️ <strong>Returns Dock ${chosenDock}</strong> received <strong>${validBatch.length} customer-returned item(s)</strong> (${idRange}, ${totalWeight.toFixed(1)}kg) — Queued for putback stow`);

      returnMissions.push({
        id: `RET-MIS-${returnSequence}`,
        dockId: chosenDock,
        dockX: st.x,
        dockY: st.y,
        parcels: validBatch,
        totalWeight,
        importance: IMPORTANCE_TIERS.STANDARD,
        createdAt: Date.now(),
        createdSimTimeSec: Number((totalSimSeconds || 0).toFixed(2)),
        status: 'PENDING',
        assignedRobotId: null,
        isReturn: true
      });

      updateHudStats();
      dispatchFleet();
    }

    // ==========================================
    // FEATURE 9B: ORDER CANCELLATION MID-FLIGHT
    // Cancel an in-progress outbound order — items return to rack, bot goes idle
    // ==========================================
    function cancelOutboundOrder(orderId) {
      // Find the mission (pending or assigned)
      const missionIdx = outboundMissions.findIndex(m => m.orderId === orderId);
      if (missionIdx === -1) {
        logTerminal('CANCEL', 'tag-outbound', `⚠️ Order <strong>${orderId}</strong> not found in active missions.`);
        return false;
      }
      const mission = outboundMissions[missionIdx];

      // If a bot is carrying items already picked from rack, restore them
      let itemsRestored = 0;
      const assignedBot = mission.assignedRobotId ? AMR_FLEET.find(b => b.id === mission.assignedRobotId) : null;
      if (assignedBot && assignedBot.orderBox && assignedBot.outboundMission && assignedBot.outboundMission.orderId === orderId) {
        // Return items already in the bot's Giant Box back to rack memory
        for (const item of (assignedBot.orderBox.items || [])) {
          // Find any empty rack slot and stow it back
          const slot = findOptimalSlotForSku(item.sku, null, 'ABC_VELOCITY');
          if (slot) {
            slot.rack.floors[slot.floorIndex] = item;
            itemsRestored++;
          }
        }
        // Return items still queued but not yet picked (restore reservations back to full items)
        for (const pickItem of (mission.itemsToPick || [])) {
          if (pickItem.rack && pickItem.floorIndex !== undefined) {
            // Was reserved as outbound - restore it
            pickItem.rack.floors[pickItem.floorIndex] = pickItem.parcel;
            itemsRestored++;
          }
        }
        // Release robot cleanly
        releaseAllTerminalClaimsForRobot(assignedBot.id);
        assignedBot.outboundMission = null;
        assignedBot.orderBox = null;
        assignedBot.state = 'IDLE';
        assignedBot.isLoadedYellow = false;
        assignedBot.statusBadge = null;
        assignedBot.payloadWeight = 0;
        assignedBot.payloadDamping = 1.0;
        assignedBot.path = [];
        assignedBot.pathIndex = 0;
        logTerminal('CANCEL', 'tag-outbound', `🚫 <strong>${assignedBot.id}</strong> aborted Order <strong>${orderId}</strong> mid-flight. <strong>${itemsRestored} item(s)</strong> returned to rack memory. Bot → IDLE.`);
      } else {
        // Not yet assigned - just restore reserved items
        for (const pickItem of (mission.itemsToPick || [])) {
          if (pickItem.rack && pickItem.floorIndex !== undefined) {
            pickItem.rack.floors[pickItem.floorIndex] = pickItem.parcel;
            itemsRestored++;
          }
        }
        logTerminal('CANCEL', 'tag-outbound', `🚫 Order <strong>${orderId}</strong> cancelled before dispatch. <strong>${itemsRestored} item(s)</strong> returned to inventory.`);
      }

      // Remove bay reservation
      if (mission.bayId && outboundOrders[mission.bayId] && outboundOrders[mission.bayId].orderId === orderId) {
        delete outboundOrders[mission.bayId];
      }

      // Remove mission
      outboundMissions.splice(missionIdx, 1);
      WAREHOUSE_RETURNS_METRICS.totalOrdersCancelled++;
      WAREHOUSE_RETURNS_METRICS.totalCancelledItemsRestored += itemsRestored;
      updateHudStats();
      dispatchFleet();
      return true;
    }

    // ==========================================
    // FEATURE 9C: KIVA / POD-TO-PICKER MODE
    // Mobile shelf pods are driven to fixed human picker workstations
    // ==========================================
    function initMobilePods() {
      MOBILE_PODS.length = 0;
      if (!mapData || !mapData.racks) return;
      // Create 4 mobile pods positioned at rack cluster centres
      const podPositions = [
        { x: 20, y: 12 }, { x: 40, y: 12 },
        { x: 20, y: 35 }, { x: 40, y: 35 }
      ];
      for (let i = 0; i < podPositions.length; i++) {
        MOBILE_PODS.push({
          id: `POD-${String(i+1).padStart(2,'0')}`,
          x: podPositions[i].x,
          y: podPositions[i].y,
          homeX: podPositions[i].x,
          homeY: podPositions[i].y,
          state: 'IDLE', // IDLE | IN_TRANSIT | AT_PICKER | RETURNING
          carriedByBotId: null,
          pickerStationId: null,
          inventory: [] // Simplified: list of random parcel info for display
        });
      }
    }

    function initPickerStations() {
      PICKER_STATIONS.length = 0;
      if (!mapData || !mapData.stations) return;
      // Use D-type (departure bay) stations as picker workstations in Kiva mode
      const bays = Object.keys(mapData.stations).filter(id => id.startsWith('D'));
      for (let i = 0; i < Math.min(bays.length, 4); i++) {
        const st = mapData.stations[bays[i]];
        PICKER_STATIONS.push({
          id: `PKR-${String(i+1).padStart(2,'0')}`,
          bayId: bays[i],
          x: st.x,
          y: st.y,
          state: 'IDLE', // IDLE | WAITING_FOR_POD | SCANNING | DONE
          assignedPodId: null,
          totalPicksCompleted: 0
        });
      }
    }

    function toggleKivaMode() {
      KIVA_MODE_ENABLED = !KIVA_MODE_ENABLED;
      WAREHOUSE_RETURNS_METRICS.activeKivaMode = KIVA_MODE_ENABLED;
      if (KIVA_MODE_ENABLED) {
        if (MOBILE_PODS.length === 0) initMobilePods();
        if (PICKER_STATIONS.length === 0) initPickerStations();
        logTerminal('KIVA', 'tag-inbound', `🏭 <strong>Kiva/Pod-to-Picker Mode ENABLED</strong>: ${MOBILE_PODS.length} mobile pods, ${PICKER_STATIONS.length} picker stations active.`);
      } else {
        // Return all in-transit pods to home positions
        for (const pod of MOBILE_PODS) {
          pod.state = 'IDLE';
          pod.x = pod.homeX; pod.y = pod.homeY;
          pod.carriedByBotId = null;
        }
        for (const bot of AMR_FLEET) {
          if (bot.state === 'DRIVING_TO_POD' || bot.state === 'LIFTING_POD' ||
              bot.state === 'DELIVERING_POD_TO_PICKER' || bot.state === 'WAITING_AT_PICKER' ||
              bot.state === 'RETURNING_POD_TO_HOME') {
            releaseAllTerminalClaimsForRobot(bot.id);
            bot.kivaAssignedPod = null;
            bot.kivaTargetStation = null;
            bot.state = 'IDLE';
            bot.statusBadge = null;
          }
        }
        logTerminal('KIVA', 'tag-yield', `🏭 <strong>Kiva/Pod-to-Picker Mode DISABLED</strong>: All pods returned to home positions.`);
      }
      const kivaBadge = document.getElementById('hud-kiva-badge-pill');
      if (kivaBadge) {
        kivaBadge.innerText = KIVA_MODE_ENABLED ? 'ACTIVE (CLICK TO DISABLE)' : 'OFF (CLICK TO ENABLE)';
        kivaBadge.style.background = KIVA_MODE_ENABLED ? 'rgba(251,191,36,0.2)' : 'rgba(100,116,139,0.2)';
        kivaBadge.style.borderColor = KIVA_MODE_ENABLED ? '#fbbf24' : '#64748b';
        kivaBadge.style.color = KIVA_MODE_ENABLED ? '#fbbf24' : '#64748b';
      }
      updateHudStats();
    }

    // Kiva mission dispatch: assign an idle bot to drive a pod to a picker station
    function dispatchKivaMissions() {
      if (!KIVA_MODE_ENABLED || MOBILE_PODS.length === 0 || PICKER_STATIONS.length === 0) return;
      const idlePods = MOBILE_PODS.filter(p => p.state === 'IDLE');
      const idleStations = PICKER_STATIONS.filter(s => s.state === 'IDLE');
      if (idlePods.length === 0 || idleStations.length === 0) return;

      const eligibleBots = AMR_FLEET.filter(b =>
        !b.isFaulted && !b.isUnderMaintenance &&
        b.state === 'IDLE' && b.battery >= 35
      );
      if (eligibleBots.length === 0) return;

      const pod = idlePods[0];
      const station = idleStations[0];
      const bot = eligibleBots.reduce((best, b) =>
        Math.hypot(b.x - pod.x, b.y - pod.y) < Math.hypot(best.x - pod.x, best.y - pod.y) ? b : best
      , eligibleBots[0]);

      pod.state = 'IN_TRANSIT';
      pod.carriedByBotId = bot.id;
      pod.pickerStationId = station.id;
      station.state = 'WAITING_FOR_POD';
      station.assignedPodId = pod.id;

      bot.state = 'DRIVING_TO_POD';
      bot.kivaAssignedPod = pod;
      bot.kivaTargetStation = station;
      bot.statusBadge = 'KIVA→POD';
      bot.targetDesc = `Kiva: Driving to Pod ${pod.id} at (${pod.x},${pod.y})`;
      setRobotPath(bot, findPath(bot.gridX, bot.gridY, pod.x, pod.y));
      logTerminal('KIVA', 'tag-inbound', `🏭 <strong>${bot.id}</strong> dispatched → Pod <strong>${pod.id}</strong> → Station <strong>${station.bayId}</strong>`);
    }

    // ==========================================
    // RETURN MISSION DISPATCH (integrated into dispatchFleet via returnMissions array)
    // ==========================================

    // Fast-Forward &amp; Simulation Speed Control

    let simSpeed = 1;
    const SPEED_PRESETS = [1, 2, 5, 10];
    let inboundTimer = null;
    let outboundTimer = null;

    function cycleSimulationSpeed() {
      const idx = SPEED_PRESETS.indexOf(simSpeed);
      const next = SPEED_PRESETS[(idx + 1) % SPEED_PRESETS.length];
      setSimulationSpeed(next);
    }

    function setSimulationSpeed(spd) {
      simSpeed = spd;
      const speedBtn = document.getElementById('speed-btn');
      const speedLabel = document.getElementById('speed-label');
      const hudSpeedBtn = document.getElementById('hud-speed-btn');
      const ctrlSpeedBtn = document.getElementById('ctrl-speed-btn');

      const labelText = `${simSpeed}x Speed`;
      if (speedLabel) speedLabel.innerText = labelText;
      if (speedBtn) speedBtn.classList.toggle('active', simSpeed > 1);
      if (hudSpeedBtn) {
        hudSpeedBtn.innerText = `⏩ ${simSpeed}x`;
        hudSpeedBtn.classList.toggle('active', simSpeed > 1);
      }
      if (ctrlSpeedBtn) {
        ctrlSpeedBtn.innerText = `${simSpeed}x`;
        ctrlSpeedBtn.style.color = simSpeed > 1 ? '#facc15' : 'var(--text)';
      }

      rescheduleSimulationTimers();
      logTerminal('SPEED', 'tag-inbound', `⚡ Fast Forward: Simulation Speed set to <strong>${simSpeed}x</strong>`);
    }

    let returnTimer = null;

    function rescheduleSimulationTimers() {
      if (inboundTimer) clearInterval(inboundTimer);
      if (outboundTimer) clearInterval(outboundTimer);
      if (returnTimer) clearInterval(returnTimer);

      const intervalMs = Math.max(600, Math.floor(10000 / simSpeed));
      inboundTimer = setInterval(triggerInboundShipment, intervalMs);
      outboundTimer = setInterval(triggerOutboundOrder, intervalMs);
      // Returns arrive less frequently (~3x slower than inbound)
      returnTimer = setInterval(triggerReturnShipment, Math.max(1800, intervalMs * 3));
    }


    // Bulk Ingestion & Add N Parcels
    function openBulkModal() {
      const modal = document.getElementById('bulk-modal');
      if (modal) {
        modal.classList.add('open');
        const input = document.getElementById('bulk-input-val');
        if (input) {
          input.focus();
          input.select();
        }
      }
    }

    function closeBulkModal(e) {
      if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) return;
      const modal = document.getElementById('bulk-modal');
      if (modal) modal.classList.remove('open');
    }

    function setPresetN(val) {
      const input = document.getElementById('bulk-input-val');
      if (input) input.value = val;
    }

    function fillCapacity(ratio) {
      const totalSlots = Object.keys(rackMemory).length * MAX_FLOORS;
      const currentStored = getStoredParcelCount();
      const target = Math.floor(totalSlots * ratio);
      const needed = Math.max(0, target - currentStored);
      const input = document.getElementById('bulk-input-val');
      if (input) input.value = needed;
    }

    function submitBulkIngest() {
      const input = document.getElementById('bulk-input-val');
      const val = input ? parseInt(input.value, 10) : 50;
      if (val > 0) {
        addNParcels(val);
        const modal = document.getElementById('bulk-modal');
        if (modal) modal.classList.remove('open');
      }
    }

    function addNParcels(n) {
      if (!mapData || !mapData.grid) return 0;
      const count = parseInt(n, 10);
      if (isNaN(count) || count <= 0) {
        alert('Please enter a valid positive number of parcels.');
        return 0;
      }

      const totalSlots = Object.keys(rackMemory).length * MAX_FLOORS;
      const currentStored = getStoredParcelCount();
      const availableSpace = totalSlots - currentStored;

      if (availableSpace <= 0) {
        logTerminal('ALERT', 'tag-outbound', '⚠️ Warehouse is completely full! (7,560 / 7,560) No available rack tiers.');
        alert('Warehouse is at 100% capacity (7,560 slots full). Please dispatch parcels via outbound bays.');
        return 0;
      }

      const toAdd = Math.min(count, availableSpace);
      let added = 0;
      const nowStr = new Date().toLocaleTimeString();

      for (let i = 0; i < toAdd; i++) {
        const skuInfo = SKU_CATALOG[Math.floor(Math.random() * SKU_CATALOG.length)];
        const slot = findRandomSlotForSku(skuInfo.sku);
        if (!slot) break;

        parcelSequence++;
        const weight = (skuInfo.weight + (Math.random() * 3 - 1.5)).toFixed(1);
        slot.rack.floors[slot.floorIndex] = {
          parcel_id: `PKG-${parcelSequence}`,
          sku: skuInfo.sku,
          name: skuInfo.name,
          weight: `${weight}kg`,
          dock: 'BULK_INGEST',
          timestamp: nowStr
        };
        added++;
      }

      updateHudStats();
      render();

      const newStored = getStoredParcelCount();
      const pct = ((newStored / totalSlots) * 100).toFixed(1);

      logTerminal('BULK INGEST', 'tag-complete', `📥 Injected <strong>${added.toLocaleString()} parcels</strong> directly into 3D Racks | Current Occupancy: <strong>${newStored.toLocaleString()} / ${totalSlots.toLocaleString()} (${pct}%)</strong>`);

      if (count > availableSpace) {
        logTerminal('ALERT', 'tag-outbound', `⚠️ Partial injection: Requested ${count.toLocaleString()} parcels, but only ${availableSpace.toLocaleString()} empty slots were available.`);
      }

      try {
        fetch('/api/inventory/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: added })
        }).catch(() => {});
      } catch (e) {}

      return added;
    }

    // Schedule initial triggers
    setTimeout(() => {
      logTerminal('SYSTEM', 'tag-complete', '🚀 Edge Fleet Mission Control Online | 8 Autonomous AMRs Deployed | 3D Rack Memory Active (7,560 Slots across 5 Tiers)');
      triggerInboundShipment();
    }, 1200);
    rescheduleSimulationTimers();

    setTimeout(triggerOutboundOrder, 5500);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('bulk-modal');
        if (modal) modal.classList.remove('open');
      }
    });

