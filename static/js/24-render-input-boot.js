    function zoom(factor) {
      const centerW = (canvas.width / window.devicePixelRatio) / 2;
      const centerH = (canvas.height / window.devicePixelRatio) / 2;
      const newScale = Math.min(60, Math.max(8, camera.scale * factor));
      camera.x = centerW - (centerW - camera.x) * (newScale / camera.scale);
      camera.y = centerH - (centerH - camera.y) * (newScale / camera.scale);
      camera.scale = newScale;
      render();
    }

    function screenToGrid(sx, sy) {
      if (!mapData) return null;
      const gx = Math.floor((sx - camera.x) / camera.scale);
      const gy = Math.floor((sy - camera.y) / camera.scale);
      if (gx >= 0 && gx < mapData.width && gy >= 0 && gy < mapData.height) {
        return { x: gx, y: gy };
      }
      return null;
    }

    function getInboundPlacementRacks() {
      const set = new Set();
      for (const [key, rack] of Object.entries(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          const item = rack.floors[f];
          if (item && item.isReservedInbound) set.add(key);
        }
      }
      for (const r of AMR_FLEET) {
        if (r.carriedParcels && r.carriedParcels.length > 0) {
          for (const p of r.carriedParcels) {
            if (p.rackSlot && p.rackSlot.rack) {
              set.add(`${p.rackSlot.rack.x},${p.rackSlot.rack.y}`);
            }
          }
        }
        if (r.inboundMission && r.inboundMission.parcels) {
          for (const p of r.inboundMission.parcels) {
            if (p.rackSlot && p.rackSlot.rack) {
              set.add(`${p.rackSlot.rack.x},${p.rackSlot.rack.y}`);
            }
          }
        }
      }
      return set;
    }

    function getOutboundPickRacks() {
      const set = new Set();
      for (const [key, rack] of Object.entries(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          const item = rack.floors[f];
          if (item && item.isReservedOutbound) set.add(key);
        }
      }
      for (const r of AMR_FLEET) {
        if (r.state === 'ORDER_PICKING' && r.outboundMission && r.outboundMission.itemsToPick) {
          for (const it of r.outboundMission.itemsToPick) {
            if (it.rack) {
              set.add(`${it.rack.x},${it.rack.y}`);
            }
          }
        }
      }
      return set;
    }

    function drawHumanWorker(ctx, h, cellSize) {
      const cx = h.x * cellSize;
      const cy = h.y * cellSize;
      const radius = cellSize * 0.44;

      ctx.save();

      // 1. ISO 3691-4 Dynamic Protective Bubble Rings
      // Caution Zone ring (yellow/amber translucent)
      ctx.beginPath();
      ctx.arc(cx, cy, (h.cautionRadius || 4.5) * cellSize, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(234, 179, 8, 0.05)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.40)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Protective Halt Zone ring (red/orange)
      ctx.beginPath();
      ctx.arc(cx, cy, (h.safetyRadius || 2.2) * cellSize, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 2. Human Body & High-Vis Safety Vest
      // Ground shadow
      ctx.beginPath();
      ctx.ellipse(cx, cy + radius * 0.6, radius * 0.85, radius * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fill();

      // Torso / Neon Vest
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = h.color || '#a3e635';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // Silver reflective stripes on vest
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - radius * 0.65, cy - radius * 0.2);
      ctx.lineTo(cx + radius * 0.65, cy - radius * 0.2);
      ctx.moveTo(cx - radius * 0.65, cy + radius * 0.2);
      ctx.lineTo(cx + radius * 0.65, cy + radius * 0.2);
      ctx.stroke();

      // Hardhat / Helmet
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.52, 0, Math.PI * 2);
      ctx.fillStyle = h.hardHatColor || '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Direction Pointer Cone (if walking)
      if (h.state === 'WALKING') {
        const tipX = cx + Math.cos(h.heading) * (radius * 1.35);
        const tipY = cy + Math.sin(h.heading) * (radius * 1.35);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          cx + Math.cos(h.heading + 2.5) * (radius * 0.75),
          cy + Math.sin(h.heading + 2.5) * (radius * 0.75)
        );
        ctx.lineTo(
          cx + Math.cos(h.heading - 2.5) * (radius * 0.75),
          cy + Math.sin(h.heading - 2.5) * (radius * 0.75)
        );
        ctx.closePath();
        ctx.fillStyle = '#facc15';
        ctx.fill();
      }

      // Name & Role Label Pill
      const fontSize = Math.max(9, Math.floor(cellSize * 0.38));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelText = `${h.id} ${h.name.split(' ')[0]} 👷 (${h.state})`;
      const textW = ctx.measureText(labelText).width;
      const pillW = textW + 8;
      const pillH = fontSize + 4;
      const pillY = cy - radius - pillH / 2 - 4;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(cx - pillW / 2, pillY - pillH / 2, pillW, pillH);
      ctx.strokeStyle = h.color || '#a3e635';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - pillW / 2, pillY - pillH / 2, pillW, pillH);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, cx, pillY);

      ctx.restore();
    }

    function drawPackStationBanner(ctx, st, sx, sy, cellSize) {
      if (!st) return;
      const isPacking = st.state === 'PACKING';
      const isHandoff = st.state === 'HANDOFF';
      const hasQueue = st.queue && st.queue.length > 0;

      const pillY = (sy > 400) ? (sy - 16) : (sy + cellSize + 16);
      ctx.save();
      ctx.font = `bold 9px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      let statusText = `📦 READY`;
      let statusBg = '#059669';
      if (isPacking && st.currentOrder) {
        statusText = `🏷️ PACK (${st.currentOrder.remainingSec.toFixed(1)}s)`;
        statusBg = '#d97706';
        if (hasQueue) {
          statusText += ` [${st.queue.length}Q]`;
          statusBg = '#dc2626';
        }
      } else if (isHandoff) {
        statusText = `🤝 HANDOFF`;
        statusBg = '#0284c7';
      } else if (hasQueue) {
        statusText = `⚠️ QUEUED (${st.queue.length})`;
        statusBg = '#ea580c';
      }

      const pWidth = ctx.measureText(statusText).width + 10;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.fillRect(sx + cellSize / 2 - pWidth / 2, pillY - 7, pWidth, 14);
      ctx.strokeStyle = statusBg;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(sx + cellSize / 2 - pWidth / 2, pillY - 7, pWidth, 14);

      ctx.fillStyle = statusBg;
      ctx.fillText(statusText, sx + cellSize / 2, pillY);

      // Mini progress bar if currently packaging
      if (isPacking && st.currentOrder && st.currentOrder.totalDurationSec) {
        const pct = Math.max(0, Math.min(1.0, 1.0 - (st.currentOrder.remainingSec / st.currentOrder.totalDurationSec)));
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(sx + cellSize / 2 - pWidth / 2, pillY + 8, pWidth, 2.5);
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(sx + cellSize / 2 - pWidth / 2, pillY + 8, pWidth * pct, 2.5);
      }

      ctx.restore();
    }

    function render() {
      if (!mapData) return;
      const dpr = window.devicePixelRatio;
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(camera.x, camera.y);

      const cellSize = camera.scale;

      // 1. Draw Floor grid & corridors
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, mapData.width * cellSize, mapData.height * cellSize);

      // Subtle gridlines
      ctx.strokeStyle = '#172033';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= mapData.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cellSize, 0);
        ctx.lineTo(x * cellSize, mapData.height * cellSize);
        ctx.stroke();
      }
      for (let y = 0; y <= mapData.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cellSize);
        ctx.lineTo(mapData.width * cellSize, y * cellSize);
        ctx.stroke();
      }

      // Collect sets of racks targeted for Inbound Placement (Dotted Blue) vs Outbound Pick (Dotted Red)
      const inboundPlacementRacks = getInboundPlacementRacks();
      const outboundPickRacks = getOutboundPickRacks();
      const animDashOffset = (Date.now() / 45) % 5;

      // 2. Draw Walls & Storage Racks (Darker Grey)
      for (let x = 0; x < mapData.width; x++) {
        for (let y = 0; y < mapData.height; y++) {
          const cell = mapData.grid[x][y];
          if (cell === 1) {
            const isPerimeterWall = (x === 0 || x === mapData.width - 1 || y === 0 || y === mapData.height - 1);
            if (isPerimeterWall) {
              // Outer Perimeter Wall: Darker Matte Industrial Grey
              ctx.fillStyle = '#0e1116';
              ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
              ctx.strokeStyle = '#21262f';
              ctx.lineWidth = 1;
              ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
            } else {
              // Internal Storage Rack: Dark Charcoal Grey with Clean Tier Indicators
              const rackKey = `${x},${y}`;
              const rack = rackMemory[rackKey];
              const occCount = rack ? rack.floors.filter(f => f !== null && !f.isReservedInbound).length : 0;
              const isInboundPlacement = inboundPlacementRacks.has(rackKey);
              const isOutboundPick = outboundPickRacks.has(rackKey);

              ctx.fillStyle = occCount === 5 ? '#1c1917' : (occCount > 0 ? '#111827' : '#151821');
              ctx.fillRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);

              if (isInboundPlacement) {
                // Dotted Blue: A bot is holding the parcel and will place it in a movement
                ctx.save();
                ctx.setLineDash([3, 2]);
                ctx.lineDashOffset = -animDashOffset;
                ctx.strokeStyle = '#38bdf8'; // Bright Vivid Blue
                ctx.lineWidth = 2.0;
                ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
                ctx.restore();
              } else if (isOutboundPick) {
                // Dotted Red: Parcel that will be picked by a bot that is on its way towards that rack
                ctx.save();
                ctx.setLineDash([3, 2]);
                ctx.lineDashOffset = animDashOffset;
                ctx.strokeStyle = '#ef4444'; // Bright Vivid Red
                ctx.lineWidth = 2.0;
                ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
                ctx.restore();
              } else if (occCount === 5) {
                ctx.strokeStyle = '#f59e0b'; // Gold border when all 5 tiers are full
                ctx.lineWidth = 1.5;
                ctx.strokeRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
              } else if (occCount > 0) {
                ctx.strokeStyle = '#38bdf8'; // Clean cyan border when holding inventory
                ctx.lineWidth = 1;
                ctx.strokeRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
              } else {
                if (rack && rack.zone === 'ZONE_A') {
                  ctx.strokeStyle = 'rgba(52, 211, 153, 0.45)'; // Subtle Emerald border for Prime Zone A (Closest to Docks)
                } else if (rack && rack.zone === 'ZONE_B') {
                  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)'; // Subtle Sky Blue for Intermediate Zone B
                } else {
                  ctx.strokeStyle = '#282d37';
                }
                ctx.lineWidth = 1;
                ctx.strokeRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
              }

              // 5-Floor Level indicators (dots or pips)
              if (cellSize >= 14 && occCount > 0) {
                const pipWidth = (cellSize - 4) / 5;
                for (let f = 0; f < occCount; f++) {
                  ctx.fillStyle = occCount === 5 ? '#facc15' : '#38bdf8';
                  ctx.fillRect(x * cellSize + 2 + f * pipWidth, y * cellSize + cellSize - 3.5, pipWidth - 1, 2);
                }
              }
            }
          }
        }
      }

      // 5. Draw Functional Stations
      for (const [sid, st] of Object.entries(mapData.stations)) {
        const sx = st.x * cellSize;
        const sy = st.y * cellSize;
        const type = st.station_type || st.type || '';

        if (type === 'charging' || sid.startsWith('CH')) {
          const port = CHARGING_PORTS.find(p => p.id === sid);
          const isOccupied = port && port.occupiedBy !== null;
          const isReserved = port && port.reservedBy !== null;
          const reserver = isReserved ? AMR_FLEET.find(b => b.id === port.reservedBy) : null;

          if (port && port.isFaulted) {
            // Faulted Charger: Pulsing Hazard Amber/Red with Warning Icon
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 150);
            ctx.fillStyle = '#450a0a';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#7f1d1d';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = `rgba(239, 68, 68, ${0.7 + 0.3 * pulse})`;
            ctx.lineWidth = 2.0;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.setLineDash([]);
            ctx.shadowColor = '#ef4444';
            ctx.shadowBlur = 10 + 6 * pulse;
            ctx.fillStyle = '#fca5a5';
            ctx.font = `bold ${Math.max(9, Math.floor(cellSize * 0.48))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⚠️', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          } else if (isOccupied) {
            // Actively Occupied & Fast Charging (Pulsing Electric Green with Lightning Bolt)
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
            ctx.fillStyle = '#14532d';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#16a34a';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 1.8;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#22c55e';
            ctx.shadowBlur = 12 + 6 * pulse;

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.52))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⚡', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          } else if (isReserved) {
            // Reserved by an incoming robot (Pulsing Cyan Outline)
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = 'rgba(6, 182, 212, 0.25)';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 1.8;
            ctx.setLineDash([4, 2]);
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.setLineDash([]);
            ctx.shadowColor = '#06b6d4';
            ctx.shadowBlur = 10 + 4 * pulse;

            ctx.fillStyle = '#67e8f9';
            ctx.font = `bold ${Math.max(9, Math.floor(cellSize * 0.42))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const shortId = reserver ? reserver.id.replace('AMR-0', '') : 'R';
            ctx.fillText(`R${shortId}`, sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          } else {
            // Free & Available Fast Charger (Clean Emerald Green)
            ctx.fillStyle = '#15803d';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#22c55e';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#86efac';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#22c55e';
            ctx.shadowBlur = 8;

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.55))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('C', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          }
        } else if (type === 'pickup' || sid.startsWith('P')) {
          const q = inboundQueues[sid] || [];
          const hasParcel = q.length > 0;

          if (hasParcel) {
            // Yellow P while holding load waiting for AMR pickup
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
            ctx.fillStyle = '#ca8a04';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#facc15';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#fef08a';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#facc15';
            ctx.shadowBlur = 8 + 6 * pulse;

            ctx.fillStyle = '#0f172a'; // Bold black P on yellow
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.55))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('P', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          } else {
            // Standard Blue P (idle / ready)
            ctx.fillStyle = '#06b6d4';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#67e8f9';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#06b6d4';
            ctx.shadowBlur = 8;

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.5))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('P', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          }
        } else if (type === 'dropoff' || sid.startsWith('D')) {
          const ord = outboundOrders[sid];
          const isAwaitingDeposit = ord !== null && ord !== undefined;

          if (isAwaitingDeposit) {
            // Yellow while awaiting deposit
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 150);
            ctx.fillStyle = '#ca8a04';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#facc15';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#fef08a';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#facc15';
            ctx.shadowBlur = 10 + 6 * pulse;

            ctx.fillStyle = '#0f172a'; // Bold black D on yellow
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.55))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('D', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          } else {
            // Standard Orange D (idle)
            ctx.fillStyle = '#ea580c';
            ctx.fillRect(sx, sy, cellSize, cellSize);
            ctx.fillStyle = '#f97316';
            ctx.fillRect(sx + 1, sy + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = '#fdba74';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 0.5, sy + 0.5, cellSize - 1, cellSize - 1);
            ctx.shadowColor = '#f97316';
            ctx.shadowBlur = 8;

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(10, Math.floor(cellSize * 0.5))}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('D', sx + cellSize / 2, sy + cellSize / 2);
            ctx.shadowBlur = 0;
          }

          // Draw Pack Station Status Banner above/below departure bay
          if (typeof PACK_STATIONS !== 'undefined' && PACK_STATIONS && PACK_STATIONS[sid]) {
            drawPackStationBanner(ctx, PACK_STATIONS[sid], sx, sy, cellSize);
          }
        }
      }

      // 6. Draw AMR Robot Fleet
      for (const robot of AMR_FLEET) {
        drawRobot(ctx, robot, cellSize);
      }

      // 6.5. Draw Simulated Human Workers (Continuous Floor Agents)
      if ((typeof humansEnabled === 'undefined' || humansEnabled) && typeof HUMAN_WORKERS !== 'undefined' && HUMAN_WORKERS) {
        for (const human of HUMAN_WORKERS) {
          drawHumanWorker(ctx, human, cellSize);
        }
      }

      // 7. Draw Collision Sparks / Impact Visuals
      for (let sIdx = COLLISION_SPARKS.length - 1; sIdx >= 0; sIdx--) {
        const spk = COLLISION_SPARKS[sIdx];
        const alpha = Math.max(0, spk.timer / spk.maxTimer);
        const rad = cellSize * (0.8 + (1 - alpha) * 1.2);
        ctx.save();
        ctx.beginPath();
        ctx.arc((spk.x + 0.5) * cellSize, (spk.y + 0.5) * cellSize, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(239, 68, 68, ${alpha * 0.35})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(250, 204, 21, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💥', (spk.x + 0.5) * cellSize, (spk.y + 0.5) * cellSize);
        ctx.restore();
      }

      ctx.restore();
      drawDecentralizedOverlays(ctx, camera);
    }

    // Canvas Interactions
    let dragDownPos = { x: 0, y: 0 };
    let dragDistance = 0;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStart.x = e.clientX - camera.x;
      dragStart.y = e.clientY - camera.y;
      dragDownPos.x = e.clientX;
      dragDownPos.y = e.clientY;
      dragDistance = 0;
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const dx = e.clientX - dragDownPos.x;
        const dy = e.clientY - dragDownPos.y;
        dragDistance = Math.hypot(dx, dy);

        // If user manually pans the canvas, temporarily disengage follow camera
        if (dragDistance > 10 && trackCameraFollow) {
          trackCameraFollow = false;
          const camBtn = document.getElementById('track-cam-toggle-btn');
          if (camBtn) {
            camBtn.classList.remove('active');
            camBtn.innerHTML = '🎥 Cam: OFF';
          }
        }

        camera.x = e.clientX - dragStart.x;
        camera.y = e.clientY - dragStart.y;
        render();
      }

      const rect = canvas.getBoundingClientRect();
      const pos = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
      if (pos) {
        coordsLabel.innerText = `X: ${pos.x}, Y: ${pos.y}`;

        // Check if cursor is hovering over any AMR robot puck
        const mouseGridX = (e.clientX - rect.left - camera.x) / camera.scale;
        const mouseGridY = (e.clientY - rect.top - camera.y) / camera.scale;
        let hoveredRobot = null;
        for (const r of AMR_FLEET) {
          const dist = Math.hypot(mouseGridX - (r.x + 0.5), mouseGridY - (r.y + 0.5));
          if (dist <= 0.6) {
            hoveredRobot = r;
            break;
          }
        }

        if (hoveredRobot) {
          const r = hoveredRobot;
          let stateLabel = 'IDLE';
          let stateColor = '#94a3b8';
          if (r.state === 'IDLE_CHARGING') { stateLabel = 'FAST CHARGING (100%)'; stateColor = '#22c55e'; }
          else if (r.state === 'MOVING_TO_PICKUP') { stateLabel = 'TRANSIT TO DOCK'; stateColor = '#38bdf8'; }
          else if (r.state === 'LOADING_INBOUND') { stateLabel = 'LOADING SHIPMENT'; stateColor = '#facc15'; }
          else if (r.state === 'CARRYING_TO_RACK') { stateLabel = 'SHELVING SHIPMENT'; stateColor = '#facc15'; }
          else if (r.state === 'ORDER_PICKING') { stateLabel = 'CONSOLIDATING ORDER'; stateColor = '#f59e0b'; }
          else if (r.state === 'DELIVERING_ORDER_TO_BAY') { stateLabel = 'DELIVERING GIANT BOX'; stateColor = '#ea580c'; }
          else if (r.state === 'RETURNING_HOME') { stateLabel = 'RETURNING TO BASE'; stateColor = '#10b981'; }

          const batColor = r.battery > 50 ? '#22c55e' : (r.battery > 20 ? '#f59e0b' : '#ef4444');
          const urgency = calculateRobotUrgency(r);
          const urgencyColor = urgency >= 75 ? '#ef4444' : (urgency >= 55 ? '#f97316' : (urgency >= 35 ? '#38bdf8' : '#94a3b8'));
          const overtakeEligible = urgency >= 60;

          // Manifest & Payload description
          let payloadHtml = '<span style="color:#64748b; font-style:italic;">[Deck Empty]</span>';
          let slaHtml = '<span style="color:#94a3b8;">None (Idle Fleet)</span>';
          let weightHtml = '0.0 kg';

          if (r.orderBox) {
            const ob = r.orderBox;
            slaHtml = `<span style="color:${ob.importance ? ob.importance.color : '#f59e0b'}; font-weight:700;">${ob.importance ? ob.importance.label : 'Order Pick'}</span>`;
            weightHtml = `${ob.totalWeight ? ob.totalWeight.toFixed(1) : '5.0'} kg`;
            const itemsList = ob.items && ob.items.length > 0 
              ? ob.items.map(it => `<div style="color:#cbd5e1; font-size:10px;">• ${it.parcel_id} (${it.name}, ${it.weight})</div>`).join('')
              : '<div style="color:#94a3b8; font-size:10px; font-style:italic;">• Collecting items from racks...</div>';
            payloadHtml = `
              <div style="margin-top:2px;">
                <strong style="color:#f59e0b;">📦 Giant Order Box (${ob.orderId}):</strong>
                <span style="color:#e2e8f0; font-size:10px;"> [${ob.items.length}/${ob.totalItems} Items Consolidated]</span>
                <div style="margin-top:2px; padding-left:4px;">${itemsList}</div>
              </div>`;
          } else if (r.carriedParcels && r.carriedParcels.length > 0) {
            const highest = r.carriedParcels[0].importance || IMPORTANCE_TIERS.STANDARD;
            const totW = r.carriedParcels.reduce((sum, p) => sum + (parseFloat(p.weight) || 3), 0);
            slaHtml = `<span style="color:${highest.color}; font-weight:700;">${highest.label}</span>`;
            weightHtml = `${totW.toFixed(1)} kg`;
            const preview = r.carriedParcels.slice(0, 3).map(p => `<div style="color:#cbd5e1; font-size:10px;">• ${p.parcel_id} (${p.name}, ${p.weight})</div>`).join('');
            const more = r.carriedParcels.length > 3 ? `<div style="color:#94a3b8; font-size:9px;">+ ${r.carriedParcels.length - 3} more in tote</div>` : '';
            payloadHtml = `
              <div style="margin-top:2px;">
                <strong style="color:#facc15;">📦 Inbound Shipment Tote:</strong>
                <span style="color:#e2e8f0; font-size:10px;"> [${r.carriedParcels.length} Parcels to Shelf]</span>
                <div style="margin-top:2px; padding-left:4px;">${preview}${more}</div>
              </div>`;
          }

          let trafficStatusHtml = '';
          if (r.isOvertaking) {
            trafficStatusHtml = `<div>Traffic: <strong style="color:#38bdf8;">⚡ Overtaking (Bypass Lane, 1.35x speed)</strong></div>`;
          } else if (r.isRerouting) {
            trafficStatusHtml = `<div>Traffic: <strong style="color:#c084fc;">🔄 Dynamic Detour / Rerouted</strong></div>`;
          } else if (r.isWaiting) {
            trafficStatusHtml = `<div>Traffic: <strong style="color:#f59e0b;">⏳ Yielding to ${r.yieldTo || 'AMR'}</strong></div>`;
          } else {
            trafficStatusHtml = `<div>Traffic: <strong style="color:#22c55e;">✔ Safe Following Distance (${overtakeEligible ? 'Overtake Authorized' : 'Lane Cruise'})</strong></div>`;
          }

          // Realistic BMS Telemetry for Tooltip
          let batteryCardHtml = '';
          if (r.state === 'IDLE_CHARGING') {
            const kw = (r.chargeRateKw || 30.0).toFixed(1);
            const phase = r.chargePhase || 'Bulk CC Phase';
            const chgRate = (r.batteryDeltaRate || 3.5).toFixed(1);
            const timeRemSec = Math.max(0, Math.round((100 - r.battery) / Math.max(0.2, (r.batteryDeltaRate || 2.5))));
            batteryCardHtml = `
              <div style="margin-top:5px; padding:5px 8px; background:rgba(34, 197, 94, 0.08); border:1px solid rgba(34, 197, 94, 0.3); border-radius:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="color:#4ade80; font-weight:700;">⚡ 48V LiFePO4 Fast Charge:</span>
                  <span style="color:#22c55e; font-weight:700;">${r.battery.toFixed(1)}% SoC</span>
                </div>
                <div style="width:100%; height:4px; background:#1e293b; border-radius:2px; margin:4px 0; overflow:hidden;">
                  <div style="width:${r.battery.toFixed(1)}%; height:100%; background:#22c55e;"></div>
                </div>
                <div style="color:#cbd5e1; font-size:10px;">• Charger: <strong>+${kw} kW</strong> (${phase}) [<strong>+${chgRate}%/s</strong>]</div>
                <div style="color:#94a3b8; font-size:10px;">• Time to 100%: <strong>~${timeRemSec}s</strong> | Pack Temp: 32.4°C (Optimal)</div>
              </div>`;
          } else {
            const pTot = Math.round(r.powerWatts || 165);
            const drain = (r.batteryDeltaRate || 0.38).toFixed(2);
            const breakdown = r.powerBreakdown || 'Avionics: 45W | Traction: 120W';
            const activeSecRem = Math.max(1, Math.round((r.battery - 15) / Math.max(0.08, r.batteryDeltaRate || 0.38)));
            const minRem = (activeSecRem / 60).toFixed(1);
            const isLow = r.battery <= 28.0;
            batteryCardHtml = `
              <div style="margin-top:5px; padding:5px 8px; background:${isLow ? 'rgba(239, 68, 68, 0.12)' : 'rgba(15, 23, 42, 0.7)'}; border:1px solid ${isLow ? '#ef4444' : 'rgba(255,255,255,0.1)'}; border-radius:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="color:${isLow ? '#f87171' : '#e2e8f0'}; font-weight:700;">🔋 48V LiFePO4 BMS Battery:</span>
                  <span style="color:${batColor}; font-weight:700;">${r.battery.toFixed(1)}% SoC ${isLow ? '⚠️ LOW' : ''}</span>
                </div>
                <div style="width:100%; height:4px; background:#1e293b; border-radius:2px; margin:4px 0; overflow:hidden;">
                  <div style="width:${r.battery.toFixed(1)}%; height:100%; background:${batColor};"></div>
                </div>
                <div style="color:#cbd5e1; font-size:10px;">• Power Draw: <strong>-${pTot} W</strong> [<strong>-${drain}%/s</strong>]</div>
                <div style="color:#94a3b8; font-size:10px;">• Load: ${breakdown}</div>
                <div style="color:#94a3b8; font-size:10px;">• Est. Range: <strong>~${minRem} min</strong> duty (to 15% reserve) | Temp: 31.8°C</div>
              </div>`;
          }

          const nearestInfo = getNearestAvailableCharger(r.gridX, r.gridY, r.id);
          const minReqSoC = nearestInfo.energyNeeded + SAFETY_RESERVE_SOC;
          const isOk = r.battery >= minReqSoC;

          tooltip.style.display = 'block';
          tooltip.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <strong style="color:#fff; font-size:12px;">🤖 ${r.id} (Autonomous Mobile Robot)</strong>
              <span style="color:${stateColor}; font-weight:700; font-size:10px; padding:1px 5px; background:rgba(255,255,255,0.06); border-radius:3px;">${stateLabel}</span>
            </div>
            <div style="font-size:11px; margin-bottom:4px; line-height:1.5;">
              <div>Target: <strong style="color:#e2e8f0;">${r.targetDesc}</strong></div>
              <div>Nearest Charger: <strong style="color:#4ade80;">${nearestInfo.charger ? nearestInfo.charger.id : 'CH-01'}</strong> (${nearestInfo.distance} cells | Est: ~${nearestInfo.energyNeeded.toFixed(1)}% SoC)</div>
              <div>BMS Energy Budget: ${isOk ? `<strong style="color:#22c55e;">✔ PASS (12% Reserve Safe, +${(r.battery - minReqSoC).toFixed(1)}% margin)</strong>` : `<strong style="color:#ef4444;">🚨 RECHARGE NEEDED (Deficit: ${(minReqSoC - r.battery).toFixed(1)}%)</strong>`}</div>
              <div>Delivery SLA: ${slaHtml}</div>
              <div>Urgency Score: <strong style="color:${urgencyColor};">${urgency}/100</strong> <span style="color:#94a3b8; font-size:10px;">(${overtakeEligible ? 'High - Overtake Authorized' : 'Lane Cruise'})</span></div>
              <div>Cargo Weight: <strong style="color:#e2e8f0;">${weightHtml}</strong></div>
              <div>Kinematic Speed: <strong style="color:#38bdf8;">${(r.currentSpeed || ROBOT_BASE_SPEED).toFixed(2)} cells/s</strong> <span style="color:${r.payloadDamping && r.payloadDamping < 0.99 ? '#f59e0b' : '#94a3b8'}; font-size:10px;">(${r.payloadDamping ? Math.round(r.payloadDamping * 100) : 100}% load throttle)</span></div>
              ${payloadHtml}
              ${batteryCardHtml}
              ${trafficStatusHtml}
            </div>
          `;
        } else {
          // Tooltip inspection for Stations & 3D Storage Racks
          let foundStation = null;
          if (mapData && mapData.stations) {
            for (const s of Object.values(mapData.stations)) {
              if (s.x === pos.x && s.y === pos.y) {
                foundStation = s;
                break;
              }
            }
          }

          if (foundStation) {
            const stype = foundStation.station_type || foundStation.type || '';
            let statusHtml = '';
            if (foundStation.id.startsWith('P')) {
              const q = inboundQueues[foundStation.id] || [];
              if (q.length > 0) {
                const preview = q.slice(0, 3).map(p => `<div style="color:#cbd5e1; font-size:10px;">• ${p.parcel_id} (${p.name}, ${p.weight})</div>`).join('');
                const more = q.length > 3 ? `<div style="color:#94a3b8; font-size:9px;">+ ${q.length - 3} more parcels</div>` : '';
                statusHtml = `
                  <div style="margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);">
                    <span style="color:#facc15; font-weight:700;">📦 HOLDING LOAD (${q.length} Parcels)</span>
                    <div style="margin-top:2px;">${preview}${more}</div>
                    <div style="color:#fde047; font-size:10px; margin-top:2px;">Awaiting AMR Bot Pickup</div>
                  </div>`;
              } else {
                statusHtml = '<div style="margin-top:4px; color:#38bdf8; font-size:11px;">Status: <strong>Ready / Idle</strong> (No waiting parcels)</div>';
              }
            } else if (foundStation.id.startsWith('D')) {
              const ord = outboundOrders[foundStation.id];
              if (ord) {
                statusHtml = `
                  <div style="margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);">
                    <span style="color:#facc15; font-weight:700;">🚚 RECEIVING ORDER ${ord.orderId}</span>
                    <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">Requested: <strong>${ord.totalCount} parcels</strong> from Racks</div>
                    <div style="color:#fde047; font-size:10px; margin-top:2px;">Delivered: <strong>${ord.deliveredCount || 0} / ${ord.totalCount}</strong></div>
                  </div>`;
              } else {
                statusHtml = '<div style="margin-top:4px; color:#f97316; font-size:11px;">Status: <strong>Ready / Idle</strong> for Dispatch</div>';
              }
            } else if (foundStation.id.startsWith('CH') || stype === 'charging') {
              const port = CHARGING_PORTS.find(p => p.id === foundStation.id);
              const occBot = port && port.occupiedBy ? AMR_FLEET.find(b => b.id === port.occupiedBy) : null;
              const resBot = port && port.reservedBy ? AMR_FLEET.find(b => b.id === port.reservedBy) : null;
              if (occBot) {
                statusHtml = `
                  <div style="margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);">
                    <span style="color:#4ade80; font-weight:700;">⚡ OCCUPIED &amp; CHARGING</span>
                    <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">Robot: <strong>${occBot.id}</strong> (${occBot.battery.toFixed(1)}% SoC, +${(occBot.chargeRateKw || 30).toFixed(1)} kW)</div>
                    <div style="color:#94a3b8; font-size:10px;">Phase: ${occBot.chargePhase || 'Fast Charge'}</div>
                  </div>`;
              } else if (resBot) {
                statusHtml = `
                  <div style="margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);">
                    <span style="color:#38bdf8; font-weight:700;">⚡ RESERVED (INCOMING)</span>
                    <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">Reserved by: <strong>${resBot.id}</strong> (${resBot.battery.toFixed(1)}% SoC)</div>
                    <div style="color:#38bdf8; font-size:10px;">En route to dock contact pad</div>
                  </div>`;
              } else {
                statusHtml = '<div style="margin-top:4px; color:#22c55e; font-size:11px;">⚡ <strong>Free &amp; Ready</strong> (30kW CC/CV Fast Pad Ready)</div>';
              }
            }

            tooltip.style.display = 'block';
            tooltip.innerHTML = `
              <div style="font-weight:700; color:#fff; display:flex; justify-content:space-between; gap:6px;">
                <span>${foundStation.id}: ${foundStation.name}</span>
              </div>
              <div style="color:#94a3b8; font-size:10px;">Zone: ${foundStation.zone} | Grid: (${foundStation.x}, ${foundStation.y})</div>
              ${statusHtml}
            `;
          } else {
            // Check 3D Storage Rack Memory at (x, y)
            const rackKey = `${pos.x},${pos.y}`;
            const rack = rackMemory[rackKey];
            if (rack) {
              let occ = 0;
              let tiersHtml = '';
              const catName = rack.categoryFullName || rack.categoryName || 'General';
              const catSku = rack.categorySku || '';

              for (let f = MAX_FLOORS - 1; f >= 0; f--) {
                const p = rack.floors[f];
                const floorNum = f + 1;
                if (p) {
                  if (p.isReservedInbound) {
                    tiersHtml += `
                      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:2px 5px; background:rgba(56,189,248,0.06); border-left:3px dashed #38bdf8; margin:2px 0; border-radius:2px; font-size:10px;">
                        <span style="color:#38bdf8;">Tier ${floorNum}:</span>
                        <span style="color:#94a3b8; font-style:italic;">[Reserved: ${p.parcel_id}]</span>
                        <span style="color:#64748b;">AMR en route</span>
                      </div>`;
                  } else {
                    occ++;
                    const parcelObj = p.isReservedOutbound ? p.parcel || p : p;
                    const subTag = p.isReservedOutbound ? '<span style="color:#f59e0b; font-size:9px;">[Retrieving]</span>' : '';
                    tiersHtml += `
                      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:2px 5px; background:rgba(56,189,248,0.12); border-left:3px solid #38bdf8; margin:2px 0; border-radius:2px;">
                        <span style="color:#38bdf8; font-weight:700; font-size:10px;">Tier ${floorNum}:</span>
                        <span style="color:#f8fafc; font-weight:600; font-size:10px;">${parcelObj.parcel_id} ${subTag}</span>
                        <span style="color:#cbd5e1; font-size:9px;">${parcelObj.name.split(' ')[0]} (${parcelObj.weight})</span>
                      </div>`;
                  }
                } else {
                  tiersHtml += `
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:2px 5px; background:rgba(255,255,255,0.02); border-left:3px solid #334155; margin:2px 0; border-radius:2px; color:#64748b; font-size:10px;">
                      <span>Tier ${floorNum}:</span>
                      <span style="font-style:italic;">[Empty Slot]</span>
                      <span>-</span>
                    </div>`;
                }
              }

              const isInboundPlacement = getInboundPlacementRacks().has(rackKey);
              const isOutboundPick = getOutboundPickRacks().has(rackKey);
              let transitBanner = '';

              if (isInboundPlacement) {
                transitBanner = `
                  <div style="display:flex; align-items:center; gap:5px; margin-bottom:5px; padding:3px 6px; background:rgba(56,189,248,0.12); border:1.5px dashed #38bdf8; border-radius:3px; font-size:10px; color:#38bdf8; font-weight:700;">
                    <span>📥 DOTTED BLUE:</span>
                    <span style="color:#e2e8f0; font-weight:normal;">Bot is holding parcel & en route to place it</span>
                  </div>`;
              } else if (isOutboundPick) {
                transitBanner = `
                  <div style="display:flex; align-items:center; gap:5px; margin-bottom:5px; padding:3px 6px; background:rgba(239,68,68,0.12); border:1.5px dashed #ef4444; border-radius:3px; font-size:10px; color:#ef4444; font-weight:700;">
                    <span>📤 DOTTED RED:</span>
                    <span style="color:#e2e8f0; font-weight:normal;">Bot is on its way to pick parcel</span>
                  </div>`;
              }

              const badgeColor = occ === 5 ? '#f59e0b' : (occ > 0 ? '#38bdf8' : '#64748b');
              const statusLabel = occ === 5 ? 'FULL (5/5)' : (occ > 0 ? `STORED (${occ}/5)` : 'VACANT (0/5)');

              tooltip.style.display = 'block';
              tooltip.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                  <strong style="color:#fff;">3D STORAGE RACK</strong>
                  <span style="color:${badgeColor}; font-weight:700; font-size:10px; padding:1px 5px; background:rgba(255,255,255,0.05); border-radius:3px;">${statusLabel}</span>
                </div>
                ${transitBanner}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:10px;">
                  <span style="color:#94a3b8;">Row: <strong style="color:#e2e8f0;">${catName}</strong> (${catSku})</span>
                  <span style="color:#94a3b8;">(${pos.x}, ${pos.y})</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:1px;">
                  ${tiersHtml}
                </div>
              `;
            } else {
              tooltip.style.display = 'none';
            }
          }
        }

        // Clamp tooltip position within screen bounds
        if (tooltip.style.display === 'block') {
          const tw = 310;
          const th = 280;
          let left = e.clientX + 14;
          let top = e.clientY + 14;
          if (left + tw > window.innerWidth) left = Math.max(10, e.clientX - tw - 14);
          if (top + th > window.innerHeight) top = Math.max(10, e.clientY - th - 14);
          tooltip.style.left = left + 'px';
          tooltip.style.top = top + 'px';
        }
      } else {
        coordsLabel.innerText = '-';
        tooltip.style.display = 'none';
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (isDragging) {
        // If minimal mouse movement occurred, treat as direct click-to-track on robot
        if (dragDistance < 6) {
          const rect = canvas.getBoundingClientRect();
          const clickGridX = (e.clientX - rect.left - camera.x) / camera.scale;
          const clickGridY = (e.clientY - rect.top - camera.y) / camera.scale;
          let clickedBot = null;
          for (const r of AMR_FLEET) {
            const dist = Math.hypot(clickGridX - (r.x + 0.5), clickGridY - (r.y + 0.5));
            if (dist <= 0.65) {
              clickedBot = r;
              break;
            }
          }
          if (clickedBot) {
            trackBot(clickedBot.id, true);
          }
        }
        isDragging = false;
      }
    });

    // Keyboard Shortcuts for Bot Tracking & Fleet Navigation
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        toggleTrackCameraFollow();
      } else if (e.key === 'c' || e.key === 'C') {
        centerOnTrackedBot();
      } else if (e.key === 'ArrowRight' || e.key === ']') {
        cycleTrackedRobot(1);
      } else if (e.key === 'ArrowLeft' || e.key === '[') {
        cycleTrackedRobot(-1);
      } else if (e.key === 'Escape') {
        stopTrackingBot();
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newScale = Math.min(80, Math.max(8, camera.scale * zoomFactor));
      camera.x = mouseX - (mouseX - camera.x) * (newScale / camera.scale);
      camera.y = mouseY - (mouseY - camera.y) * (newScale / camera.scale);
      camera.scale = newScale;
      render();
    });

    // Setup & start
    resize();
    loadMap();
  