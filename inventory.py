"""
Live Warehouse Inventory & 3D Multi-Tier Rack Memory System
Part of Edge-AI Distributed Fleet Coordination for AMRs

Features:
- 3D Rack Storage: Each rack cell has 5 vertical floor levels (Level 1 to 5)
- Inbound memory: Docks stay lit yellow until AMR/bot picks up the batch
- Outbound memory: Departure bays light up yellow until order is deposited
- Dynamic slot allocation and inventory de-allocation
- Full parcel lifecycle tracking (ID, SKU, Weight, Dock, Rack (X, Y, Floor), Timestamp)
"""

import time
import random
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass, asdict

from warehouse_map import WarehouseMap, CELL_RACK


SKU_CATALOG = [
    {"sku": "SKU-FMCG", "name": "Retail Packaged Goods", "unit_weight": 6.7, "velocity_class": "A", "demand_weight": 0.50},
    {"sku": "SKU-ELEC", "name": "Consumer Electronics", "unit_weight": 4.5, "velocity_class": "A", "demand_weight": 0.30},
    {"sku": "SKU-FASH", "name": "Apparel & Footwear Box", "unit_weight": 2.2, "velocity_class": "B", "demand_weight": 0.12},
    {"sku": "SKU-PHRM", "name": "Cold-Chain Pharma Tote", "unit_weight": 3.8, "velocity_class": "B", "demand_weight": 0.05},
    {"sku": "SKU-AUTO", "name": "Automotive Components", "unit_weight": 14.2, "velocity_class": "C", "demand_weight": 0.02},
    {"sku": "SKU-INDM", "name": "Industrial Hardware Crate", "unit_weight": 18.5, "velocity_class": "C", "demand_weight": 0.01},
]


@dataclass
class Parcel:
    parcel_id: str
    sku: str
    sku_name: str
    weight: float
    origin_dock: str
    destination_bay: Optional[str] = None
    rack_x: Optional[int] = None
    rack_y: Optional[int] = None
    rack_floor: Optional[int] = None  # 1 to 5
    created_at: float = 0.0
    status: str = "INBOUND_QUEUED"  # INBOUND_QUEUED, STORED_IN_RACK, IN_TRANSIT, DELIVERED
    velocity_class: str = "A"


def get_rack_category_info(y: int) -> dict:
    """Categorized horizontal rack row bands: 3 rows per SKU category."""
    idx = 0
    if 5 <= y <= 22:
        idx = (y - 5) // 3
    elif 27 <= y <= 44:
        idx = (y - 27) // 3
    idx = max(0, min(len(SKU_CATALOG) - 1, idx))
    return SKU_CATALOG[idx]


class RackCell:
    def __init__(self, x: int, y: int, max_floors: int = 5, category_sku: str = "", category_name: str = "", zone: str = "ZONE_A", dock_transit_cost: float = 0.0):
        self.x = x
        self.y = y
        self.max_floors = max_floors
        self.category_sku = category_sku
        self.category_name = category_name
        self.zone = zone  # ZONE_A (fast-mover), ZONE_B (medium-mover), ZONE_C (slow-mover deep reserve)
        self.dock_transit_cost = dock_transit_cost
        # Floor 1 to max_floors (1-indexed) -> Optional[Parcel]
        self.floors: Dict[int, Optional[Parcel]] = {f: None for f in range(1, max_floors + 1)}

    @property
    def occupied_count(self) -> int:
        return sum(1 for p in self.floors.values() if p is not None)

    @property
    def is_full(self) -> bool:
        return self.occupied_count >= self.max_floors

    @property
    def is_empty(self) -> bool:
        return self.occupied_count == 0

    def get_first_empty_floor(self) -> Optional[int]:
        for floor in range(1, self.max_floors + 1):
            if self.floors[floor] is None:
                return floor
        return None

    def store_parcel(self, parcel: Parcel, floor: Optional[int] = None) -> Optional[int]:
        if floor is None:
            floor = self.get_first_empty_floor()
        if floor is None or self.floors[floor] is not None:
            return None
        parcel.rack_x = self.x
        parcel.rack_y = self.y
        parcel.rack_floor = floor
        parcel.status = "STORED_IN_RACK"
        self.floors[floor] = parcel
        return floor

    def remove_parcel(self, floor: int) -> Optional[Parcel]:
        if floor in self.floors and self.floors[floor] is not None:
            parcel = self.floors[floor]
            self.floors[floor] = None
            return parcel
        return None

    def to_dict(self) -> dict:
        return {
            "x": self.x,
            "y": self.y,
            "category_sku": self.category_sku,
            "category_name": self.category_name,
            "zone": self.zone,
            "dock_transit_cost": round(self.dock_transit_cost, 1),
            "max_floors": self.max_floors,
            "occupied_count": self.occupied_count,
            "is_full": self.is_full,
            "floors": {
                f: (asdict(p) if p else None) for f, p in self.floors.items()
            }
        }


