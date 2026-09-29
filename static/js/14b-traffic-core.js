// =========================================================================
// 14b-traffic-core.js
// Unified Traffic Engine (No DOM access, runs in browser & Node.js)
// =========================================================================

const Traffic = (function() {
    const claims = new Map(); 
    const waitGraph = new Map(); 
    const waitTimes = new Map(); 
    let cycleWatchdogFired = 0;

    function getMode() {
        return (typeof window !== 'undefined' && window.TRAFFIC_MODE) ? window.TRAFFIC_MODE : 'claims';
    }

    function getPriorityScore(botId, fleet) {
        const bot = fleet.find(b => b.id === botId);
        if (!bot) return -999;
        
        let score = 40; 
        if (typeof getRobotPriority === 'function') score = getRobotPriority(bot);
        
        // Starvation prevention: +5 points for every 10 ticks waiting
        const waitBonus = Math.floor((waitTimes.get(botId) || 0) / 10) * 5;
        return score + waitBonus;
    }

    function mayEnter(robot, targetCell, fleet) {
        const mode = getMode();
        if (mode === 'legacy') return true;

        if (mode === 'baseline') {
            for (const other of fleet) {
                if (other.id === robot.id) continue;
                if (Math.hypot(other.x - targetCell.x, other.y - targetCell.y) < 1.15) {
                    waitGraph.set(robot.id, other.id);
                    return false;
                }
            }
            waitGraph.delete(robot.id);
            return true;
        }

        if (mode === 'claims') {
            if (robot.isBackingUp) {
                const physicalOccupant = fleet.find(o => o.id !== robot.id && Math.hypot(o.x - targetCell.x, o.y - targetCell.y) < 0.75);
                if (physicalOccupant) {
                    waitGraph.set(robot.id, physicalOccupant.id);
                    return false;
                }
                waitGraph.delete(robot.id);
                return true;
            }

            const lookahead = [{ x: robot.gridX, y: robot.gridY }];
            if (robot.path && robot.pathIndex < robot.path.length) {
                for (let i = robot.pathIndex; i < Math.min(robot.pathIndex + 3, robot.path.length); i++) {
                    lookahead.push(robot.path[i]);
                }
            } else {
                lookahead.push(targetCell);
            }

            let blockedBy = null;

            for (const pt of lookahead) {
                const ptKey = `${pt.x},${pt.y}`;
                
                const physicalOccupant = fleet.find(o => {
                    if (o.id === robot.id) return false;
                    const dist = Math.hypot(o.x - pt.x, o.y - pt.y);
                    const isSameDir = Math.abs(o.heading - robot.heading) < 0.5 && (o.currentSpeed > 0.1);
                    const threshold = isSameDir ? 0.55 : 0.85; 
                    return dist < threshold;
                });

                if (physicalOccupant) {
                    blockedBy = physicalOccupant.id;
                    break;
                }

                const existingClaim = claims.get(ptKey);
                if (existingClaim && existingClaim.botId !== robot.id) {
                    const otherBot = fleet.find(b => b.id === existingClaim.botId);
                    const isOtherDead = otherBot && (otherBot.state === 'OUT_OF_CHARGE' || otherBot.isFaulted);
                    
                    if (isOtherDead) {
                        blockedBy = existingClaim.botId;
                        break;
                    }

                    const myScore = getPriorityScore(robot.id, fleet);
                    const otherScore = getPriorityScore(existingClaim.botId, fleet);

                    if (Math.abs(myScore - otherScore) < 5) {
                        const myTime = robot.pathTimestamp || 0;
                        const otherTime = otherBot ? (otherBot.pathTimestamp || 0) : 0;
                        if (myTime > otherTime) {
                            blockedBy = existingClaim.botId;
                            break;
                        }
                    } else if (myScore < otherScore) {
                        blockedBy = existingClaim.botId;
                        break;
                    }
                }
            }

            if (blockedBy) {
                waitGraph.set(robot.id, blockedBy);
                return false; 
            }

            waitGraph.delete(robot.id);
            const keepKeys = new Set();
            for (const pt of lookahead) {
                const key = `${pt.x},${pt.y}`;
                claims.set(key, { botId: robot.id, timestamp: Date.now() });
                keepKeys.add(key);
            }
            
            for (const [key, claim] of claims.entries()) {
                if (claim.botId === robot.id && !keepKeys.has(key)) claims.delete(key);
            }
            
            return true;
        }
    }

    function release(robot) {
        for (const [key, claim] of claims.entries()) {
            if (claim.botId === robot.id) claims.delete(key);
        }
        waitGraph.delete(robot.id);
        waitTimes.delete(robot.id);
    }

    function tick(fleet) {
        if (getMode() !== 'claims') return;
        
        for (const bot of fleet) {
            if (waitGraph.has(bot.id)) waitTimes.set(bot.id, (waitTimes.get(bot.id) || 0) + 1);
            else waitTimes.set(bot.id, 0);
        }

        const visited = new Set(), stack = new Set();
        let cycleFound = null;

        for (const startNode of waitGraph.keys()) {
            let curr = startNode;
            const path = [];
            while (curr && !visited.has(curr)) {
                visited.add(curr);
                stack.add(curr);
                path.push(curr);
                curr = waitGraph.get(curr);
                if (stack.has(curr)) {
                    cycleFound = path.slice(path.indexOf(curr));
                    break;
                }
            }
            for (const node of path) stack.delete(node);
            if (cycleFound) break;
        }

        if (cycleFound) {
            cycleWatchdogFired++;
            cycleFound.sort((a, b) => getPriorityScore(a, fleet) - getPriorityScore(b, fleet)); 
            
            let loserIdx = 0;
            let loserBot = fleet.find(b => b.id === cycleFound[loserIdx]);
            
            // SIDE-STEP & LOSER-SWAP LOGIC
            // If the loser has no trail to back into, force it to step sideways into an empty lane.
            // If it's totally boxed in, shift the yield burden to the next robot in the deadlock.
            while (loserBot && (!loserBot.recentVisitedCells || loserBot.recentVisitedCells.length === 0) && loserIdx < cycleFound.length) {
                let sideStepFound = false;
                const dirs = [{dx:0, dy:-1}, {dx:0, dy:1}, {dx:-1, dy:0}, {dx:1, dy:0}];
                
                for (const d of dirs) {
                    const nx = (loserBot.gridX !== undefined ? loserBot.gridX : Math.round(loserBot.x)) + d.dx;
                    const ny = (loserBot.gridY !== undefined ? loserBot.gridY : Math.round(loserBot.y)) + d.dy;
                    const isOcc = fleet.some(b => Math.hypot(b.x - nx, b.y - ny) < 1.0);
                    
                    if (!isOcc && nx > 0 && nx < 169 && ny > 0 && ny < 49) {
                        loserBot.recentVisitedCells = [{x: nx, y: ny}]; // Hack to feed the rollback logic
                        sideStepFound = true;
                        break;
                    }
                }
                
                if (!sideStepFound) {
                    loserIdx++;
                    loserBot = fleet.find(b => b.id === cycleFound[loserIdx]);
                }
            }

            if (loserBot && !loserBot.isBackingUp) {
                waitGraph.delete(loserBot.id);
                waitTimes.delete(loserBot.id);
                
                if (loserBot.recentVisitedCells && loserBot.recentVisitedCells.length > 0) {
                    if (!loserBot.savedDest && loserBot.path && loserBot.path.length > 0) {
                        loserBot.savedDest = loserBot.path[loserBot.path.length - 1];
                    }
                    const backPath = loserBot.recentVisitedCells.slice().reverse();
                    loserBot.path = backPath.slice(0, Math.min(backPath.length, 12)); 
                    loserBot.pathIndex = 0;
                    loserBot.isBackingUp = true;
                    loserBot.statusBadge = 'YIELD';
                    release(loserBot); 
                }
            }
        }
    }

    // Export the mode dynamically
    return { mayEnter, release, tick, get TRAFFIC_MODE() { return getMode(); } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Traffic };
else if (typeof window !== 'undefined') window.Traffic = Traffic;