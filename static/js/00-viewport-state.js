
    const urlParams = new URLSearchParams(window.location.search);
    window._isHeadless = urlParams.get('headless') === '1';
    window._benchDuration = parseFloat(urlParams.get('duration')) || 1800; // 30 min default
    const seedParam = urlParams.get('seed');
    
    if (seedParam) {
        let seed = parseInt(seedParam, 10);
        // Mulberry32 Deterministic PRNG
        Math.random = function() {
            let t = seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
        // Ensure all absolute time checks use simulated seconds to prevent divergence
        const origDateNow = Date.now;
        Date.now = function() { return typeof totalSimSeconds !== 'undefined' ? totalSimSeconds * 1000 : origDateNow(); };
    }

    window._benchStats = { collisions: 0, tasksCompleted: 0, taskTimes: [], stuckEvents: 0, watchdogTriggers: {} };
    window.__bench = function() {
        const times = window._benchStats.taskTimes.sort((a,b) => a-b);
        const meanTime = times.length ? times.reduce((a,b)=>a+b,0)/times.length : 0;
        const p95Time = times.length ? times[Math.floor(times.length * 0.95)] : 0;
        return { 
            collisions: window._benchStats.collisions, 
            tasksCompleted: window._benchStats.tasksCompleted, 
            meanTaskTime: meanTime, 
            p95TaskTime: p95Time, 
            stuckEvents: window._benchStats.stuckEvents, 
            watchdogTriggers: window._benchStats.watchdogTriggers 
        };
    };

    const canvas = document.getElementById('viewport');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('cell-tooltip');
    const coordsLabel = document.getElementById('cursor-coords');

    let mapData = null;
    let camera = { x: 0, y: 0, scale: 10 }; // Zoomed out for double-wide map
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };

    function toggleHud() {
      const card = document.getElementById('hud-card');
      const icon = document.getElementById('hud-toggle-icon');
      card.classList.toggle('collapsed');
      if (card.classList.contains('collapsed')) {
        icon.innerHTML = '&plus;';
      } else {
        icon.innerHTML = '&minus;';
      }
    }

