    let lastAnimTime = performance.now();
    let lastDashboardUpdate = 0;
    let lastPeriodicDispatch = 0;
    let lastSlottingOptimizationTime = 0;
    let lastLogSyncTime = 0;
    let simPaused = false;
    let physicsAccumulator = 0;
    const FIXED_PHYSICS_DT = 0.01667;
    const MAX_PHYSICS_SUBSTEPS = 20;

    function togglePause() { 
      simPaused = !simPaused;
      if (simPaused) physicsAccumulator = 0;
      document.getElementById('pause-btn').innerText = simPaused ? '▶️' : '⏸️';
      logTerminal('SYSTEM', 'tag-yield', simPaused ? '⏸️ Simulation Paused by Operator' : '▶️ Simulation Resumed');
    }

    function animateLoop(now) {
      if (!now) now = performance.now();
      const realDt = Math.min(0.1, (now - lastAnimTime) / 1000);
      lastAnimTime = now;

      try {
        // Periodic Background Telemetry Sync (every 5s)
        if (now - lastLogSyncTime > 5000) {
          lastLogSyncTime = now;
          try {
            if (typeof fetch !== 'undefined') {
              fetch('/api/fleet/logs/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildFleetTelemetryPayload())
              }).then(r => r.json()).then(data => {
                if (data && data.commands && data.commands.length > 0) {
                  for (const cmd of data.commands) {
                    if (cmd.action === 'INJECT_FAULT') {
                      if (cmd.targetType === 'CHARGER' || cmd.portId) {
                        injectChargerFault(cmd.portId, cmd.faultType);
                      } else {
                        injectRobotChaosFault(cmd.robotId, cmd.faultType);
                      }
                    } else if (cmd.action === 'SERVICE_MAINTENANCE') {
                      if (cmd.serviceAll) {
                        serviceAllMaintenance();
                      } else if (cmd.portId) {
                        recoverChargerFault(cmd.portId);
                      } else {
                        serviceRobotMaintenance(cmd.robotId);
                      }
                    } else if (cmd.action === 'TRIGGER_RETURN') {
                      if (typeof triggerReturnShipment === 'function') triggerReturnShipment();
                    } else if (cmd.action === 'CANCEL_ORDER') {
                      if (typeof cancelOutboundOrder === 'function') cancelOutboundOrder(cmd.orderId);
                    } else if (cmd.action === 'TOGGLE_KIVA') {
                      if (typeof toggleKivaMode === 'function') toggleKivaMode();
                    }
                  }
                }
              }).catch(() => {});
            }
          } catch (e) {}
        }

        if (!simPaused) { 
          for (let sIdx = COLLISION_SPARKS.length - 1; sIdx >= 0; sIdx--) {
            COLLISION_SPARKS[sIdx].timer -= realDt * (simSpeed || 1);
            if (COLLISION_SPARKS[sIdx].timer <= 0) COLLISION_SPARKS.splice(sIdx, 1);
          }
          for (const r of AMR_FLEET) {
            if (r.mapPingTimer > 0) r.mapPingTimer = Math.max(0, r.mapPingTimer - realDt * (simSpeed || 1));
          }

          // Fixed-Time Physics Sub-Stepping (Accumulator Pattern):
          physicsAccumulator += realDt * (simSpeed || 1);
          if (physicsAccumulator > FIXED_PHYSICS_DT * MAX_PHYSICS_SUBSTEPS) {
            physicsAccumulator = FIXED_PHYSICS_DT * MAX_PHYSICS_SUBSTEPS;
          }

          let stepsRun = 0;
          while (physicsAccumulator >= FIXED_PHYSICS_DT && stepsRun < MAX_PHYSICS_SUBSTEPS) {
            physicsAccumulator -= FIXED_PHYSICS_DT;
            updateRobots(FIXED_PHYSICS_DT);
            stepsRun++;
          }

          runFleetWatchdog(now);

          if (now - lastPeriodicDispatch > 800 / (simSpeed || 1)) {
            lastPeriodicDispatch = now;
            dispatchFleet();
          }

          // Periodic Background Slotting & Consolidation Optimization (every ~20s)
          if (!lastSlottingOptimizationTime) lastSlottingOptimizationTime = now;
          if (now - lastSlottingOptimizationTime > 20000 / (simSpeed || 1)) {
            lastSlottingOptimizationTime = now;
            runBackgroundSlottingOptimization(4);
          }
        } 

        if (window._isHeadless && typeof totalSimSeconds !== 'undefined' && totalSimSeconds >= window._benchDuration) {
            console.log("BENCHMARK_COMPLETE:", JSON.stringify(window.__bench()));
            return; // Stop animation loop
        }

        if (currentMainTab === 'map') {
          if (trackedRobotId && trackCameraFollow && !isDragging) {
            const trkBot = AMR_FLEET.find(b => b.id === trackedRobotId);
            if (trkBot) {
              const w = canvas.width / window.devicePixelRatio;
              const h = canvas.height / window.devicePixelRatio;
              const offsetX = window.innerWidth > 1000 ? -40 : 0;
              const targetX = (w / 2 + offsetX) - (trkBot.x + 0.5) * camera.scale;
              const targetY = (h / 2) - (trkBot.y + 0.5) * camera.scale;
              const lerpFactor = Math.min(1.0, realDt * 8.0);
              camera.x += (targetX - camera.x) * lerpFactor;
              camera.y += (targetY - camera.y) * lerpFactor;
            }
          }
          if (trackedRobotId) {
            updateTrackingHud();
          }
          render();
        } else if (currentMainTab === 'terminal') {
          if (now - lastDashboardUpdate > 180) {
            lastDashboardUpdate = now;
            updateBotsHealthDashboard();
          }
        } else if (currentMainTab === 'problems') {
          if (now - lastDashboardUpdate > 250) {
            lastDashboardUpdate = now;
            updateProblemsDashboard();
          }
        }
        
      } catch (err) {
        console.error("FATAL SIMULATION ERROR CAUGHT:", err);
        if (typeof logTerminal === 'function') logTerminal('SYSTEM', 'tag-yield', `🚨 <strong>Sim Error:</strong> ${err.message}`);
      } finally {
        // Always reschedule the next frame unless headless benchmark is finished
        if (!(window._isHeadless && typeof totalSimSeconds !== 'undefined' && totalSimSeconds >= window._benchDuration)) {
            requestAnimationFrame(animateLoop);
        }
      }
    }

    async function loadMap() {
      const res = await fetch('/api/map');
      mapData = await res.json();
      initRackMemory();
      initAmrFleet();
      resetView();
      lastAnimTime = performance.now();
      requestAnimationFrame(animateLoop);
    }

    function resize() {
      if (!canvas || !canvas.parentElement) return;
      const pw = canvas.parentElement.clientWidth;
      const ph = canvas.parentElement.clientHeight;
      if (pw === 0 || ph === 0) return;
      canvas.width = pw * window.devicePixelRatio;
      canvas.height = ph * window.devicePixelRatio;
      render();
    }
    window.addEventListener('resize', resize);

    function resetView() {
      if (!mapData) return;
      const w = canvas.width / window.devicePixelRatio;
      const h = canvas.height / window.devicePixelRatio;
      const scaleX = (w - 80) / mapData.width;
      const scaleY = (h - 80) / mapData.height;
      camera.scale = Math.max(10, Math.min(scaleX, scaleY));
      camera.x = (w - mapData.width * camera.scale) / 2;
      camera.y = (h - mapData.height * camera.scale) / 2;
      render();
    }