class InventoryManager:
    def __init__(self, warehouse: WarehouseMap, floors_per_rack: int = 5):
        self.warehouse = warehouse
        self.floors_per_rack = floors_per_rack
        self.racks: Dict[Tuple[int, int], RackCell] = {}

        # Inbound Queues: dock_id -> List[Parcel] waiting for pickup
        self.inbound_queues: Dict[str, List[Parcel]] = {
            s.id: [] for s in warehouse.get_stations_by_type("pickup")
        }

        # Outbound Orders: bay_id -> dict with order info & parcels being delivered
        self.outbound_orders: Dict[str, Optional[dict]] = {
            s.id: None for s in warehouse.get_stations_by_type("dropoff")
        }

        self.parcel_seq = 1000
        self.order_seq = 2000

        self.slotting_metrics = {
            "policy": "ABC_VELOCITY_PROXIMITY",
            "total_picks": 0,
            "total_stows": 0,
            "total_pick_distance": 0.0,
            "total_stow_distance": 0.0,
            "baseline_random_pick_dist": 52.4,
            "total_reslotting_moves": 0,
            "promotions_count": 0,
            "demotions_count": 0,
            "consolidations_count": 0,
            "cumulative_distance_saved_cells": 0.0,
            "audit_trail": []
        }

        self._init_racks()

    def compute_rack_dock_cost(self, x: int, y: int) -> Tuple[float, str]:
        """Calculates transit distance cost to operational docks & bays, assigning ABC velocity zone."""
        pickups = self.warehouse.get_stations_by_type("pickup")
        dropoffs = self.warehouse.get_stations_by_type("dropoff")
        min_in = min(abs(x - p.x) + abs(y - p.y) for p in pickups) if pickups else 20.0
        min_out = min(abs(x - d.x) + abs(y - d.y) for d in dropoffs) if dropoffs else 20.0
        cost = 0.4 * min_in + 0.6 * min_out
        if cost <= 18.0:
            zone = "ZONE_A"
        elif cost <= 28.0:
            zone = "ZONE_B"
        else:
            zone = "ZONE_C"
        return cost, zone

    def _init_racks(self):
        """Initialize 3D rack cells with category assignments and ABC proximity zones."""
        for x in range(1, self.warehouse.width - 1):
            for y in range(1, self.warehouse.height - 1):
                if self.warehouse.grid[x][y] == CELL_RACK:
                    cat = get_rack_category_info(y)
                    cost, zone = self.compute_rack_dock_cost(x, y)
                    self.racks[(x, y)] = RackCell(
                        x=x, y=y,
                        max_floors=self.floors_per_rack,
                        category_sku=cat["sku"],
                        category_name=cat["name"],
                        zone=zone,
                        dock_transit_cost=cost
                    )

    @property
    def total_capacity(self) -> int:
        return len(self.racks) * self.floors_per_rack

    @property
    def total_stored_parcels(self) -> int:
        return sum(r.occupied_count for r in self.racks.values())

    @property
    def occupancy_rate(self) -> float:
        if self.total_capacity == 0:
            return 0.0
        return (self.total_stored_parcels / self.total_capacity) * 100.0

    def get_sku_velocity_class(self, sku: str) -> str:
        for c in SKU_CATALOG:
            if c["sku"] == sku:
                return c.get("velocity_class", "A")
        return "A"

    def find_optimal_rack_slot_for_sku(self, sku: str, origin_dock_id: Optional[str] = None, policy: str = "ABC_VELOCITY") -> Optional[Tuple[int, int, int]]:
        """
        Finds optimal slot for SKU based on ABC velocity and dock proximity.
        High-velocity SKUs (Class A) -> ZONE_A closest to docks/bays.
        Medium-velocity SKUs (Class B) -> ZONE_B.
        Low-velocity SKUs (Class C) -> ZONE_C deep storage.
        """
        if policy == "RANDOM":
            return self.find_available_rack_slot()

        v_class = self.get_sku_velocity_class(sku)
        if v_class == "A":
            target_zones = ["ZONE_A", "ZONE_B", "ZONE_C"]
        elif v_class == "B":
            target_zones = ["ZONE_B", "ZONE_A", "ZONE_C"]
        else:
            target_zones = ["ZONE_C", "ZONE_B", "ZONE_A"]

        # Dock position
        dock_pos = None
        if origin_dock_id and origin_dock_id in self.warehouse.stations:
            st = self.warehouse.stations[origin_dock_id]
            dock_pos = (st.x, st.y)

        dropoffs = self.warehouse.get_stations_by_type("dropoff")

        for z in target_zones:
            cat_candidates = []
            any_candidates = []
            for (rx, ry), rack in self.racks.items():
                if rack.zone == z and not rack.is_full:
                    floor = rack.get_first_empty_floor()
                    if floor is not None:
                        if rack.category_sku == sku:
                            cat_candidates.append((rx, ry, floor, rack))
                        any_candidates.append((rx, ry, floor, rack))

            pool = cat_candidates if cat_candidates else any_candidates
            if pool:
                best_slot = None
                best_score = float("inf")
                for rx, ry, floor, rack in pool:
                    # Score by transit distance + floor height penalty
                    d_in = (abs(rx - dock_pos[0]) + abs(ry - dock_pos[1])) if dock_pos else rack.dock_transit_cost
                    d_out = min(abs(rx - d.x) + abs(ry - d.y) for d in dropoffs) if dropoffs else 20.0
                    # Floors 2, 3 have zero lift penalty (Golden Zone)
                    tier_pen = 0.0 if floor in (2, 3) else (1.0 if floor in (1, 4) else 2.5)
                    score = 0.5 * d_in + 0.5 * d_out + tier_pen
                    if score < best_score:
                        best_score = score
                        best_slot = (rx, ry, floor)
                if best_slot:
                    return best_slot

        return self.find_available_rack_slot()

    def find_available_rack_slot_for_sku(self, sku: str) -> Optional[Tuple[int, int, int]]:
        """Backwards-compatible wrapper calling find_optimal_rack_slot_for_sku."""
        return self.find_optimal_rack_slot_for_sku(sku)

    def find_available_rack_slot(self) -> Optional[Tuple[int, int, int]]:
        """Fallback slot finder."""
        any_slots = []
        for (rx, ry), rack in self.racks.items():
            if not rack.is_full:
                floor = rack.get_first_empty_floor()
                if floor is not None:
                    any_slots.append((rx, ry, floor))
        return random.choice(any_slots) if any_slots else None

    def add_inbound_shipment(self, dock_id: str, count: Optional[int] = None) -> List[Parcel]:
        """
        Inbound dock receives a batch of r parcels (1 < r < 10, i.e., 2 to 9).
        Dock stays lit yellow while parcels are waiting in queue.
        """
        if count is None:
            count = random.randint(2, 9)

        new_parcels = []
        now = time.time()
        for _ in range(count):
            self.parcel_seq += 1
            cat = random.choice(SKU_CATALOG)
            weight = round(cat["unit_weight"] + random.uniform(-1.0, 3.0), 1)
            parcel = Parcel(
                parcel_id=f"PKG-{self.parcel_seq}",
                sku=cat["sku"],
                sku_name=cat["name"],
                weight=weight,
                origin_dock=dock_id,
                created_at=now,
                status="INBOUND_QUEUED"
            )
            new_parcels.append(parcel)

        self.inbound_queues[dock_id].extend(new_parcels)
        return new_parcels

    def pickup_and_shelf_inbound(self, dock_id: str) -> List[dict]:
        """
        Simulate bot collecting parcels from inbound dock and shelving them into designated category rows at random positions.
        Returns list of stored parcel allocations.
        """
        stored_records = []
        parcels_to_store = list(self.inbound_queues.get(dock_id, []))
        self.inbound_queues[dock_id].clear()

        for parcel in parcels_to_store:
            slot = self.find_available_rack_slot_for_sku(parcel.sku)
            if slot:
                rx, ry, floor = slot
                self.racks[(rx, ry)].store_parcel(parcel, floor=floor)
                stored_records.append({
                    "parcel_id": parcel.parcel_id,
                    "sku": parcel.sku,
                    "weight": parcel.weight,
                    "dock": dock_id,
                    "rack": (rx, ry),
                    "floor": floor
                })
            else:
                # Warehouse completely full: re-queue
                self.inbound_queues[dock_id].append(parcel)

        return stored_records

    def bulk_store_parcels(self, count: int) -> int:
        """Directly allocate and store N parcels into categorized 3D rack rows at random positions."""
        stored = 0
        now = time.time()
        for _ in range(count):
            cat = random.choice(SKU_CATALOG)
            slot = self.find_available_rack_slot_for_sku(cat["sku"])
            if not slot:
                break
            rx, ry, floor = slot
            self.parcel_seq += 1
            weight = round(cat["unit_weight"] + random.uniform(-1.0, 3.0), 1)
            parcel = Parcel(
                parcel_id=f"PKG-{self.parcel_seq}",
                sku=cat["sku"],
                sku_name=cat["name"],
                weight=weight,
                origin_dock="BULK_INGEST",
                created_at=now,
                status="STORED_IN_RACK"
            )
            self.racks[(rx, ry)].store_parcel(parcel, floor=floor)
            stored += 1
        return stored

    def clear_all_inventory(self):
        """Clears all stored parcels from 3D racks."""
        for rack in self.racks.values():
            for f in range(1, rack.max_floors + 1):
                rack.floors[f] = None

    def request_outbound_order(self, bay_id: str, count: Optional[int] = None) -> Optional[dict]:
        """
        Outbound departure bay asks for r parcels (1 < r < 10, i.e., 2 to 9).
        Bay lights up yellow until parcels are deposited.
        Retrieves random parcels across rows so future AMR bots travel across the warehouse.
        """
        if count is None:
            count = random.randint(2, 9)

        # Collect all available stored parcels from racks
        available_parcels: List[Tuple[Tuple[int, int], int, Parcel]] = []
        for (rx, ry), rack in self.racks.items():
            for floor, p in rack.floors.items():
                if p is not None:
                    available_parcels.append(((rx, ry), floor, p))

        if not available_parcels:
            return None  # No parcels available in racks to fulfill

        # Randomize selection so outbound pulls from across all rows in the warehouse
        random.shuffle(available_parcels)
        selected_parcels = available_parcels[:count]

        self.order_seq += 1
        order_id = f"ORD-{self.order_seq}"

        # Fetch and remove parcels from the racks (clearing rack space)
        retrieved_parcels = []
        for (rx, ry), floor, p in selected_parcels:
            removed = self.racks[(rx, ry)].remove_parcel(floor)
            if removed:
                removed.destination_bay = bay_id
                removed.status = "IN_TRANSIT"
                retrieved_parcels.append(removed)

        order_data = {
            "order_id": order_id,
            "bay_id": bay_id,
            "count": len(retrieved_parcels),
            "parcels": [asdict(p) for p in retrieved_parcels],
            "requested_at": time.time(),
            "status": "PROCESSING"
        }
        self.outbound_orders[bay_id] = order_data
        return order_data

    def deposit_outbound_order(self, bay_id: str) -> Optional[dict]:
        """
        Deposits parcels at outbound bay, completing the order.
        Departure bay then clears its yellow state.
        """
        order = self.outbound_orders.get(bay_id)
        if not order:
            return None

        order["status"] = "COMPLETED"
        order["completed_at"] = time.time()
        self.outbound_orders[bay_id] = None  # Cleared
        return order

    def is_inbound_active(self, dock_id: str) -> bool:
        """Returns True if inbound dock has waiting parcels (lit yellow)."""
        return len(self.inbound_queues.get(dock_id, [])) > 0

    def is_outbound_active(self, bay_id: str) -> bool:
        """Returns True if outbound bay is waiting for parcel deposit (lit yellow)."""
        return self.outbound_orders.get(bay_id) is not None

    def reslot_and_consolidate(self, max_moves: int = 5) -> dict:
        """
        Background optimization task:
        1. Promotes misplaced Class A SKUs from deep zones (ZONE_C/B) to vacant dock-adjacent ZONE_A slots.
        2. Demotes slow-moving Class C SKUs from ZONE_A to deep reserve ZONE_C slots.
        3. Consolidates fragmented tiers with same SKU to free up empty rack capacity.
        """
        moves_executed = []
        promotions = 0
        demotions = 0
        consolidations = 0
        dist_saved_total = 0.0

        # Pass 1: Class A Promotions (High-Velocity Correction)
        for (rx, ry), rack in list(self.racks.items()):
            if len(moves_executed) >= max_moves:
                break
            if rack.zone in ("ZONE_C", "ZONE_B"):
                for floor, parcel in list(rack.floors.items()):
                    if parcel and self.get_sku_velocity_class(parcel.sku) == "A":
                        # Attempt to find an empty slot in ZONE_A
                        target_slot = None
                        for (tx, ty), target_rack in self.racks.items():
                            if target_rack.zone == "ZONE_A" and not target_rack.is_full:
                                t_floor = target_rack.get_first_empty_floor()
                                if t_floor is not None:
                                    target_slot = (tx, ty, t_floor, target_rack)
                                    break
                        if target_slot:
                            tx, ty, t_floor, target_rack = target_slot
                            removed = rack.remove_parcel(floor)
                            if removed:
                                target_rack.store_parcel(removed, floor=t_floor)
                                dist_saved = max(0.0, rack.dock_transit_cost - target_rack.dock_transit_cost)
                                dist_saved_total += dist_saved
                                promotions += 1
                                moves_executed.append({
                                    "type": "PROMOTION",
                                    "parcel_id": removed.parcel_id,
                                    "sku": removed.sku,
                                    "velocity_class": "A",
                                    "from_rack": (rx, ry, floor),
                                    "to_rack": (tx, ty, t_floor),
                                    "distance_saved_cells": round(dist_saved, 1)
                                })
                                break

        # Pass 2: Class C Demotions (Clearing prime dock space)
        for (rx, ry), rack in list(self.racks.items()):
            if len(moves_executed) >= max_moves:
                break
            if rack.zone == "ZONE_A":
                for floor, parcel in list(rack.floors.items()):
                    if parcel and self.get_sku_velocity_class(parcel.sku) == "C":
                        target_slot = None
                        for (tx, ty), target_rack in self.racks.items():
                            if target_rack.zone == "ZONE_C" and not target_rack.is_full:
                                t_floor = target_rack.get_first_empty_floor()
                                if t_floor is not None:
                                    target_slot = (tx, ty, t_floor, target_rack)
                                    break
                        if target_slot:
                            tx, ty, t_floor, target_rack = target_slot
                            removed = rack.remove_parcel(floor)
                            if removed:
                                target_rack.store_parcel(removed, floor=t_floor)
                                demotions += 1
                                moves_executed.append({
                                    "type": "DEMOTION",
                                    "parcel_id": removed.parcel_id,
                                    "sku": removed.sku,
                                    "velocity_class": "C",
                                    "from_rack": (rx, ry, floor),
                                    "to_rack": (tx, ty, t_floor),
                                    "distance_saved_cells": 0.0
                                })
                                break

        # Pass 3: Tier Consolidation (De-fragmenting partially full racks)
        for (rx, ry), rack in list(self.racks.items()):
            if len(moves_executed) >= max_moves:
                break
            if 0 < rack.occupied_count <= 2:
                # Find another rack with same SKU in same zone
                for floor, parcel in list(rack.floors.items()):
                    if parcel:
                        for (tx, ty), target_rack in self.racks.items():
                            if (tx, ty) != (rx, ry) and target_rack.category_sku == parcel.sku and target_rack.zone == rack.zone:
                                if not target_rack.is_full:
                                    t_floor = target_rack.get_first_empty_floor()
                                    if t_floor is not None:
                                        removed = rack.remove_parcel(floor)
                                        if removed:
                                            target_rack.store_parcel(removed, floor=t_floor)
                                            consolidations += 1
                                            moves_executed.append({
                                                "type": "CONSOLIDATION",
                                                "parcel_id": removed.parcel_id,
                                                "sku": removed.sku,
                                                "from_rack": (rx, ry, floor),
                                                "to_rack": (tx, ty, t_floor),
                                                "distance_saved_cells": 0.0
                                            })
                                            break
                        if len(moves_executed) >= max_moves:
                            break

        self.slotting_metrics["total_reslotting_moves"] += len(moves_executed)
        self.slotting_metrics["promotions_count"] += promotions
        self.slotting_metrics["demotions_count"] += demotions
        self.slotting_metrics["consolidations_count"] += consolidations
        self.slotting_metrics["cumulative_distance_saved_cells"] += dist_saved_total
        self.slotting_metrics["audit_trail"] = (moves_executed + self.slotting_metrics["audit_trail"])[:30]

        return {
            "status": "ok",
            "moves_count": len(moves_executed),
            "promotions": promotions,
            "demotions": demotions,
            "consolidations": consolidations,
            "distance_saved_cells": round(dist_saved_total, 1),
            "moves": moves_executed
        }

    def get_slotting_metrics(self) -> dict:
        """Returns comprehensive slotting compliance and efficiency telemetry."""
        zone_counts = {"ZONE_A": 0, "ZONE_B": 0, "ZONE_C": 0}
        sku_counts = {"A": {"optimal": 0, "total": 0}, "B": {"optimal": 0, "total": 0}, "C": {"optimal": 0, "total": 0}}
        total_items = 0

        for rack in self.racks.values():
            for p in rack.floors.values():
                if p:
                    total_items += 1
                    zone_counts[rack.zone] = zone_counts.get(rack.zone, 0) + 1
                    v_cls = self.get_sku_velocity_class(p.sku)
                    sku_counts[v_cls]["total"] += 1
                    is_optimal = (
                        (v_cls == "A" and rack.zone == "ZONE_A") or
                        (v_cls == "B" and rack.zone == "ZONE_B") or
                        (v_cls == "C" and rack.zone == "ZONE_C")
                    )
                    if is_optimal:
                        sku_counts[v_cls]["optimal"] += 1

        total_optimal = sum(v["optimal"] for v in sku_counts.values())
        compliance_pct = round((total_optimal / total_items * 100.0), 1) if total_items > 0 else 100.0

        return {
            "policy": self.slotting_metrics["policy"],
            "total_stored_items": total_items,
            "optimal_slotted_items": total_optimal,
            "slotting_compliance_percent": compliance_pct,
            "zone_distribution": zone_counts,
            "sku_velocity_breakdown": {
                "CLASS_A": {
                    "total": sku_counts["A"]["total"],
                    "optimal": sku_counts["A"]["optimal"],
                    "target_zone": "ZONE_A (Closest to Docks)"
                },
                "CLASS_B": {
                    "total": sku_counts["B"]["total"],
                    "optimal": sku_counts["B"]["optimal"],
                    "target_zone": "ZONE_B (Intermediate)"
                },
                "CLASS_C": {
                    "total": sku_counts["C"]["total"],
                    "optimal": sku_counts["C"]["optimal"],
                    "target_zone": "ZONE_C (Deep Reserve)"
                }
            },
            "re_slotting_and_consolidation": {
                "total_reslotting_moves": self.slotting_metrics["total_reslotting_moves"],
                "promotions_count": self.slotting_metrics["promotions_count"],
                "demotions_count": self.slotting_metrics["demotions_count"],
                "consolidations_count": self.slotting_metrics["consolidations_count"],
                "cumulative_distance_saved_cells": round(self.slotting_metrics["cumulative_distance_saved_cells"], 1),
                "recent_audit_events": self.slotting_metrics["audit_trail"][:10]
            }
        }

    def get_summary(self) -> dict:
        """Overview stats for dashboard HUD."""
        return {
            "total_racks": len(self.racks),
            "floors_per_rack": self.floors_per_rack,
            "total_capacity": self.total_capacity,
            "stored_parcels": self.total_stored_parcels,
            "occupancy_rate": round(self.occupancy_rate, 2),
            "inbound_status": {
                dock_id: len(queue) for dock_id, queue in self.inbound_queues.items()
            },
            "outbound_status": {
                bay_id: (order["count"] if order else 0) for bay_id, order in self.outbound_orders.items()
            },
            "slotting": self.get_slotting_metrics()
        }
