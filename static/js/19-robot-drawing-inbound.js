    // Industrial Visual Rendering (Safety Buffers, Status Badges, Dynamic Trajectories)
    function drawRobot(ctx, r, cellSize) {
      const cx = (r.x + 0.5) * cellSize;
      const cy = (r.y + 0.5) * cellSize;
      const radius = Math.max(4, cellSize * 0.32); // Reduced from 0.42

      // 1. Dynamic Trajectory Breadcrumbs with 45° Rounded Fillet Curves
      if (r.path && r.path.length > 0 && r.pathIndex < r.path.length) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);

        const radiusCorner = Math.max(3, cellSize * 0.40);
        const rawPts = r.path.slice(r.pathIndex);

        // Sanitize points to guarantee zero diagonal clipping
        const remPts = [];
        let curX = Math.round(r.x);
        let curY = Math.round(r.y);
        for (const pt of rawPts) {
          if (!pt) continue;
          if (Math.abs(pt.x - curX) > 1.5 || Math.abs(pt.y - curY) > 1.5) {
            break; // Stop at any jump to prevent drawing diagonal vectors across the map
          }
          remPts.push(pt);
          curX = pt.x;
          curY = pt.y;
        }

        if (remPts.length === 1) {
          ctx.lineTo((remPts[0].x + 0.5) * cellSize, (remPts[0].y + 0.5) * cellSize);
        } else if (remPts.length > 1) {
          for (let i = 0; i < remPts.length - 1; i++) {
            const p1 = remPts[i];
            const p2 = remPts[i + 1];
            ctx.arcTo((p1.x + 0.5) * cellSize, (p1.y + 0.5) * cellSize, (p2.x + 0.5) * cellSize, (p2.y + 0.5) * cellSize, radiusCorner);
          }
          const lastPt = remPts[remPts.length - 1];
          ctx.lineTo((lastPt.x + 0.5) * cellSize, (lastPt.y + 0.5) * cellSize);
        }
        let trailColor = 'rgba(56, 189, 248, 0.45)';
        if (r.id === trackedRobotId) {
          trailColor = '#38bdf8';
        } else if (r.isOvertaking) {
          trailColor = 'rgba(56, 189, 248, 0.95)'; // Bright overtake line
        } else if (r.isRerouting) {
          trailColor = 'rgba(192, 132, 252, 0.85)'; // Purple reroute line
        } else if (r.isLoadedYellow) {
          trailColor = 'rgba(250, 204, 21, 0.85)'; // Yellow trail when carrying inbound shipment!
        } else if (r.orderBox) {
          trailColor = r.orderBox.importance ? r.orderBox.importance.color : 'rgba(245, 158, 11, 0.7)';
        } else if (r.state === 'RETURNING_HOME') {
          trailColor = 'rgba(34, 197, 94, 0.4)';
        }
        ctx.strokeStyle = trailColor;
        if (r.id === trackedRobotId) {
          ctx.lineWidth = Math.max(2.2, cellSize * 0.14);
          ctx.setLineDash([6, 3]);
          ctx.lineDashOffset = -((Date.now() / 40) % 9);
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 8;
        } else {
          ctx.lineWidth = r.isOvertaking || r.isRerouting ? Math.max(1.8, cellSize * 0.12) : Math.max(1.2, cellSize * 0.08);
          ctx.setLineDash(r.isOvertaking ? [6, 3] : [3, 3]);
        }
        ctx.stroke();

        // If tracked robot, render holographic waypoint dots & destination beacon
        if (r.id === trackedRobotId) {
          ctx.shadowBlur = 0;
          for (let i = r.pathIndex; i < r.path.length; i++) {
            const pt = r.path[i];
            ctx.beginPath();
            ctx.arc((pt.x + 0.5) * cellSize, (pt.y + 0.5) * cellSize, Math.max(2, cellSize * 0.07), 0, Math.PI * 2);
            ctx.fillStyle = '#38bdf8';
            ctx.fill();
          }

          // Destination Beacon
          const dest = r.path[r.path.length - 1];
          if (dest) {
            const destX = (dest.x + 0.5) * cellSize;
            const destY = (dest.y + 0.5) * cellSize;
            const beaconR = (cellSize * 0.45) + Math.sin(Date.now() / 160) * (cellSize * 0.1);

            // Pulsing target ring
            ctx.beginPath();
            ctx.arc(destX, destY, beaconR, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.lineWidth = 1.8;
            ctx.setLineDash([3, 3]);
            ctx.stroke();

            // Destination icon
            ctx.font = `${Math.max(10, Math.floor(cellSize * 0.6))}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🏁', destX, destY);
          }
        }

        ctx.restore();
      }

      // 1.8. Simulated 2D Safety Laser (LiDAR) Perception Field & Obstacle Tracking
      if (r.id === trackedRobotId && r.state !== 'IDLE_CHARGING' && r.state !== 'OUT_OF_CHARGE') {
        const sRange = (r.sensorRange || 6.0) * cellSize;
        const halfFov = (r.sensorFovRad || (220 * Math.PI / 180)) / 2;
        const confCount = (r.perception && r.perception.confirmedObstacles) ? r.perception.confirmedObstacles.length : 0;
        const hasEmergency = (r.perception && r.perception.confirmedObstacles) ? r.perception.confirmedObstacles.some(o => o.dist < 2.2) : false;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(r.heading);

        // Forward LiDAR scan arc
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, sRange, -halfFov, halfFov);
        ctx.closePath();

        const grad = ctx.createRadialGradient(0, 0, radius, 0, 0, sRange);
        if (hasEmergency) {
          grad.addColorStop(0, 'rgba(239, 68, 68, 0.40)');
          grad.addColorStop(0.6, 'rgba(239, 68, 68, 0.15)');
          grad.addColorStop(1, 'rgba(239, 68, 68, 0.02)');
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
        } else if (confCount > 0) {
          grad.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
          grad.addColorStop(0.6, 'rgba(245, 158, 11, 0.12)');
          grad.addColorStop(1, 'rgba(245, 158, 11, 0.02)');
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
        } else {
          grad.addColorStop(0, 'rgba(6, 182, 212, 0.22)');
          grad.addColorStop(0.7, 'rgba(6, 182, 212, 0.08)');
          grad.addColorStop(1, 'rgba(6, 182, 212, 0.01)');
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
        }
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Close-proximity 360-degree bumper perimeter ring
        const bRad = (r.blindSpotRadius || 0.85) * cellSize;
        ctx.beginPath();
        ctx.arc(0, 0, bRad, 0, Math.PI * 2);
        ctx.strokeStyle = hasEmergency ? 'rgba(239, 68, 68, 0.8)' : 'rgba(56, 189, 248, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        // Perceived Obstacle Tracking Crosshairs & Vectors
        if (r.perception && r.perception.confirmedObstacles && r.perception.confirmedObstacles.length > 0) {
          for (const obs of r.perception.confirmedObstacles) {
            const ox = (obs.x + 0.5) * cellSize;
            const oy = (obs.y + 0.5) * cellSize;
            ctx.save();
            ctx.beginPath();
            ctx.arc(ox, oy, cellSize * 0.32, 0, Math.PI * 2);
            ctx.strokeStyle = obs.type === 'HUMAN' ? '#a3e635' : (obs.dist < 2.2 ? '#ef4444' : '#38bdf8');
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Laser beam rayline from sensor to target
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ox, oy);
            ctx.strokeStyle = obs.dist < 2.2 ? 'rgba(239, 68, 68, 0.65)' : 'rgba(56, 189, 248, 0.4)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Label tag
            ctx.fillStyle = '#fff';
            ctx.font = '9px monospace';
            ctx.fillText(`${obs.id} (${obs.dist.toFixed(1)}c)`, ox + 6, oy - 4);
            ctx.restore();
          }
        }
      }

      ctx.save();
      ctx.translate(cx, cy);

      // 2. Active Safety Clearance Buffer Ring
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.15, 0, Math.PI * 2); // Tighter visual safety ring
      if (r.state === 'HARDWARE_FAULT' || r.isFaulted || r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 90);
        ctx.strokeStyle = `rgba(239, 68, 68, ${0.7 + 0.3 * pulse})`;
        ctx.lineWidth = 2.8;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
      } else if (r.isWaiting) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
        ctx.strokeStyle = `rgba(245, 158, 11, ${0.4 + 0.5 * pulse})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
      } else if (r.state === 'LOADING_INBOUND' || r.isLoadedYellow) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 90);
        ctx.strokeStyle = `rgba(250, 204, 21, ${0.6 + 0.4 * pulse})`;
        ctx.lineWidth = 2.0;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
      } else if (r.isOvertaking) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
      } else if (r.isRerouting) {
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();

      // Radar Ping Ripple when located from Problem Dashboard
      if (r.mapPingTimer > 0) {
        const pingProgress = 1.0 - (r.mapPingTimer / 4.0);
        const pingRad = radius * (1.2 + pingProgress * 2.8);
        const pingAlpha = Math.max(0, 1.0 - pingProgress);
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, pingRad, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(56, 189, 248, ${pingAlpha})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, pingRad * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${pingAlpha * 0.8})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // 3. Status Ring Colors & Halo
      let ringColor = '#38bdf8';
      let glowColor = 'rgba(56, 189, 248, 0.6)';
      if (r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0) {
        ringColor = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.95)';
      } else if (r.state === 'IDLE_CHARGING') {
        ringColor = '#22c55e';
        glowColor = 'rgba(34, 197, 94, 0.7)';
      } else if (r.state === 'LOADING_INBOUND') {
        ringColor = '#facc15';
        glowColor = 'rgba(250, 204, 21, 0.95)';
      } else if (r.isLoadedYellow) {
        ringColor = '#facc15'; // Glowing golden yellow chassis when carrying inbound load!
        glowColor = 'rgba(250, 204, 21, 0.85)';
      } else if (r.isWaiting) {
        ringColor = '#f59e0b';
        glowColor = 'rgba(245, 158, 11, 0.85)';
      } else if (r.isOvertaking) {
        ringColor = '#38bdf8';
        glowColor = 'rgba(56, 189, 248, 0.9)';
      } else if (r.isRerouting) {
        ringColor = '#a855f7';
        glowColor = 'rgba(168, 85, 247, 0.9)';
      } else if (r.orderBox) {
        ringColor = r.orderBox.importance ? r.orderBox.importance.color : '#f59e0b';
        glowColor = ringColor;
      } else if (r.state === 'RETURNING_HOME') {
        ringColor = '#10b981';
        glowColor = 'rgba(16, 185, 129, 0.6)';
      }

      ctx.shadowColor = glowColor;
      ctx.shadowBlur = (r.state === 'OUT_OF_CHARGE' || r.isLoadedYellow || r.isWaiting || r.isOvertaking) ? 12 : (r.state === 'IDLE_CHARGING' ? 6 : 8);

      // 4. Robot Chassis
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, cellSize * 0.08);
      ctx.strokeStyle = ringColor;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Inner deck
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.78, 0, Math.PI * 2);
      ctx.fillStyle = '#1e293b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 5. Heading Indicator
      ctx.save();
      ctx.rotate(r.heading);
      ctx.fillStyle = ringColor;
      ctx.beginPath();
      ctx.moveTo(radius * 0.88, 0);
      ctx.lineTo(radius * 0.45, -radius * 0.32);
      ctx.lineTo(radius * 0.45, radius * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 5.5. Dynamic Kinematics Visuals:
      // A. Active Brake Taillights (Red LEDs + bloom during deceleration/AEB)
      if (r.isBraking || (r.brakeLightTimer && r.brakeLightTimer > 0)) {
        ctx.save();
        ctx.rotate(r.heading);
        const bAlpha = Math.max(0.4, Math.min(1.0, (r.brakeLightTimer || 0) / 0.45));
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = Math.max(6, cellSize * 0.35);
        ctx.fillStyle = `rgba(239, 68, 68, ${bAlpha})`;
        const lightW = Math.max(2, radius * 0.22);
        const lightH = Math.max(2, radius * 0.28);
        ctx.fillRect(-radius * 0.90, -radius * 0.48, lightW, lightH);
        ctx.fillRect(-radius * 0.90, radius * 0.20, lightW, lightH);
        ctx.restore();
      }

      // B. Dynamic Amber Cornering Turn Signals (flashes on turning flank)
      if (r.isTurning || (r.turnIndicatorTimer && r.turnIndicatorTimer > 0)) {
        ctx.save();
        ctx.rotate(r.heading);
        const blinkPhase = Math.sin(Date.now() / 70) > 0;
        if (blinkPhase) {
          ctx.shadowColor = '#f59e0b';
          ctx.shadowBlur = Math.max(6, cellSize * 0.35);
          ctx.fillStyle = '#f59e0b';
          const indR = Math.max(1.8, radius * 0.18);
          if (!r.turnDirection || r.turnDirection === 'LEFT') {
            ctx.beginPath();
            ctx.arc(0, -radius * 0.82, indR, 0, Math.PI * 2);
            ctx.fill();
          }
          if (!r.turnDirection || r.turnDirection === 'RIGHT') {
            ctx.beginPath();
            ctx.arc(0, radius * 0.82, indR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 6. Physical Cargo Presentation:
      // Case A: Inbound Shipment Tote (illuminates Golden Yellow)
      if (r.isLoadedYellow || (r.carriedParcels && r.carriedParcels.length > 0)) {
        const toteW = radius * 1.35;
        const toteH = radius * 1.1;
        ctx.fillStyle = '#ca8a04';
        ctx.fillRect(-toteW / 2, -toteH / 2, toteW, toteH);
        ctx.fillStyle = '#facc15';
        ctx.fillRect(-toteW / 2 + 1, -toteH / 2 + 1, toteW - 2, toteH - 2);
        ctx.strokeStyle = '#a16207';
        ctx.lineWidth = 1;
        ctx.strokeRect(-toteW / 2, -toteH / 2, toteW, toteH);

        // Tote parcel count badge
        ctx.fillStyle = '#0f172a';
        ctx.font = `bold ${Math.max(8, Math.floor(radius * 0.75))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${r.carriedParcels ? r.carriedParcels.length : 0}`, 0, 0);

      // Case B: Outbound Customer Order - 1 Giant Box / Tote
      } else if (r.orderBox) {
        const boxSize = radius * 1.35;
        const half = boxSize / 2;
        ctx.fillStyle = '#92400e';
        ctx.fillRect(-half, -half, boxSize, boxSize);
        ctx.fillStyle = '#b45309';
        ctx.fillRect(-half + 1, -half + 1, boxSize - 2, boxSize - 2);

        // SLA Colored Ribbon across center
        ctx.fillStyle = r.orderBox.importance ? r.orderBox.importance.color : '#facc15';
        ctx.fillRect(-half, -2, boxSize, 4);

        // White shipping label with "x/y" items consolidated
        const labelW = boxSize * 0.72;
        const labelH = boxSize * 0.45;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-labelW / 2, -labelH / 2, labelW, labelH);
        ctx.fillStyle = '#0f172a';
        ctx.font = `bold ${Math.max(7, Math.floor(radius * 0.55))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${r.orderBox.items.length}/${r.orderBox.totalItems}`, 0, 0);

        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1;
        ctx.strokeRect(-half, -half, boxSize, boxSize);

      // Case C: Empty deck (Number)
      } else {
        ctx.fillStyle = '#f8fafc';
        ctx.font = `bold ${Math.max(8, Math.floor(radius * 0.95))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${r.num}`, 0, -1);
      }

      // 6.5. Persistent BMS Battery Gauge Bar (Visible on ALL robots: empty or carrying cargo)
      if (cellSize >= 11) {
        const batWidth = radius * 1.15;
        const batHeight = Math.max(2.2, cellSize * 0.08);
        const batY = radius * 0.65;
        const batPct = Math.max(0, Math.min(1, r.battery / 100.0));

        // Gauge background track
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(-batWidth / 2, batY, batWidth, batHeight);
        ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)';
        ctx.lineWidth = 0.6;
        ctx.strokeRect(-batWidth / 2, batY, batWidth, batHeight);

        // Dynamic battery fill color (Green > 50%, Amber 25-50%, Blinking Red <= 25%)
        let barColor = '#22c55e';
        if (r.battery <= 25.0) {
          const blink = (Date.now() % 400) < 200;
          barColor = blink ? '#ef4444' : '#991b1b';
        } else if (r.battery <= 50.0) {
          barColor = '#f59e0b';
        }

        ctx.fillStyle = barColor;
        ctx.fillRect(-batWidth / 2 + 0.5, batY + 0.5, Math.max(0, (batWidth - 1) * batPct), batHeight - 1);

        // Charging indicator bolt
        if (r.state === 'IDLE_CHARGING') {
          ctx.fillStyle = '#4ade80';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText('⚡', batWidth / 2 + 1, batY + batHeight / 2);
        }
      }

      // 7. Floating Action Status Badge Pill above Robot
      let badgeText = r.statusBadge;
      let badgeBg = '#0284c7';
      let badgeBorder = '#38bdf8';

      if (r.isWaiting) {
        badgeText = 'WAIT';
        badgeBg = '#b45309';
        badgeBorder = '#f59e0b';
      } else if (r.isOvertaking) {
        badgeText = 'WAIT';
        badgeBg = '#b45309';
        badgeBorder = '#f59e0b';
      } else if (r.isOvertaking) {
        badgeText = 'PASS 1.35x';
        badgeBg = '#0369a1';
        badgeBorder = '#38bdf8';
      } else if (r.isRerouting) {
        badgeText = 'REROUTE';
        badgeBg = '#7e22ce';
        badgeBorder = '#c084fc';
      } else if (r.state === 'LOADING_INBOUND') {
        badgeText = 'LOAD';
        badgeBg = '#ca8a04';
        badgeBorder = '#facc15';
      } else if (r.state === 'CARRYING_TO_RACK') {
        badgeText = `SHELVE ${r.carriedParcels ? r.carriedParcels.length : ''}`;
        badgeBg = '#ca8a04';
        badgeBorder = '#facc15';
      } else if (r.state === 'ORDER_PICKING' && r.orderBox) {
        badgeText = `PICK ${r.orderBox.items.length}/${r.orderBox.totalItems}`;
        badgeBg = '#d97706';
        badgeBorder = '#fbbf24';
      } else if (r.statusBadge === 'YIELD HUMAN') {
        badgeText = 'YIELD HUMAN';
        badgeBg = '#7f1d1d';
        badgeBorder = '#ef4444';
      } else if (r.statusBadge && r.statusBadge.startsWith('SLOW:')) {
        badgeText = r.statusBadge;
        badgeBg = '#854d0e';
        badgeBorder = '#facc15';
      } else if (r.state === 'WAITING_FOR_PACKER' || r.statusBadge === 'STATION BUSY') {
        badgeText = 'PACKER BUSY';
        badgeBg = '#7c2d12';
        badgeBorder = '#f97316';
      } else if (r.state === 'HANDOFF_TO_PACKER' || r.statusBadge === 'HANDOFF') {
        badgeText = 'HANDOFF';
        badgeBg = '#0369a1';
        badgeBorder = '#38bdf8';
      } else if (r.state === 'DELIVERING_ORDER_TO_BAY') {
        badgeText = 'ORDER BOX';
        badgeBg = '#ea580c';
        badgeBorder = '#fb923c';
      } else if (r.state === 'OUT_OF_CHARGE' || r.battery <= 10.0) {
        badgeText = 'LOW 10%';
        badgeBg = '#7f1d1d';
        badgeBorder = '#ef4444';
      } else if (r.battery <= 25.0 && r.state !== 'IDLE_CHARGING') {
        badgeText = 'LOW BATT';
        badgeBg = '#b91c1c';
        badgeBorder = '#ef4444';
      } else if (r.state === 'IDLE_CHARGING' && r.battery < 99.5) {
        badgeText = `⚡ ${Math.round(r.battery)}%`;
        badgeBg = '#14532d';
        badgeBorder = '#22c55e';
      } else if (r.state === 'MARKED_FOR_MAINTENANCE' || r.isUnderMaintenance || r.state === 'HARDWARE_FAULT' || r.isFaulted) {
        badgeText = r.statusBadge || 'MAINTENANCE';
        badgeBg = '#7f1d1d';
        badgeBorder = '#ef4444';
      } else if (r.statusBadge && r.statusBadge.includes('CHG QUEUE')) {
        badgeText = r.statusBadge;
        badgeBg = '#9a3412';
        badgeBorder = '#f97316';
      } else if (r.statusBadge === 'CHG TRIP') {
        badgeText = 'CHG TRIP';
        badgeBg = '#7f1d1d';
        badgeBorder = '#ef4444';
      }

      if (badgeText) {
        const badgeY = -radius - 8;
        ctx.font = 'bold 8px monospace';
        const tw = ctx.measureText(badgeText).width;
        const pw = tw + 8;
        const ph = 11;

        ctx.fillStyle = badgeBg;
        ctx.fillRect(-pw / 2, badgeY - ph / 2, pw, ph);
        ctx.strokeStyle = badgeBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(-pw / 2, badgeY - ph / 2, pw, ph);

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, 0, badgeY);
      }

      // 8. Holographic Targeting Reticle for Tracked Robot
      if (r.id === trackedRobotId) {
        ctx.save();
        const reticleTime = Date.now();
        const reticleAngle = (reticleTime / 1200) % (Math.PI * 2);
        const bracketOffset = radius * 1.55 + Math.sin(reticleTime / 180) * 1.5;
        const bracketLen = Math.max(4, radius * 0.45);

        // Neon Glow
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = Math.max(1.8, cellSize * 0.1);

        // 4 Corner Brackets [ ]
        // Top-Left
        ctx.beginPath();
        ctx.moveTo(-bracketOffset, -bracketOffset + bracketLen);
        ctx.lineTo(-bracketOffset, -bracketOffset);
        ctx.lineTo(-bracketOffset + bracketLen, -bracketOffset);
        ctx.stroke();

        // Top-Right
        ctx.beginPath();
        ctx.moveTo(bracketOffset - bracketLen, -bracketOffset);
        ctx.lineTo(bracketOffset, -bracketOffset);
        ctx.lineTo(bracketOffset, -bracketOffset + bracketLen);
        ctx.stroke();

        // Bottom-Right
        ctx.beginPath();
        ctx.moveTo(bracketOffset, bracketOffset - bracketLen);
        ctx.lineTo(bracketOffset, bracketOffset);
        ctx.lineTo(bracketOffset - bracketLen, bracketOffset);
        ctx.stroke();

        // Bottom-Left
        ctx.beginPath();
        ctx.moveTo(-bracketOffset + bracketLen, bracketOffset);
        ctx.lineTo(-bracketOffset, bracketOffset);
        ctx.lineTo(-bracketOffset, bracketOffset - bracketLen);
        ctx.stroke();

        // Rotating dashed compass ring
        ctx.save();
        ctx.rotate(reticleAngle);
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.35, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.restore();

        // Top targeting badge header: "🎯 AMR-0X"
        const tagText = `🎯 ${r.id}`;
        ctx.font = 'bold 9px monospace';
        const tagTw = ctx.measureText(tagText).width;
        const tagPw = tagTw + 10;
        const tagPh = 13;
        const tagY = -bracketOffset - (badgeText ? 18 : 9);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(-tagPw / 2, tagY - tagPh / 2, tagPw, tagPh);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-tagPw / 2, tagY - tagPh / 2, tagPw, tagPh);

        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tagText, 0, tagY);

        ctx.restore();
      }

      ctx.restore();
    }

    // Inbound Shipment: dock receives r parcels (1 < r < 8), stays lit yellow until 1 assigned AMR picks up
    function triggerInboundShipment() {
      if (!mapData || !mapData.stations) return;
      const pickups = Object.keys(mapData.stations).filter(id => id.startsWith('P'));
      if (pickups.length === 0) return;

      // Select an available dock that isn't already holding a pending shipment
      const availableDocks = pickups.filter(id => (inboundQueues[id] || []).length === 0 && !inboundMissions.some(m => m.dockId === id));
      if (availableDocks.length === 0) return;

      const chosenDock = availableDocks[Math.floor(Math.random() * availableDocks.length)];
      const r = Math.floor(Math.random() * 4) + 2; // 2 to 5 parcels per shipment batch

      // Random delivery importance for shipment SLA
      const randVal = Math.random();
      let importance = IMPORTANCE_TIERS.STANDARD;
      if (randVal < 0.15) importance = IMPORTANCE_TIERS.VIP_EXPRESS;
      else if (randVal < 0.40) importance = IMPORTANCE_TIERS.SAME_DAY;
      else if (randVal < 0.85) importance = IMPORTANCE_TIERS.STANDARD;
      else importance = IMPORTANCE_TIERS.ECONOMY;

      const batch = [];
      let totalWeight = 0;

      for (let i = 0; i < r; i++) {
        parcelSequence++;
        const skuInfo = SKU_CATALOG[Math.floor(Math.random() * SKU_CATALOG.length)];
        const weightVal = parseFloat((skuInfo.weight + (Math.random() * 3 - 1.5)).toFixed(1));
        totalWeight += weightVal;
        batch.push({
          parcel_id: `PKG-${parcelSequence}`,
          sku: skuInfo.sku,
          name: skuInfo.name,
          weight: `${weightVal}kg`,
          weightVal: weightVal,
          importance: importance,
          dock: chosenDock,
          timestamp: new Date().toLocaleTimeString()
        });
      }

      // Reserve slots in 3D storage racks using ABC / Velocity & Proximity Policy
      const validBatch = [];
      const dockStation = mapData.stations[chosenDock];
      for (const parcel of batch) {
        const slot = findOptimalSlotForSku(parcel.sku, chosenDock, 'ABC_VELOCITY');
        if (slot) {
          slot.rack.floors[slot.floorIndex] = { isReservedInbound: true, parcel_id: parcel.parcel_id, parcel: parcel };
          parcel.rackSlot = slot;
          validBatch.push(parcel);

          // Track Stow Travel Distance Metric
          const sDist = dockStation ? (Math.abs(slot.rack.x - dockStation.x) + Math.abs(slot.rack.y - dockStation.y)) : (slot.rack.dockCost || 20);
          WAREHOUSE_SLOTTING_METRICS.totalStowsExecuted++;
          WAREHOUSE_SLOTTING_METRICS.totalStowDistanceCells += sDist;
          WAREHOUSE_SLOTTING_METRICS.averageStowDistanceCells = Number(
            (WAREHOUSE_SLOTTING_METRICS.totalStowDistanceCells / WAREHOUSE_SLOTTING_METRICS.totalStowsExecuted).toFixed(1)
          );
        } else {
          logTerminal('ALERT', 'tag-outbound', `⚠️ Warehouse Full! No empty tier available for parcel <strong>${parcel.parcel_id}</strong> from ${chosenDock}.`);
        }
      }

      if (validBatch.length === 0) return;

      inboundQueues[chosenDock].push(...validBatch);

      const st = mapData.stations[chosenDock];
      const zoneName = st ? st.zone : 'Inbound';
      const idRange = validBatch.length > 1 ? `${validBatch[0].parcel_id}..${validBatch[validBatch.length - 1].parcel_id}` : validBatch[0].parcel_id;

      logTerminal('INBOUND', 'tag-inbound', `📦 Inbound Dock <strong>${chosenDock}</strong> (${zoneName}) received shipment of <strong>${validBatch.length} parcels</strong> (${idRange}, ${totalWeight.toFixed(1)}kg, <span style="color:${importance.color};font-weight:700;">${importance.label}</span>) | Dock holding load: <span style="color:#facc15;font-weight:700;">LIT YELLOW</span>`);

      // Queue exactly ONE Inbound Mission (1 AMR assigned, no zombie swarm!)
      const shipmentSimTime = Number((totalSimSeconds || 0).toFixed(2));
      recordInboundShipmentReceived(chosenDock, parcelSequence, validBatch.length, totalWeight, importance);
      inboundMissions.push({
        id: `INB-${parcelSequence}`,
        dockId: chosenDock,
        dockX: st.x,
        dockY: st.y,
        parcels: validBatch,
        totalWeight: totalWeight,
        importance: importance,
        createdAt: Date.now(),
        createdSimTimeSec: shipmentSimTime,
        status: 'PENDING',
        assignedRobotId: null
      });

      updateSlottingComplianceStats();
      updateHudStats();
      dispatchFleet();
    }

    // Outbound Request: 1 customer orders r items (1 < r < 7) to be consolidated into 1 Giant Box by 1 robot
    // Uses ABC / Velocity Demand Distribution and Proximity-Optimized Picking
    function triggerOutboundOrder() {
      if (!mapData || !mapData.stations) return;
      const dropoffs = Object.keys(mapData.stations).filter(id => id.startsWith('D'));
      if (dropoffs.length === 0) return;

      // Select available bay without an active order
      const availableBays = dropoffs.filter(id => !outboundOrders[id]);
      if (availableBays.length === 0) return;

      const chosenBay = availableBays[Math.floor(Math.random() * availableBays.length)];
      const r = Math.floor(Math.random() * 4) + 2; // 2 to 5 items consolidated for 1 customer

      // Collect available stored parcels across all rack memory
      const allStored = [];
      for (const rack of Object.values(rackMemory)) {
        for (let f = 0; f < MAX_FLOORS; f++) {
          const item = rack.floors[f];
          if (item !== null && !item.isReservedInbound && !item.isReservedOutbound) {
            allStored.push({
              parcel: item,
              rack: rack,
              floorIndex: f,
              floorNum: f + 1,
              categoryName: rack.categoryName
            });
          }
        }
      }

      if (allStored.length === 0) {
        logTerminal('OUTBOUND', 'tag-outbound', `📋 Departure Bay <strong>${chosenBay}</strong> requested ${r} parcels, but no available stored inventory found in racks.`);
        return;
      }

      const st = mapData.stations[chosenBay];
      const bayX = st ? st.x : 1;
      const bayY = st ? st.y : 27;

      // Select items following ABC velocity demand distribution:
      // ~75% Class A (Fast-movers FMCG, ELEC), ~20% Class B (Apparel, Pharma), ~5% Class C (Automotive, Hardware)
      const retrieved = [];
      for (let itemIdx = 0; itemIdx < r; itemIdx++) {
        const randDemand = Math.random();
        let targetVelocityClass = 'A';
        if (randDemand < 0.75) targetVelocityClass = 'A';
        else if (randDemand < 0.95) targetVelocityClass = 'B';
        else targetVelocityClass = 'C';

        let candidates = allStored.filter(s => {
          const cat = SKU_CATALOG.find(c => c.sku === s.parcel.sku);
          return cat && cat.velocityClass === targetVelocityClass && !retrieved.includes(s);
        });

        if (candidates.length === 0) {
          candidates = allStored.filter(s => !retrieved.includes(s));
        }
        if (candidates.length === 0) break;

        // Select the stored parcel closest to the destination bay to minimize AMR travel tour
        let bestCandidate = candidates[0];
        let bestDist = Infinity;
        for (const cand of candidates) {
          const d = Math.abs(cand.rack.x - bayX) + Math.abs(cand.rack.y - bayY);
          if (d < bestDist) {
            bestDist = d;
            bestCandidate = cand;
          }
        }

        retrieved.push(bestCandidate);

        // Track Pick Travel Distance Metric
        WAREHOUSE_SLOTTING_METRICS.totalPicksExecuted++;
        WAREHOUSE_SLOTTING_METRICS.totalPickDistanceCells += bestDist;
        WAREHOUSE_SLOTTING_METRICS.averagePickDistanceCells = Number(
          (WAREHOUSE_SLOTTING_METRICS.totalPickDistanceCells / WAREHOUSE_SLOTTING_METRICS.totalPicksExecuted).toFixed(1)
        );
      }

      if (retrieved.length === 0) return;

      orderSequence++;
      const orderId = `ORD-${orderSequence}`;
      const actualCount = retrieved.length;

      const zoneName = st ? st.zone : 'Outbound';

      // Pick SLA importance for customer order
      const randVal = Math.random();
      let orderImportance = IMPORTANCE_TIERS.STANDARD;
      if (randVal < 0.20) orderImportance = IMPORTANCE_TIERS.VIP_EXPRESS;
      else if (randVal < 0.45) orderImportance = IMPORTANCE_TIERS.SAME_DAY;
      else if (randVal < 0.85) orderImportance = IMPORTANCE_TIERS.STANDARD;
      else orderImportance = IMPORTANCE_TIERS.ECONOMY;

      let totalOrderWeight = 0;
      for (const item of retrieved) {
        item.rack.floors[item.floorIndex] = { isReservedOutbound: true, parcel: item.parcel };
        totalOrderWeight += parseFloat(item.parcel.weight) || 3.0;
      }

      // Bay lights up Yellow awaiting deposit
      outboundOrders[chosenBay] = {
        orderId: orderId,
        bayId: chosenBay,
        totalCount: actualCount,
        deliveredCount: 0
      };

      logTerminal('OUTBOUND', 'tag-outbound', `🚚 Customer Order <strong>${orderId}</strong> placed at <strong>${chosenBay}</strong> (${zoneName}) for <strong>${actualCount} items to consolidate in 1 Giant Box</strong> (${totalOrderWeight.toFixed(1)}kg, <span style="color:${orderImportance.color};font-weight:700;">${orderImportance.label}</span>) | Bay awaiting deposit: <span style="color:#facc15;font-weight:700;">LIT YELLOW</span>`);

      // Queue exactly ONE Outbound Mission (1 AMR assigned for consolidated multi-stop pick tour!)
      const orderSimTime = Number((totalSimSeconds || 0).toFixed(2));
      recordOrderPlaced(orderId, chosenBay, orderImportance, actualCount, totalOrderWeight);
      outboundMissions.push({
        orderId: orderId,
        bayId: chosenBay,
        bayX: st.x,
        bayY: st.y,
        itemsToPick: retrieved, // Multi-stop pick tour
        totalItems: actualCount,
        totalWeight: totalOrderWeight,
        importance: orderImportance,
        createdAt: Date.now(),
        createdSimTimeSec: orderSimTime,
        status: 'PENDING',
        assignedRobotId: null
      });

      updateSlottingComplianceStats();
      updateHudStats();
      dispatchFleet();
    }

