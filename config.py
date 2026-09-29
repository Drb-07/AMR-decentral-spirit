"""Paths and constants shared across the server."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
INDEX_HTML = BASE_DIR / "templates" / "index.html"

HOST = "127.0.0.1"
PORT = 8000

WAREHOUSE_WIDTH = 170
WAREHOUSE_HEIGHT = 50
FLOORS_PER_RACK = 5
