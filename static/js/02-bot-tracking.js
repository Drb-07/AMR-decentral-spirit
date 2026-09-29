    // =========================================================================
    // AMR BOT TRACKING & ACTIVE CAMERA FOLLOW SYSTEM
    // =========================================================================
    let trackedRobotId = null;
    let trackCameraFollow = true;

    function trackBot(robotId, enableCameraFollow = true) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;
      trackedRobotId = robotId;
      trackCameraFollow = enableCameraFollow;
      r.mapPingTimer = 2.5;

      const selectEl = document.getElementById('track-bot-select');
      if (selectEl) selectEl.value = robotId;

      const camBtn = document.getElementById('track-cam-toggle-btn');
      if (camBtn) {
        camBtn.classList.toggle('active', trackCameraFollow);
        camBtn.innerHTML = trackCameraFollow ? '🎥 Cam: ON' : '🎥 Cam: OFF';
      }

      if (currentMainTab !== 'map') {
        switchMainTab('map');
      }

      // If camera scale is currently zoomed out, zoom in for closer inspection
      if (camera.scale < 24) {
        zoomToScale(24);
      }

      centerOnTrackedBot();
      updateTrackingHud();
      render();
    }

    function stopTrackingBot() {
      trackedRobotId = null;
      const selectEl = document.getElementById('track-bot-select');
      if (selectEl) selectEl.value = '';
      const hud = document.getElementById('bot-tracking-hud');
      if (hud) hud.style.display = 'none';
      render();
    }

    function toggleTrackCameraFollow() {
      trackCameraFollow = !trackCameraFollow;
      const btn = document.getElementById('track-cam-toggle-btn');
      if (btn) {
        btn.classList.toggle('active', trackCameraFollow);
        btn.innerHTML = trackCameraFollow ? '🎥 Cam: ON' : '🎥 Cam: OFF';
      }
      if (trackCameraFollow && trackedRobotId) {
        centerOnTrackedBot();
      }
    }

    function cycleTrackedRobot(direction = 1) {
      if (AMR_FLEET.length === 0) return;
      let currIdx = AMR_FLEET.findIndex(b => b.id === trackedRobotId);
      if (currIdx === -1) {
        currIdx = 0;
      } else {
        currIdx = (currIdx + direction + AMR_FLEET.length) % AMR_FLEET.length;
      }
      trackBot(AMR_FLEET[currIdx].id, trackCameraFollow);
    }

    function centerOnTrackedBot() {
      if (!trackedRobotId) return;
      const r = AMR_FLEET.find(b => b.id === trackedRobotId);
      if (!r) return;
      const w = canvas.width / window.devicePixelRatio;
      const h = canvas.height / window.devicePixelRatio;
      const offsetX = window.innerWidth > 1000 ? -40 : 0;
      camera.x = (w / 2 + offsetX) - (r.x + 0.5) * camera.scale;
      camera.y = (h / 2) - (r.y + 0.5) * camera.scale;
      render();
    }

    function zoomToScale(newScale) {
      const centerW = (canvas.width / window.devicePixelRatio) / 2;
      const centerH = (canvas.height / window.devicePixelRatio) / 2;
      camera.x = centerW - (centerW - camera.x) * (newScale / camera.scale);
      camera.y = centerH - (centerH - camera.y) * (newScale / camera.scale);
      camera.scale = newScale;
    }

    function onTrackBotSelectChange(val) {
      if (!val) {
        stopTrackingBot();
      } else {
        trackBot(val, true);
      }
    }

