"""Mutable in-memory server state.

Other modules must access these as ``state.<name>`` (not ``from state import x``)
so that re-assignments such as ``state.latest_fleet_logs = data`` are seen everywhere.
"""
from typing import Set

from fastapi import WebSocket

# Open dashboard WebSocket connections
active_connections: Set[WebSocket] = set()

# Last telemetry snapshot posted by the browser simulation
latest_fleet_logs = None

# Commands queued by REST calls; drained by the browser on its next /logs/sync
pending_fault_injections: list = []
pending_service_actions: list = []
pending_return_triggers: list = []
pending_order_cancellations: list = []
pending_kiva_toggles: list = []

# Audit trails
fault_history: list = []
service_history: list = []
chaos_events: list = []

# Human-worker presence flag
humans_enabled = True
