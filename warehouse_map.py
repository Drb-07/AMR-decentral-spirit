"""
Multi-Zone / Multi-Building Warehouse Topology (170 x 50 Grid)
Designed for Edge-AI Distributed Fleet Coordination for AMRs

Key Features:
- 170 columns x 50 rows = 8,500 cells (Two 80x50 zones + 10-cell Transit Bridge)
- Building A (West): x = 0 to 79
- Building B (East): x = 90 to 169
- Congestion Choke Point (Transit Bridge): x = 80 to 89, y = 22 to 27
- Stress-tests Zone-Boundary congestion, long-haul routing, and cross-building bottlenecks
"""

from typing import List, Tuple, Dict, Set, Optional
from dataclasses import dataclass, asdict
import json


# Cell Type Constants
CELL_EMPTY = 0           # Open floor / corridor / highway
CELL_RACK = 1            # Solid static storage rack
CELL_CHARGING = 3        # Fast charging station (Green)
CELL_PICKUP = 4          # Inbound pickup dock (Cyan)
CELL_DROPOFF = 5         # Outbound sorting / dispatch bay (Amber)
CELL_HAZARD = 9          # Dynamic obstacle / human / blocked aisle


@dataclass
class Station:
    id: str
    name: str
    station_type: str  # 'pickup', 'dropoff', 'charging'
    x: int
    y: int
    zone: str = "General"


