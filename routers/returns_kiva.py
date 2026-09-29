"""Feature 9: returns/putback, order cancellation and Kiva pod-to-picker mode."""
import time

from fastapi import APIRouter, Request

import state

router = APIRouter()


@router.post("/api/fleet/returns/trigger")
async def trigger_return_shipment():
    """Trigger a customer return shipment that a bot will pick up and putback into rack."""
    cmd = {"action": "TRIGGER_RETURN", "timestamp": time.time()}
    state.pending_return_triggers.append(cmd)
    return {"status": "ok", "message": "Return shipment triggered — bot will collect and putback into racks.", "command": cmd}


@router.post("/api/fleet/orders/cancel")
async def cancel_outbound_order(req: Request):
    """Cancel an in-progress outbound order (mid-flight or pending). Items restored to racks."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    order_id = body.get("orderId") or body.get("order_id")
    if not order_id:
        return {"status": "error", "message": "orderId is required", "example": {"orderId": "ORD-5"}}
    cmd = {"action": "CANCEL_ORDER", "orderId": order_id, "timestamp": time.time()}
    state.pending_order_cancellations.append(cmd)
    return {"status": "ok", "message": f"Cancellation queued for order {order_id} — items will be restored to racks on next sync.", "command": cmd}


@router.post("/api/fleet/kiva/toggle")
async def toggle_kiva_mode():
    """Toggle Kiva/Pod-to-Picker operating mode on or off."""
    cmd = {"action": "TOGGLE_KIVA", "timestamp": time.time()}
    state.pending_kiva_toggles.append(cmd)
    return {"status": "ok", "message": "Kiva mode toggle queued.", "command": cmd}


@router.get("/api/fleet/kiva/status")
async def get_kiva_status():
    """Return current Kiva/Pod-to-Picker mode status and pod state."""
    if state.latest_fleet_logs is None:
        return {"status": "ok", "kiva": {"enabled": False, "pods": [], "pickerStations": [], "metrics": {}}, "timestamp": time.time()}
    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {})
    returns_metrics = biz.get("returnsAndFulfillmentFlow", {})
    return {
        "status": "ok",
        "timestamp": time.time(),
        "kiva": {
            "enabled": returns_metrics.get("kivaEnabled", False),
            "mobilePods": returns_metrics.get("mobilePods", 0),
            "activePods": returns_metrics.get("activeKivaPods", 0),
            "kivaPodsDelivered": returns_metrics.get("kivaPodsDelivered", 0),
            "kivaPicksCompleted": returns_metrics.get("kivaPicksCompleted", 0),
        },
        "returnsAndFulfillmentFlow": returns_metrics
    }


@router.get("/api/fleet/returns/metrics")
async def get_returns_metrics():
    """Return returns flow and order cancellation KPIs."""
    if state.latest_fleet_logs is None:
        return {
            "status": "ok",
            "returnsMetrics": {
                "totalReturnsMissionsCreated": 0,
                "totalReturnsParcelsStowed": 0,
                "totalOrdersCancelled": 0,
                "totalCancelledItemsRestored": 0,
                "kivaPodsDelivered": 0,
                "kivaPicksCompleted": 0
            },
            "timestamp": time.time()
        }
    biz = state.latest_fleet_logs.get("businessAndThroughputKpis", {})
    returns_data = biz.get("returnsAndFulfillmentFlow", {})
    return {
        "status": "ok",
        "timestamp": time.time(),
        "returnsMetrics": returns_data
    }
