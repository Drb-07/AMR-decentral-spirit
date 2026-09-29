"""Pydantic request models."""
from pydantic import BaseModel


class BulkInjectRequest(BaseModel):
    count: int
