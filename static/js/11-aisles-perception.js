    // =========================================================================
    // NARROW AISLE CORRIDOR MUTEX (Single-Occupancy & Head-On Elimination)
    // =========================================================================
    function getNarrowAisleSegment(x, y) {
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (!NARROW_AISLE_COLS.has(ix)) return null;
      if (iy >= 5 && iy <= 22) return `${ix}_top`;
      if (iy >= 27 && iy <= 44) return `${ix}_bot`;
      return null;
    }

    function getNarrowAisleOccupant(seg, requestingRobotId = null) {
      if (!seg) return null;
      for (const b of AMR_FLEET) {
        if (b.id === requestingRobotId) continue;
        if (getNarrowAisleSegment(b.gridX, b.gridY) === seg || getNarrowAisleSegment(b.x, b.y) === seg) {
          return b.id;
        }
        if (b.path && b.path.length > 0 && b.pathIndex < b.path.length) {
          for (let k = b.pathIndex; k < b.path.length; k++) {
            if (getNarrowAisleSegment(b.path[k].x, b.path[k].y) === seg) {
              return b.id;
            }
          }
        }
      }
      return null;
    }

    function getAisleEntranceTile(aisleX, aisleY) {
      const isSouthbound = SOUTHBOUND_AISLE_COLS.has(aisleX);
      if (aisleY >= 5 && aisleY <= 22) {
        return isSouthbound ? { x: aisleX, y: 4 } : { x: aisleX, y: 23 };
      } else if (aisleY >= 27 && aisleY <= 44) {
        return isSouthbound ? { x: aisleX, y: 26 } : { x: aisleX, y: 45 };
      }
      return null;
    }


    // =========================================================================
    // FEATURE 6: PERCEPTION REALISM & ONBOARD SENSOR HORIZON
    // 1. Raycasting Line of Sight (LOS) & Rack Occlusion Detection
    // 2. Field of View (FOV) Forward Scanner (220°) & Rear Blind Spot Filtering
    // 3. Sensor Detection Confirmation Latency (80ms Filter)
    // 4. Track Persistence & Local Obstacle Representation
    // =========================================================================

    function hasLineOfSight(x1, y1, x2, y2) {
      if (!mapData || !mapData.grid) return true;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      if (dist < 0.35) return true;

      const sx = Math.floor(x1);
      const sy = Math.floor(y1);
      const ex = Math.floor(x2);
      const ey = Math.floor(y2);

      // Harness compatibility: if start or end is on a rack cell, permit direct line of sight
      const isStartWalkable = (mapData.grid[sx] && mapData.grid[sx][sy] !== 1);
      const isEndWalkable = (mapData.grid[ex] && mapData.grid[ex][ey] !== 1);
      if (!isStartWalkable || !isEndWalkable) return true;

      // Sample points along ray from start to end with step <= 0.30 cells
      const steps = Math.ceil(dist / 0.30);
      const dx = (x2 - x1) / steps;
      const dy = (y2 - y1) / steps;

      for (let i = 1; i < steps; i++) {
        const cx = Math.floor(x1 + dx * i);
        const cy = Math.floor(y1 + dy * i);
        if (cx < 0 || cy < 0 || cx >= mapData.width || cy >= mapData.height) continue;
        if (cx === sx && cy === sy) continue;
        if (cx === ex && cy === ey) continue;
        if (mapData.grid[cx] && mapData.grid[cx][cy] === 1) {
          return false; // Solid rack or wall blocks sightline!
        }
      }
      return true;
    }

    function updateRobotPerception(robot, dt) {
      if (!robot) return;
      if (!robot.perception) {
        robot.perception = {
          trackedObstacles: {},
          confirmedObstacles: [],
          visibleLidarHits: [],
          totalOcclusions: 0,
          totalBlindSpotIgnored: 0,
          totalConfirmedTracks: 0,
          lastScanTime: totalSimSeconds
        };
      }
      const p = robot.perception;
      p.lastScanTime = totalSimSeconds;
      const sensorRange = robot.sensorRange || 6.0;
      const halfFov = (robot.sensorFovRad || (220 * Math.PI / 180)) / 2;
      const blindSpotRadius = robot.blindSpotRadius || 0.85;
      const latencySec = robot.detectionLatencySec || 0.08;
      const persistenceSec = robot.persistenceSec || 0.20;

      const currentVisibleIds = new Set();
      const rawDetections = [];

      // 1. Scan for other AMRs on warehouse floor
      if (typeof AMR_FLEET !== 'undefined' && AMR_FLEET) {
        for (const other of AMR_FLEET) {
          if (other.id === robot.id) continue;
          if (other.state === 'IDLE_CHARGING' || other.state === 'OUT_OF_CHARGE') continue;

          const dx = other.x - robot.x;
          const dy = other.y - robot.y;
          const dist = Math.hypot(dx, dy);

          if (dist > sensorRange) continue;

          const bearing = Math.atan2(dy, dx);
          let relAngle = bearing - robot.heading;
          while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
          while (relAngle < -Math.PI) relAngle += 2 * Math.PI;

          // Beyond close-proximity bumper radius, must be inside forward FOV
          if (dist > blindSpotRadius && Math.abs(relAngle) > halfFov) {
            p.totalBlindSpotIgnored++;
            continue;
          }

          // Check Line of Sight against opaque racks
          if (dist > 0.6 && !hasLineOfSight(robot.x, robot.y, other.x, other.y)) {
            p.totalOcclusions++;
            continue;
          }

          currentVisibleIds.add(other.id);
          rawDetections.push({
            id: other.id,
            type: 'ROBOT',
            ref: other,
            x: other.x,
            y: other.y,
            dist: dist,
            bearing: relAngle,
            heading: other.heading,
            speed: other.currentSpeed || 0
          });
        }
      }

      // 2. Scan for Human Workers (if human presence enabled)
      if ((typeof humansEnabled === 'undefined' || humansEnabled) && typeof HUMAN_WORKERS !== 'undefined' && HUMAN_WORKERS) {
        for (const h of HUMAN_WORKERS) {
          const dx = h.x - robot.x;
          const dy = h.y - robot.y;
          const dist = Math.hypot(dx, dy);

          if (dist > sensorRange) continue;

          const bearing = Math.atan2(dy, dx);
          let relAngle = bearing - robot.heading;
          while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
          while (relAngle < -Math.PI) relAngle += 2 * Math.PI;

          if (dist > blindSpotRadius && Math.abs(relAngle) > halfFov) {
            p.totalBlindSpotIgnored++;
            continue;
          }

          if (dist > 0.6 && !hasLineOfSight(robot.x, robot.y, h.x, h.y)) {
            p.totalOcclusions++;
            continue;
          }

          currentVisibleIds.add(h.id);
          rawDetections.push({
            id: h.id,
            type: 'HUMAN',
            ref: h,
            x: h.x,
            y: h.y,
            name: h.name,
            role: h.role,
            dist: dist,
            bearing: relAngle,
            heading: h.heading || 0,
            speed: h.speed || 0
          });
        }
      }

      // Update Tracked Obstacles with Latency Confirmation Filter
      const confirmedList = [];
      for (const det of rawDetections) {
        let track = p.trackedObstacles[det.id];
        if (!track) {
          track = {
            id: det.id,
            type: det.type,
            ref: det.ref,
            firstDetectedSimTime: totalSimSeconds,
            timeVisible: 0,
            timeSinceLastSeen: 0,
            confirmed: false
          };
          p.trackedObstacles[det.id] = track;
        }

        track.timeVisible += dt;
        track.timeSinceLastSeen = 0;
        track.dist = det.dist;
        track.bearing = det.bearing;
        track.x = det.x;
        track.y = det.y;
        track.heading = det.heading;
        track.speed = det.speed;
        track.name = det.name;
        track.role = det.role;

        // Detection Latency confirmation threshold:
        // Hardware Safety Trip: Obstacles breaching the inner protective stop envelope (<= 2.2c) trip immediately.
        // Software Tracking: Caution/warning zone obstacles (> 2.2c) require 80ms confirmation filter to prevent false alarms.
        const isEmergencyProtectiveZone = det.dist <= 2.2;
        if (isEmergencyProtectiveZone || track.timeVisible >= latencySec) {
          if (!track.confirmed) {
            track.confirmed = true;
            p.totalConfirmedTracks++;
          }
          confirmedList.push(track);
        }
      }

      // Handle Lost Tracks (Persistence Decay)
      for (const [id, track] of Object.entries(p.trackedObstacles)) {
        if (!currentVisibleIds.has(id)) {
          track.timeSinceLastSeen += dt;
          if (track.timeSinceLastSeen > persistenceSec) {
            delete p.trackedObstacles[id];
          } else if (track.confirmed) {
            confirmedList.push(track);
          }
        }
      }

      p.confirmedObstacles = confirmedList;
    }

