    // =========================================================================
    // PHASE 12: JUDGE CHAOS PANEL CONTROLS & GHOST PATH RENDERING
    // =========================================================================
    function chaosKillRobot(robotId) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (r) {
        r.isFaulted = true;
        r.battery = 0;
        if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>JUDGE CHAOS:</strong> ${robotId} power disconnected! Fleet dead-node detection will handle recovery.`);
      }
    }

    function chaosBlockAisle() {
      if (typeof mapData !== 'undefined' && mapData.grid) {
        // Force block the newly built Transit Bridge (x=85) to trigger massive local rerouting
        mapData.grid[85][24] = 9;
        mapData.grid[85][25] = 9;
        if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>JUDGE CHAOS:</strong> Main transit bridge blocked at x=85! Watch the fleet replan.`);
      }
    }

    function chaosPacketLoss(pct) {
      if (typeof zenohMesh !== 'undefined') {
        zenohMesh.config.packetLossPct = pct;
        if (typeof logTerminal === 'function') logTerminal('ALERT', 'tag-yield', `🚨 <strong>JUDGE CHAOS:</strong> Mesh packet loss forced to ${pct}%! Watch intent tubes inflate.`);
      }
    }

    // Call this inside your existing canvas render() loop!
    function drawDecentralizedOverlays(ctx, camera) {
      if (!AMR_FLEET) return;
      const tNow = Date.now();
      
      for (const robot of AMR_FLEET) {
        // 1. Conflict Flash (Yellow Bounding Box when yielding/negotiating)
        const isYielding = robot.statusBadge && (robot.statusBadge.includes('WAIT') || robot.statusBadge.includes('STEP') || robot.statusBadge.includes('BACK') || robot.statusBadge.includes('YIELD') || robot.statusBadge.includes('HALT'));
        
        const screenX = (robot.x + 0.5) * camera.scale + camera.x;
        const screenY = (robot.y + 0.5) * camera.scale + camera.y;

        if (isYielding && (tNow % 500 < 250)) { // Flash at 2Hz
          ctx.save();
          ctx.strokeStyle = '#facc15'; 
          ctx.lineWidth = 3;
          ctx.shadowColor = '#facc15';
          ctx.shadowBlur = 12;
          ctx.strokeRect(screenX - camera.scale * 0.8, screenY - camera.scale * 0.8, camera.scale * 1.6, camera.scale * 1.6);
          ctx.restore();
        }

        // 2. Ghost Paths (Intent Tubes) removed as requested.
      }
    }

    function recallTrackedBotToCharger() {
      if (trackedRobotId) {
        sendBotToCharger(trackedRobotId);
      }
    }

    function inspectTrackedBotInHealth() {
      if (!trackedRobotId) return;
      const botId = trackedRobotId;
      switchMainTab('terminal');
      setTimeout(() => {
        const card = document.getElementById(`bot-card-${botId}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.outline = '2px solid #38bdf8';
          card.style.boxShadow = '0 0 16px rgba(56, 189, 248, 0.4)';
          setTimeout(() => {
            card.style.outline = '';
            card.style.boxShadow = '';
          }, 3000);
        }
      }, 100);
    }

    function updateTrackingHud() {
      const hud = document.getElementById('bot-tracking-hud');
      if (!hud) return;
      if (!trackedRobotId) {
        hud.style.display = 'none';
        return;
      }
      const r = AMR_FLEET.find(b => b.id === trackedRobotId);
      if (!r) {
        hud.style.display = 'none';
        return;
      }
      hud.style.display = 'block';

      // Title & state badge
      const idEl = document.getElementById('track-hud-robot-id');
      if (idEl) idEl.innerText = r.id;

      let stateText = 'STANDBY';
      let stateColor = '#94a3b8';
      let stateBg = 'rgba(148, 163, 184, 0.15)';
      if (r.state === 'IDLE_CHARGING') {
        stateText = '⚡ CHARGING';
        stateColor = '#22c55e';
        stateBg = 'rgba(34, 197, 94, 0.2)';
      } else if (r.state === 'MOVING_TO_PICKUP') {
        stateText = 'EN ROUTE DOCK';
        stateColor = '#38bdf8';
        stateBg = 'rgba(56, 189, 248, 0.2)';
      } else if (r.state === 'LOADING_INBOUND') {
        stateText = 'LOADING SHIPMENT';
        stateColor = '#facc15';
        stateBg = 'rgba(250, 204, 21, 0.2)';
      } else if (r.state === 'CARRYING_TO_RACK') {
        stateText = 'SHELVING SHIPMENT';
        stateColor = '#facc15';
        stateBg = 'rgba(250, 204, 21, 0.2)';
      } else if (r.state === 'ORDER_PICKING') {
        stateText = 'ORDER PICKING';
        stateColor = '#f59e0b';
        stateBg = 'rgba(245, 158, 11, 0.2)';
      } else if (r.state === 'DELIVERING_ORDER_TO_BAY') {
        stateText = 'DELIVERING BAY';
        stateColor = '#ea580c';
        stateBg = 'rgba(234, 88, 12, 0.2)';
      } else if (r.state === 'RETURNING_HOME') {
        stateText = 'RETURN CHARGER';
        stateColor = '#10b981';
        stateBg = 'rgba(16, 185, 129, 0.2)';
      } else if (r.state === 'OUT_OF_CHARGE') {
        stateText = 'LOW BATT 10%';
        stateColor = '#ef4444';
        stateBg = 'rgba(239, 68, 68, 0.25)';
      }

      if (r.isWaiting) {
        stateText = `WAIT (YIELD)`;
        stateColor = '#f59e0b';
        stateBg = 'rgba(245, 158, 11, 0.25)';
      } else if (r.isOvertaking) {
        stateText = `OVERTAKING`;
        stateColor = '#38bdf8';
        stateBg = 'rgba(56, 189, 248, 0.25)';
      } else if (r.isRerouting) {
        stateText = `DETOUR / REROUTE`;
        stateColor = '#c084fc';
        stateBg = 'rgba(192, 132, 252, 0.25)';
      }

      const badgeEl = document.getElementById('track-hud-state-badge');
      if (badgeEl) {
        badgeEl.innerText = stateText;
        badgeEl.style.color = stateColor;
        badgeEl.style.background = stateBg;
        badgeEl.style.border = `1px solid ${stateColor}`;
      }

      // Battery
      const battEl = document.getElementById('track-hud-battery');
      const battFill = document.getElementById('track-hud-batt-fill');
      if (battEl) battEl.innerText = `${r.battery.toFixed(1)}%`;
      if (battFill) {
        battFill.style.width = `${Math.min(100, Math.max(0, r.battery))}%`;
        const bColor = r.battery > 50 ? '#22c55e' : (r.battery > 20 ? '#f59e0b' : '#ef4444');
        battFill.style.background = bColor;
      }

      // Speed & Load
      const spdEl = document.getElementById('track-hud-speed');
      const loadEl = document.getElementById('track-hud-load');
      const curSpeed = r.isWaiting ? 0 : (r.currentSpeed || 0);
      const accelStr = r.isBraking ? ` [🛑 BRAKE ${(r.acceleration || 0).toFixed(1)} c/s²]` : (r.acceleration && Math.abs(r.acceleration) > 0.05 ? ` [${r.acceleration > 0 ? '+' : ''}${r.acceleration.toFixed(1)} c/s²]` : '');
      if (spdEl) spdEl.innerText = `${curSpeed.toFixed(2)} c/s (${(curSpeed * 0.8).toFixed(2)} m/s)${accelStr}`;
      const dampPct = r.payloadDamping ? Math.round(r.payloadDamping * 100) : 100;
      if (loadEl) loadEl.innerText = `${(r.payloadWeight || 0).toFixed(1)} kg (${dampPct}% throttle) | Mass: ${Math.round(r.totalMassKg || 145)}kg`;

      // Position & Heading
      const coordsEl = document.getElementById('track-hud-coords');
      const headingEl = document.getElementById('track-hud-heading');
      if (coordsEl) coordsEl.innerText = `X: ${r.x.toFixed(1)}, Y: ${r.y.toFixed(1)}`;
      const deg = Math.round(((r.heading * 180 / Math.PI) + 360) % 360);
      const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
      const dirTxt = dirs[Math.round(deg / 45) % 8];
      const turnTxt = r.isTurning ? ` [🔄 ${(r.angularVelocity || 0).toFixed(1)} rad/s]` : '';
      if (headingEl) headingEl.innerText = `Heading: ${deg}° (${dirTxt})${turnTxt}`;

      // Power & Phase
      const pwrEl = document.getElementById('track-hud-power');
      const phaseEl = document.getElementById('track-hud-charge-phase');
      if (r.state === 'IDLE_CHARGING') {
        const kw = (r.chargeRateKw || 30.0).toFixed(1);
        if (pwrEl) pwrEl.innerText = `+${kw} kW`;
        if (phaseEl) phaseEl.innerText = r.chargePhase || 'Fast Charge';
      } else {
        const stateTag = r.isBraking ? '🛑 Braking' : (r.isTurning ? '🔄 Cornering' : (r.isWaiting ? 'Idle Standby' : 'Discharging'));
        if (pwrEl) pwrEl.innerText = `${Math.round(r.powerWatts || 165)} W (${stateTag})`;
        if (phaseEl) phaseEl.innerText = stateTag;
      }

      // Target & Mission Box
      const targetEl = document.getElementById('track-hud-target-desc');
      const slaEl = document.getElementById('track-hud-sla');
      if (targetEl) targetEl.innerText = r.targetDesc || 'Idle Standby';

      const nearestInfo = getNearestAvailableCharger(r.gridX, r.gridY, r.id);
      let slaTxt = 'Fleet Standby';
      if (r.orderBox && r.orderBox.importance) {
        slaTxt = `SLA: ${r.orderBox.importance.label}`;
      } else if (r.carriedParcels && r.carriedParcels.length > 0 && r.carriedParcels[0].importance) {
        slaTxt = `SLA: ${r.carriedParcels[0].importance.label}`;
      }
      const chgDist = nearestInfo.distance !== undefined ? `${nearestInfo.distance} cells` : 'nearby';
      if (slaEl) slaEl.innerText = `${slaTxt} | Nearest Charger: ${nearestInfo.charger ? nearestInfo.charger.id : 'CH-01'} (${chgDist})`;

      // Onboard Perception Horizon & Sensor State
      const percStatusEl = document.getElementById('track-hud-perception-status');
      const percSpecEl = document.getElementById('track-hud-perception-spec');
      const percTrackedEl = document.getElementById('track-hud-perception-tracked');

      if (r.perception) {
        const p = r.perception;
        const confCount = p.confirmedObstacles ? p.confirmedObstacles.length : 0;
        if (percStatusEl) {
          if (confCount > 0) {
            const hasEmergency = p.confirmedObstacles.some(o => o.dist < 2.2);
            percStatusEl.innerText = hasEmergency ? '🛑 OBSTACLE IN STOP ZONE' : `⚠️ ${confCount} TRACKED`;
            percStatusEl.style.color = hasEmergency ? '#ef4444' : '#f59e0b';
          } else {
            percStatusEl.innerText = 'CLEAR HORIZON';
            percStatusEl.style.color = '#22c55e';
          }
        }
        if (percSpecEl) {
          const sRange = (r.sensorRange || 6.0).toFixed(1);
          const sMeters = ((r.sensorRange || 6.0) * 0.35).toFixed(1);
          const sLag = Math.round((r.detectionLatencySec || 0.08) * 1000);
          percSpecEl.innerText = `2D Safety LiDAR: ${sRange}c (${sMeters}m) | 220° FOV | ${sLag}ms Latency Filter`;
        }
        if (percTrackedEl) {
          if (confCount > 0) {
            const obsDesc = p.confirmedObstacles.map(o => `${o.id} (${o.dist.toFixed(1)}c, ${Math.round(o.bearing * 180 / Math.PI)}°)`).join(', ');
            percTrackedEl.innerHTML = `<span style="color:#f59e0b; font-weight:600;">Active Tracks:</span> ${obsDesc} <span style="color:#64748b;">(Occlusions: ${p.totalOcclusions || 0})</span>`;
          } else {
            percTrackedEl.innerHTML = `No obstacles in safety envelope. <span style="color:#64748b;">(Rack Occlusions: ${p.totalOcclusions || 0})</span>`;
          }
        }
      }

      // Cargo Manifest List
      const countEl = document.getElementById('track-hud-cargo-count');
      const listEl = document.getElementById('track-hud-cargo-list');
      if (r.orderBox) {
        const ob = r.orderBox;
        if (countEl) countEl.innerText = `${ob.items.length}/${ob.totalItems} items (${(ob.totalWeight || 5).toFixed(1)}kg)`;
        if (listEl) {
          if (ob.items && ob.items.length > 0) {
            listEl.innerHTML = ob.items.map(it => `<div>• <strong style="color:#f59e0b;">${it.parcel_id}</strong> (${it.name}, ${it.weight})</div>`).join('');
          } else {
            listEl.innerHTML = '<span style="color:#64748b; font-style:italic;">Navigating to racks to collect items...</span>';
          }
        }
      } else if (r.carriedParcels && r.carriedParcels.length > 0) {
        if (countEl) countEl.innerText = `${r.carriedParcels.length} pkgs (${(r.payloadWeight || 10).toFixed(1)}kg)`;
        if (listEl) {
          listEl.innerHTML = r.carriedParcels.map(p => `<div>• <strong style="color:#facc15;">${p.parcel_id}</strong> (${p.name}, ${p.weight}) → Rack Tier ${p.rackSlot ? p.rackSlot.floorNum : '1'}</div>`).join('');
        }
      } else {
        if (countEl) countEl.innerText = 'Empty Tote';
        if (listEl) listEl.innerHTML = '<span style="color:#64748b; font-style:italic;">No parcels currently loaded on chassis.</span>';
      }
    }

