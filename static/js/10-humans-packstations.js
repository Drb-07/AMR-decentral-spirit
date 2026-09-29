    // =========================================================================
    // FEATURE 4: HUMAN-ROBOT HYBRID OPERATIONS & PACK STATION MODEL
    // 1. Unpredictable, Non-Grid Continuous Human Movement (x, y in R^2)
    // 2. ISO 3691-4 / ANSI RIA R15.08 Speed & Separation Monitoring (SSM)
    // 3. Realistic Packaging Station Throughput Limits & Backpressure
    // 4. Operator Human Presence Toggle (Live Disablement & Uninhibited AMRs)
    // =========================================================================

    let humansEnabled = true;

    function toggleHumanPresence(forced = null) {
      if (forced !== null) {
        humansEnabled = !!forced;
      } else {
        humansEnabled = !humansEnabled;
      }

      // If disabled, immediately release any robot waiting on a human or throttled by human safety bubble
      if (!humansEnabled) {
        if (typeof AMR_FLEET !== 'undefined' && AMR_FLEET) {
          for (const robot of AMR_FLEET) {
            if (robot.statusBadge === 'YIELD HUMAN' || (robot.statusBadge && robot.statusBadge.startsWith('SLOW:'))) {
              robot.statusBadge = null;
            }
            if (robot.humanYieldPartnerId) {
              robot.humanYieldPartnerId = null;
              robot._humanStopLogged = false;
              robot.isWaiting = false;
              robot._wasWaitingThisFrame = false;
            }
          }
        }
        if (typeof logTerminal === 'function') {
          logTerminal('TRAFFIC', 'tag-overtake', `👷 <strong>Human Presence Disabled</strong>: Floor workers cleared. AMRs operating in unrestricted automated zone.`);
        }
      } else {
        if (typeof logTerminal === 'function') {
          logTerminal('SAFETY', 'tag-yield', `👷 <strong>Human Presence Enabled</strong>: Floor workers active. ISO 3691-4 Speed & Separation Monitoring engaged.`);
        }
      }

      // Update UI toggle buttons
      const btnHeader = document.getElementById('human-toggle-btn');
      const lblHeader = document.getElementById('human-toggle-label');
      const btnHud = document.getElementById('hud-human-btn');
      const pillHud = document.getElementById('hud-human-badge-pill');

      if (humansEnabled) {
        if (btnHeader) btnHeader.classList.remove('disabled');
        if (lblHeader) lblHeader.innerText = 'Humans: ON';
        if (btnHud) {
          btnHud.classList.remove('disabled');
          btnHud.innerText = '👷 ON';
        }
        if (pillHud) {
          pillHud.style.background = 'rgba(163,230,53,0.2)';
          pillHud.style.borderColor = '#a3e635';
          pillHud.style.color = '#a3e635';
          pillHud.innerText = 'ACTIVE (CLICK TO TOGGLE)';
        }
      } else {
        if (btnHeader) btnHeader.classList.add('disabled');
        if (lblHeader) lblHeader.innerText = 'Humans: OFF';
        if (btnHud) {
          btnHud.classList.add('disabled');
          btnHud.innerText = '👷 OFF';
        }
        if (pillHud) {
          pillHud.style.background = 'rgba(148,163,184,0.15)';
          pillHud.style.borderColor = '#64748b';
          pillHud.style.color = '#94a3b8';
          pillHud.innerText = 'DISABLED (OFF)';
        }
      }

      if (typeof fetch !== 'undefined') {
        fetch('/api/fleet/humans/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: humansEnabled })
        }).catch(() => {});
      }

      if (typeof updateHudStats === 'function') {
        updateHudStats();
      }
      return humansEnabled;
    }
    if (typeof window !== 'undefined') {
      window.humansEnabled = humansEnabled;
      window.toggleHumanPresence = toggleHumanPresence;
    }

    const HUMAN_WORKERS = [
      {
        id: 'H-01',
        name: 'Sarah Jenkins',
        role: 'Aisle Picker',
        x: 18.5,
        y: 12.5,
        gridX: 18,
        gridY: 12,
        vx: 0,
        vy: 0,
        heading: 0,
        targetX: 22.0,
        targetY: 12.0,
        state: 'WALKING', // 'WALKING', 'INSPECTING'
        stateTimer: 0,
        walkSpeed: 0.95, // cells/s (~1.1 m/s real human speed)
        homeZone: 'Aisle Block A',
        color: '#a3e635', // Neon Lime High-Vis Vest
        hardHatColor: '#ffffff',
        safetyRadius: 2.2, // ISO 3691-4 Protective Stop Bubble (cells)
        cautionRadius: 4.5, // ISO 3691-4 Caution Slowdown Bubble (cells)
        totalYieldsCaused: 0
      },
      {
        id: 'H-02',
        name: 'Alex Rivera',
        role: 'Pack Station Lead',
        x: 4.5,
        y: 35.0,
        gridX: 4,
        gridY: 35,
        vx: 0,
        vy: 0,
        heading: 0,
        targetX: 8.5,
        targetY: 42.0,
        state: 'WALKING',
        stateTimer: 0,
        walkSpeed: 1.10,
        homeZone: 'West Staging Bays',
        color: '#fbbf24', // Amber High-Vis Vest
        hardHatColor: '#facc15',
        safetyRadius: 2.2,
        cautionRadius: 4.5,
        totalYieldsCaused: 0
      },
      {
        id: 'H-03',
        name: 'Carlos Mendoza',
        role: 'Automation Tech',
        x: 62.0,
        y: 24.5,
        gridX: 62,
        gridY: 24,
        vx: 0,
        vy: 0,
        heading: 0,
        targetX: 52.0,
        targetY: 24.5,
        state: 'INSPECTING',
        stateTimer: 3.0,
        walkSpeed: 0.85,
        homeZone: 'Central Highway',
        color: '#f97316', // Orange High-Vis Vest
        hardHatColor: '#38bdf8',
        safetyRadius: 2.2,
        cautionRadius: 4.5,
        totalYieldsCaused: 0
      },
      {
        id: 'H-04',
        name: 'Elena Rostova',
        role: 'Quality Auditor',
        x: 74.0,
        y: 15.0,
        gridX: 74,
        gridY: 15,
        vx: 0,
        vy: 0,
        heading: 0,
        targetX: 74.0,
        targetY: 32.0,
        state: 'WALKING',
        stateTimer: 0,
        walkSpeed: 1.00,
        homeZone: 'East Bay Corridor',
        color: '#ec4899', // Pink High-Vis Vest
        hardHatColor: '#ffffff',
        safetyRadius: 2.2,
        cautionRadius: 4.5,
        totalYieldsCaused: 0
      }
    ];

    const PACK_STATIONS = {}; // Key: bayId -> Station Object

    function initPackStations() {
      if (!mapData || !mapData.stations) return;
      const bayKeys = Object.keys(mapData.stations).filter(k => k.startsWith('D'));
      const packerNames = ['Sarah J.', 'Marcus V.', 'Chloe T.', 'Elena R.', 'David K.', 'Amina B.', 'Liam P.', 'Zoe C.', 'Lucas M.', 'Maya S.'];

      for (let i = 0; i < bayKeys.length; i++) {
        const bayId = bayKeys[i];
        const stData = mapData.stations[bayId];
        PACK_STATIONS[bayId] = {
          id: bayId,
          name: `Packing Station ${bayId}`,
          operatorName: packerNames[i % packerNames.length],
          x: stData.x,
          y: stData.y,
          state: 'IDLE', // 'IDLE', 'HANDOFF', 'PACKING'
          assignedRobotId: null,
          currentOrder: null,
          queue: [], // Queue of waiting AMRs (Backpressure buffer!)
          parcelsPerMinuteTarget: 5.0,
          totalOrdersPacked: 0,
          totalParcelsPacked: 0,
          totalBusyTimeSec: 0,
          totalIdleTimeSec: 0,
          totalQueueWaitTimeSec: 0,
          backpressureIncidents: 0
        };
      }
    }

    function pickNextHumanDestination(human) {
      if (!mapData || !mapData.grid) return;
      for (let attempt = 0; attempt < 30; attempt++) {
        let tx, ty;
        if (human.id === 'H-01') {
          // Sarah: West storage corridors
          tx = 4.0 + Math.random() * 24.0;
          ty = 4.0 + Math.random() * 41.0;
        } else if (human.id === 'H-02') {
          // Alex: West staging & bays
          tx = 2.0 + Math.random() * 14.0;
          ty = 23.0 + Math.random() * 24.0;
        } else if (human.id === 'H-03') {
          // Carlos: Central highway & cross-corridors
          tx = 25.0 + Math.random() * 30.0;
          ty = Math.random() < 0.65 ? (23.0 + Math.random() * 4.0) : (3.0 + Math.random() * 43.0);
        } else {
          // Elena: East departure bays & perimeter
          tx = 50.0 + Math.random() * 26.0;
          ty = 4.0 + Math.random() * 41.0;
        }

        const ix = Math.floor(tx);
        const iy = Math.floor(ty);
        if (ix >= 1 && ix < mapData.width - 1 && iy >= 1 && iy < mapData.height - 1) {
          if (mapData.grid[ix][iy] === 0) { // Walkable open corridor/aisle
            human.targetX = tx;
            human.targetY = ty;
            return;
          }
        }
      }
    }

    function updateHumanWorkers(dt) {
      if (typeof humansEnabled !== 'undefined' && !humansEnabled) return;
      if (!HUMAN_WORKERS || HUMAN_WORKERS.length === 0) return;
      if (!mapData || !mapData.grid) return;

      for (const human of HUMAN_WORKERS) {
        if (human.state === 'INSPECTING') {
          human.stateTimer -= dt;
          if (human.stateTimer <= 0) {
            human.state = 'WALKING';
            human.stateTimer = 0;
            pickNextHumanDestination(human);
          }
          continue;
        }

        if (human.state === 'WALKING') {
          const dx = human.targetX - human.x;
          const dy = human.targetY - human.y;
          const dist = Math.hypot(dx, dy);

          if (dist < 0.75) {
            // Waypoint reached
            if (Math.random() < 0.55) {
              human.state = 'INSPECTING';
              human.stateTimer = 2.0 + Math.random() * 3.5;
            } else {
              pickNextHumanDestination(human);
            }
            continue;
          }

          // Smooth heading interpolation with subtle Brownian noise
          const targetHeading = Math.atan2(dy, dx);
          let diff = targetHeading - human.heading;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          human.heading += diff * Math.min(1.0, dt * 4.0);

          const wanderNoise = (Math.random() - 0.5) * 0.12;
          const moveHeading = human.heading + wanderNoise;
          const stepDist = human.walkSpeed * dt;

          let candX = human.x + Math.cos(moveHeading) * stepDist;
          let candY = human.y + Math.sin(moveHeading) * stepDist;

          // Potential field soft repulsion from racks
          let rackNear = false;
          for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              const cx = Math.floor(candX) + ox;
              const cy = Math.floor(candY) + oy;
              if (cx >= 0 && cx < mapData.width && cy >= 0 && cy < mapData.height) {
                if (mapData.grid[cx][cy] === 1) {
                  const rDist = Math.hypot(candX - (cx + 0.5), candY - (cy + 0.5));
                  if (rDist < 0.85) {
                    const pushX = candX - (cx + 0.5);
                    const pushY = candY - (cy + 0.5);
                    const pushMag = Math.hypot(pushX, pushY) || 1;
                    candX += (pushX / pushMag) * 0.06;
                    candY += (pushY / pushMag) * 0.06;
                    rackNear = true;
                  }
                }
              }
            }
          }

          // Clamping inside warehouse floor boundaries
          candX = Math.max(1.5, Math.min(mapData.width - 2.5, candX));
          candY = Math.max(1.5, Math.min(mapData.height - 2.5, candY));

          human.vx = (candX - human.x) / dt;
          human.vy = (candY - human.y) / dt;
          human.x = candX;
          human.y = candY;
          human.gridX = Math.round(candX);
          human.gridY = Math.round(candY);

          if (rackNear && Math.random() < 0.08) {
            pickNextHumanDestination(human);
          }
        }
      }
    }

    function updatePackStations(dt) {
      if (!PACK_STATIONS || Object.keys(PACK_STATIONS).length === 0) return;

      for (const bayId of Object.keys(PACK_STATIONS)) {
        const station = PACK_STATIONS[bayId];
        if (!station) continue;

        if (station.state === 'IDLE') {
          station.totalIdleTimeSec += dt;
          // Advance queued AMR if any are waiting
          if (station.queue.length > 0) {
            const nextBotId = station.queue[0];
            const bot = AMR_FLEET.find(b => b.id === nextBotId);
            if (bot && bot.state === 'WAITING_FOR_PACKER') {
              station.queue.shift();
              bot.state = 'HANDOFF_TO_PACKER';
              bot.handoffTimer = 1.2;
              bot.isWaiting = false;
              bot._wasWaitingThisFrame = false;
              bot.statusBadge = 'HANDOFF';
              bot.targetDesc = `Handoff to Packer at Bay ${station.id}`;
              station.state = 'HANDOFF';
              station.assignedRobotId = bot.id;
              logTerminal('PACKER', 'tag-outbound', `🤝 Packer at <strong>${station.id}</strong> accepted waiting <strong>${bot.id}</strong> for handoff.`);
            } else if (!bot || bot.state !== 'WAITING_FOR_PACKER') {
              station.queue.shift();
            }
          }
        } else if (station.state === 'HANDOFF') {
          // In handoff with assigned AMR
        } else if (station.state === 'PACKING') {
          station.totalBusyTimeSec += dt;
          if (station.queue.length > 0) {
            station.totalQueueWaitTimeSec += (station.queue.length * dt);
          }

          if (station.currentOrder) {
            station.currentOrder.remainingSec -= dt;
            if (station.currentOrder.remainingSec <= 0) {
              // Pack job completed!
              const doneOrd = station.currentOrder;
              station.totalOrdersPacked++;
              station.totalParcelsPacked += (doneOrd.itemsCount || 1);
              logTerminal('COMPLETE', 'tag-complete', `📦 Packer finished packing Customer Order <strong>${doneOrd.orderId}</strong> (${doneOrd.itemsCount} items) at Bay <strong>${station.id}</strong>! Dispatched to outbound trailer.`);
              station.currentOrder = null;

              if (station.queue.length > 0) {
                const nextBotId = station.queue[0];
                const bot = AMR_FLEET.find(b => b.id === nextBotId);
                if (bot && bot.state === 'WAITING_FOR_PACKER') {
                  station.queue.shift();
                  bot.state = 'HANDOFF_TO_PACKER';
                  bot.handoffTimer = 1.2;
                  bot.isWaiting = false;
                  bot._wasWaitingThisFrame = false;
                  bot.statusBadge = 'HANDOFF';
                  bot.targetDesc = `Handoff to Packer at Bay ${station.id}`;
                  station.state = 'HANDOFF';
                  station.assignedRobotId = bot.id;
                  logTerminal('PACKER', 'tag-outbound', `🤝 Packer at <strong>${station.id}</strong> accepted next waiting <strong>${bot.id}</strong> from staging.`);
                } else {
                  station.state = 'IDLE';
                  outboundOrders[station.id] = null;
                }
              } else {
                station.state = 'IDLE';
                outboundOrders[station.id] = null;
              }
              updateHudStats();
            }
          }
        }
      }
    }

    // Designated One-Way Narrow Aisles (Industrial Traffic Standard)
    // Prevents 100% of head-on deadlocks in single-lane rack pods
    const NARROW_AISLE_COLS = new Set([13, 16, 19, 22, 32, 35, 38, 41, 44, 47, 58, 61, 64, 67, 70, 73, 81, 84, 87, 90, 93, 97, 100, 103, 106, 109, 112, 122, 125, 128, 131, 134, 137, 148, 151, 154, 157]);
    const SOUTHBOUND_AISLE_COLS = new Set([13, 19, 32, 38, 44, 58, 64, 70, 81, 87, 93, 97, 103, 109, 122, 128, 134, 148, 154]); // Moving dy > 0
    const NORTHBOUND_AISLE_COLS = new Set([16, 22, 35, 41, 47, 61, 67, 73, 84, 90, 100, 106, 112, 125, 131, 137, 151, 157]); // Moving dy < 0