class WarehouseMap:
    def __init__(self, width: int = 170, height: int = 50):
        self.width = width
        self.height = height

        # 2D Grid: grid[x][y]
        self.grid: List[List[int]] = [[CELL_EMPTY for _ in range(height)] for _ in range(width)]

        # Dynamic obstacles injected at runtime
        self.dynamic_obstacles: Set[Tuple[int, int]] = set()

        # Topological sets
        self.stations: Dict[str, Station] = {}
        self.narrow_aisles: Set[Tuple[int, int]] = set()
        self.rack_cells: Set[Tuple[int, int]] = set()

        self._build_layout()

    def _build_layout(self):
        # 1. Multi-Building Perimeter Walls
        for x in range(self.width):
            self.grid[x][0] = CELL_RACK
            self.grid[x][self.height - 1] = CELL_RACK
            self.rack_cells.add((x, 0))
            self.rack_cells.add((x, self.height - 1))

        for y in range(self.height):
            self.grid[0][y] = CELL_RACK
            self.grid[self.width - 1][y] = CELL_RACK
            self.rack_cells.add((0, y))
            self.rack_cells.add((self.width - 1, y))

        # 2. Storage Sectors (Solid continuous rack pods)
        west_col_pairs = [(5, 6), (8, 9), (11, 12), (14, 15), (17, 18), (20, 21), (23, 24)]
        central_col_pairs = [(30, 31), (33, 34), (36, 37), (39, 40), (42, 43), (45, 46), (48, 49)]
        east_col_pairs = [(56, 57), (59, 60), (62, 63), (65, 66), (68, 69), (71, 72), (74, 75)]
        yard_col_pairs = [(79, 80), (82, 83), (85, 86), (88, 89), (91, 92)]
        
        bldg_a_pairs = west_col_pairs + central_col_pairs + east_col_pairs
        bldg_b_pairs = [(c[0]+90, c[1]+90) for c in bldg_a_pairs]
        all_rack_col_pairs = bldg_a_pairs + yard_col_pairs + bldg_b_pairs
        
        # Remove the first 2 columns (far west) and last 2 columns (far east) to reduce traffic near docks
        all_rack_col_pairs = [c for c in all_rack_col_pairs if c not in [(5, 6), (8, 9), (161, 162), (164, 165)]]

        # =========================================================================
        # CARVING OUT BUFFER ROWS (Fixing the Racks touching Highways)
        # Racks now sit inside y=[6..21] and y=[28..43]
        # Rows 5, 22, 27, and 44 remain open as parking buffers
        # =========================================================================
        for col_start, col_end in all_rack_col_pairs:
            for x in range(col_start, col_end + 1):
                for y in range(6, 22):
                    self.grid[x][y] = CELL_RACK
                    self.rack_cells.add((x, y))
                for y in range(28, 44):
                    self.grid[x][y] = CELL_RACK
                    self.rack_cells.add((x, y))

        # 3. Narrow Single-Lane Aisles (1.5x robot base width):
        west_aisles = [7, 10, 13, 16, 19, 22]
        central_aisles = [32, 35, 38, 41, 44, 47]
        east_aisles = [58, 61, 64, 67, 70, 73]
        yard_aisles = [81, 84, 87, 90, 93]
        
        bldg_a_aisles = west_aisles + central_aisles + east_aisles
        bldg_b_aisles = [a + 90 for a in bldg_a_aisles]
        all_vertical_aisles = bldg_a_aisles + yard_aisles + bldg_b_aisles
        
        # Remove narrow aisles corresponding to the removed racks
        all_vertical_aisles = [a for a in all_vertical_aisles if a not in [7, 10, 160, 163]]

        for ax in all_vertical_aisles:
            for y in range(5, 23):
                self.narrow_aisles.add((ax, y))
            for y in range(27, 45):
                self.narrow_aisles.add((ax, y))

        # Horizontal perimeter transition aisles
        for y in (5, 22, 27, 44):
            for x in range(4, 166):
                self.narrow_aisles.add((x, y))

        # 4. Dedicated Charging Depots
        # Building A Chargers
        for i, cx in enumerate([38, 39, 40, 41]):
            cid_top = f"CH-{i+1:02d}"
            self.stations[cid_top] = Station(cid_top, f"Bldg A Top Charge {i+1}", "charging", cx, 1, "BldgA-Charge")
            self.grid[cx][1] = CELL_CHARGING
            cid_bot = f"CH-{i+5:02d}"
            self.stations[cid_bot] = Station(cid_bot, f"Bldg A Bot Charge {i+1}", "charging", cx, 48, "BldgA-Charge")
            self.grid[cx][48] = CELL_CHARGING
            
        # Building B Chargers
        for i, cx in enumerate([128, 129, 130, 131]):
            cid_top = f"CH-{i+9:02d}"
            self.stations[cid_top] = Station(cid_top, f"Bldg B Top Charge {i+1}", "charging", cx, 1, "BldgB-Charge")
            self.grid[cx][1] = CELL_CHARGING
            cid_bot = f"CH-{i+13:02d}"
            self.stations[cid_bot] = Station(cid_bot, f"Bldg B Bot Charge {i+1}", "charging", cx, 48, "BldgB-Charge")
            self.grid[cx][48] = CELL_CHARGING

        # 5. Cross-Building Docks: ALL Pickups in Bldg A, ALL Dropoffs in Bldg B
        # Building A (West) - Inbound Processing
        for i, sy in enumerate([5, 9, 13, 17, 21, 27, 31, 35, 39, 43]):
            sid = f"P-{i+1:02d}"
            self.stations[sid] = Station(sid, f"Bldg A Inbound {i+1}", "pickup", 1, sy, "BldgA-Inbound")
            self.grid[1][sy] = CELL_PICKUP

        # Building B (East) - Outbound Processing
        for i, sy in enumerate([5, 9, 13, 17, 21, 27, 31, 35, 39, 43]):
            sid = f"D-{i+1:02d}"
            self.stations[sid] = Station(sid, f"Bldg B Outbound {i+1}", "dropoff", 168, sy, "BldgB-Outbound")
            self.grid[168][sy] = CELL_DROPOFF

    def is_walkable(self, x: int, y: int, ignore_dynamic: bool = False) -> bool:
        """Check if coordinates are within bounds and not occupied by racks or dynamic obstacles."""
        if x < 0 or x >= self.width or y < 0 or y >= self.height:
            return False
        if self.grid[x][y] == CELL_RACK:
            return False
        if not ignore_dynamic and (x, y) in self.dynamic_obstacles:
            return False
        return True

    def get_neighbors(self, x: int, y: int, allow_diagonal: bool = False) -> List[Tuple[int, int]]:
        """Return valid walkable neighboring coordinates."""
        neighbors = []
        directions = [(0, 1), (0, -1), (1, 0), (-1, 0)]
        if allow_diagonal:
            directions += [(1, 1), (1, -1), (-1, 1), (-1, -1)]

        for dx, dy in directions:
            nx, ny = x + dx, y + dy
            if self.is_walkable(nx, ny):
                neighbors.append((nx, ny))
        return neighbors

    def get_stations_by_type(self, station_type: str) -> List[Station]:
        """Filter stations by type ('pickup', 'dropoff', 'charging')."""
        return [s for s in self.stations.values() if s.station_type == station_type]

    def add_dynamic_obstacle(self, x: int, y: int):
        """Inject a dynamic obstacle (e.g. human worker or blocked aisle)."""
        if 0 <= x < self.width and 0 <= y < self.height:
            self.dynamic_obstacles.add((x, y))

    def remove_dynamic_obstacle(self, x: int, y: int):
        """Clear a specific dynamic obstacle."""
        self.dynamic_obstacles.discard((x, y))

    def clear_dynamic_obstacles(self):
        """Clear all active dynamic obstacles."""
        self.dynamic_obstacles.clear()

    def to_dict(self) -> dict:
        """Serialize map structure for WebSocket / React Three.js / Canvas frontend."""
        return {
            "width": self.width,
            "height": self.height,
            "grid": self.grid,
            "dynamic_obstacles": list(self.dynamic_obstacles),
            "narrow_aisles": list(self.narrow_aisles),
            "stations": {
                k: {
                    "id": v.id,
                    "name": v.name,
                    "type": v.station_type,
                    "station_type": v.station_type,
                    "x": v.x,
                    "y": v.y,
                    "zone": v.zone,
                }
                for k, v in self.stations.items()
            },
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)


if __name__ == "__main__":
    wm = WarehouseMap()
    print("Warehouse Map Updated (Dual-Zone Multi-Building Layout):")
    print(f"- Dimensions: {wm.width} x {wm.height} ({wm.width * wm.height} total cells)")
    print(f"- Stations ({len(wm.stations)}): {len(wm.get_stations_by_type('pickup'))} Pickups, "
          f"{len(wm.get_stations_by_type('dropoff'))} Dropoffs, {len(wm.get_stations_by_type('charging'))} Charging Bays")
    print(f"- Top Charging Rows (y=1): {[s.id for s in wm.get_stations_by_type('charging') if s.y == 1]}")
    print(f"- Bottom Charging Rows (y=48): {[s.id for s in wm.get_stations_by_type('charging') if s.y == 48]}")

    # Connectivity Check
    from collections import deque
    start = (wm.stations["P-01"].x, wm.stations["P-01"].y)
    visited = {start}
    q = deque([start])
    while q:
        curr = q.popleft()
        for nbr in wm.get_neighbors(curr[0], curr[1]):
            if nbr not in visited:
                visited.add(nbr)
                q.append(nbr)

    all_stations_reachable = all((s.x, s.y) in visited for s in wm.stations.values())
    print(f"- Graph Connectivity Verified: Stations Reachable={all_stations_reachable}")
