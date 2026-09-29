    // =========================================================================
    // PHASE 1 & 5: DECENTRALIZED MESH NETWORK LAYER (BATMAN-adv + Zenoh Sim + CBBA)
    // =========================================================================
    class SimulatedZenohMesh {
      constructor() {
        this.config = {
          messageRateHz: 5.0,  // Broadcast frequency per PDF specs
          maxRangeCells: 45.0, // Ad-hoc Wi-Fi range limit (~15-20 meters)
          packetLossPct: 0.0,  // % of packets dropped (the chaos dial)
          latencyMs: 80        // Network transmission delay
        };
        this.inFlightMessages = [];
        
        // Phase 5 CBBA Storage
        this.taskAnnouncements = new Map();
        this.taskBids = new Map();
        
        // Phase 8 CBBA Charging Storage
        this.chargeAnnouncements = new Map();
        this.chargeBids = new Map();
      }

      // --- Phase 5: CBBA Task Negotiation Methods ---
      announceTask(task) {
        if (!this.taskAnnouncements.has(task.id)) {
          task.announceTime = typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0;
          task.bidders = new Set();
          this.taskAnnouncements.set(task.id, task);
          this.taskBids.set(task.id, []);
          if (typeof logTerminal === 'function') logTerminal('DISPATCH', 'tag-inbound', `📡 <strong>New Task Announced via Mesh</strong>: ${task.desc} (ID: ${task.id}). Bidding open.`);
        }
      }

      publishBid(taskId, robotId, cost, details = "") {
        // Simulate network latency/loss for bids
        if (Math.random() * 100 < this.config.packetLossPct) return;
        const bids = this.taskBids.get(taskId);
        if (bids) bids.push({ robotId, cost, details, timestamp: typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0 });
      }

      getBidsForTask(taskId) {
        return this.taskBids.get(taskId) || [];
      }

      claimTask(taskId, robotId) {
        if (this.taskAnnouncements.has(taskId)) {
          this.taskAnnouncements.delete(taskId);
          this.taskBids.delete(taskId);
          return true;
        }
        return false;
      }

      // --- Phase 8: CBBA Charging Negotiation Methods ---
      announceChargeBay(bay) {
        if (!this.chargeAnnouncements.has(bay.id)) {
          bay.announceTime = typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0;
          bay.bidders = new Set();
          this.chargeAnnouncements.set(bay.id, bay);
          this.chargeBids.set(bay.id, []);
        }
      }

      publishChargeBid(bayId, robotId, cost, details = "") {
        if (Math.random() * 100 < this.config.packetLossPct) return;
        const bids = this.chargeBids.get(bayId);
        if (bids) bids.push({ robotId, cost, details, timestamp: typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0 });
      }

      getChargeBids(bayId) {
        return this.chargeBids.get(bayId) || [];
      }

      claimChargeBay(bayId, robotId) {
        if (this.chargeAnnouncements.has(bayId)) {
          this.chargeAnnouncements.delete(bayId);
          this.chargeBids.delete(bayId);
          return true;
        }
        return false;
      }

      // Robot publishes a heartbeat to the local mesh
      publishHeartbeat(senderId, senderX, senderY, payload) {
        this.inFlightMessages.push({
          senderId,
          senderX,
          senderY,
          // Deep copy prevents memory-reference cheating. Robots only get a snapshot.
          payload: JSON.parse(JSON.stringify(payload)), 
          deliveryTime: Date.now() + this.config.latencyMs,
          simTime: totalSimSeconds
        });
      }

      // Process in-flight messages and deliver to robots within physical range
      deliverMessages(fleet) {
        const now = Date.now();
        const ready = this.inFlightMessages.filter(m => now >= m.deliveryTime);
        this.inFlightMessages = this.inFlightMessages.filter(m => now < m.deliveryTime);

        for (const msg of ready) {
          // 1. Simulate environmental packet loss
          if (Math.random() * 100 < this.config.packetLossPct) continue;

          for (const bot of fleet) {
            if (bot.id === msg.senderId) continue; // Don't receive own echo
            
            // 2. Physical range gating (BATMAN-adv Layer 2 limit)
            const dist = Math.hypot(bot.x - msg.senderX, bot.y - msg.senderY);
            if (dist <= this.config.maxRangeCells) {
              if (!bot.localPeerTable) bot.localPeerTable = new Map();
              
              // =================================================================
              // PHASE 7: COMMUNICATION-AWARE DEGRADATION & CONFIDENCE TRACKING
              // Estimate packet loss dynamically based on sequence number gaps
              // =================================================================
              const prev = bot.localPeerTable.get(msg.senderId);
              let pktLoss = prev && prev.packetLoss !== undefined ? prev.packetLoss : 0.0;
              
              if (prev && msg.payload.seq > prev.seq + 1) {
                 const missed = msg.payload.seq - prev.seq - 1;
                 pktLoss = (pktLoss * 0.7) + (Math.min(missed, 5) * 0.3); // EWMA penalty
              } else if (prev) {
                 pktLoss = pktLoss * 0.7; // Decay packet loss when delivery is clean
              }
              
              msg.payload.packetLoss = pktLoss;
              msg.payload.timestamp = typeof totalSimSeconds !== 'undefined' ? totalSimSeconds : 0;
              
              bot.localPeerTable.set(msg.senderId, msg.payload);
            }
          }
        }
      }
    }
    const zenohMesh = new SimulatedZenohMesh();

