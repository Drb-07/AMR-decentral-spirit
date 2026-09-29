    // ==========================================
    // TAB NAVIGATION & BOTS HEALTH / TERMINAL
    // ==========================================
    let currentMainTab = 'map';
    let currentThMode = 'split';
    let currentLogFilter = 'ALL';
    let termEventCount = 0;
    let autoScroll = true;

    function switchMainTab(tabName) {
      currentMainTab = tabName;
      const mapBtn = document.getElementById('tab-btn-map');
      const termBtn = document.getElementById('tab-btn-terminal');
      const probBtn = document.getElementById('tab-btn-problems');
      const mapView = document.getElementById('view-map');
      const termView = document.getElementById('view-terminal-health');
      const probView = document.getElementById('view-problems');

      if (mapBtn) mapBtn.classList.toggle('active', tabName === 'map');
      if (termBtn) termBtn.classList.toggle('active', tabName === 'terminal');
      if (probBtn) probBtn.classList.toggle('active', tabName === 'problems');

      if (mapView) mapView.classList.toggle('active', tabName === 'map');
      if (termView) termView.classList.toggle('active', tabName === 'terminal');
      if (probView) probView.classList.toggle('active', tabName === 'problems');

      if (tabName === 'map') {
        resize();
        render();
      } else if (tabName === 'terminal') {
        updateBotsHealthDashboard();
      } else if (tabName === 'problems') {
        updateProblemsDashboard();
      }
    }

    function toggleTerminal() {
      switchMainTab(currentMainTab === 'map' ? 'terminal' : 'map');
    }

    function setThLayoutMode(mode) {
      currentThMode = mode;
      const panes = document.getElementById('th-panes');
      const btnSplit = document.getElementById('btn-mode-split');
      const btnBots = document.getElementById('btn-mode-bots');
      const btnTerm = document.getElementById('btn-mode-term');

      if (btnSplit) btnSplit.classList.toggle('active', mode === 'split');
      if (btnBots) btnBots.classList.toggle('active', mode === 'bots');
      if (btnTerm) btnTerm.classList.toggle('active', mode === 'term');

      if (panes) {
        panes.className = `th-panes mode-${mode}`;
      }
    }

    function setLogFilter(filterName, btn) {
      currentLogFilter = filterName;
      const pills = document.querySelectorAll('.filter-pill');
      pills.forEach(p => p.classList.toggle('active', p.getAttribute('data-filter') === filterName));

      const body = document.getElementById('terminal-body');
      if (!body) return;
      const entries = body.querySelectorAll('.log-entry');
      entries.forEach(entry => {
        const cat = entry.getAttribute('data-cat') || 'ALL';
        if (filterName === 'ALL' || cat === filterName) {
          entry.style.display = 'flex';
        } else {
          entry.style.display = 'none';
        }
      });
    }

    function toggleAutoScroll() {
      autoScroll = !autoScroll;
      const btn = document.getElementById('term-autoscroll-btn');
      if (btn) btn.innerText = 'Scroll: ' + (autoScroll ? 'ON' : 'OFF');
    }

    function clearTerminal() {
      const body = document.getElementById('terminal-body');
      if (body) body.innerHTML = '';
      termEventCount = 0;
      const counterEl = document.getElementById('term-event-count');
      if (counterEl) counterEl.innerText = '0';
      const badge = document.getElementById('tab-event-badge');
      if (badge) badge.innerText = '0';
    }

    function logTerminal(type, tagClass, text) {
      termEventCount++;
      const counterEl = document.getElementById('term-event-count');
      if (counterEl) counterEl.innerText = termEventCount;
      const tabBadge = document.getElementById('tab-event-badge');
      if (tabBadge) tabBadge.innerText = termEventCount;

      const body = document.getElementById('terminal-body');
      if (!body || typeof body.appendChild !== 'function') return;

      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0];

      // Classify log into category for filtering
      let cat = 'ALL';
      if (tagClass.includes('inbound') || type === 'INBOUND' || type === 'SHELVING') cat = 'INBOUND';
      else if (tagClass.includes('outbound') || type === 'OUTBOUND' || type === 'PICKUP' || type === 'DISPATCH') cat = 'OUTBOUND';
      else if (tagClass.includes('overtake') || tagClass.includes('yield') || tagClass.includes('reroute') || type === 'YIELD' || type === 'OVERTAKE' || type === 'REROUTE') cat = 'TRAFFIC';
      else if (type === 'BMS' || type === 'SPEED' || type === 'ALERT') cat = 'BMS';

      const row = document.createElement('div');
      row.className = 'log-entry';
      row.setAttribute('data-cat', cat);
      if (currentLogFilter !== 'ALL' && cat !== currentLogFilter) {
        row.style.display = 'none';
      }
      row.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-tag ${tagClass}">${type}</span> <span class="log-msg">${text}</span>`;
      body.appendChild(row);

      // Keep up to 400 lines in memory
      if (body.children.length > 400) {
        body.removeChild(body.firstChild);
      }

      if (autoScroll) {
        body.scrollTop = body.scrollHeight;
      }
    }

    function locateBotOnMap(robotId) {
      const r = AMR_FLEET.find(b => b.id === robotId);
      if (!r) return;
      r.mapPingTimer = 4.0; // Trigger high-visibility radar ping on map
      switchMainTab('map');
      const w = canvas.width / window.devicePixelRatio;
      const h = canvas.height / window.devicePixelRatio;
      camera.x = w / 2 - (r.x + 0.5) * camera.scale;
      camera.y = h / 2 - (r.y + 0.5) * camera.scale;
      render();
    }

