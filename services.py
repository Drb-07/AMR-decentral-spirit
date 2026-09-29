"""Long-lived singletons (warehouse map + inventory manager) shared by all routers."""
from config import FLOORS_PER_RACK, WAREHOUSE_HEIGHT, WAREHOUSE_WIDTH
from inventory import InventoryManager
from warehouse_map import WarehouseMap

warehouse = WarehouseMap(width=WAREHOUSE_WIDTH, height=WAREHOUSE_HEIGHT)
inventory = InventoryManager(warehouse=warehouse, floors_per_rack=FLOORS_PER_RACK)
