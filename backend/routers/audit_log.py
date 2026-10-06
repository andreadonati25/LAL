from typing import Optional
from fastapi import APIRouter, Depends

from database import db
from security import get_current_user

router = APIRouter()

# ---------- Audit log ----------

# Ritorna la lista dei cambiamenti più recenti
@router.get("/audit")
async def list_audit(entity: Optional[str] = None, limit: Optional[int] = None, user=Depends(get_current_user)):
    q = {}
    if entity: q["entity"] = entity
    cursor = db.audit_log.find(q, {"_id": 0}).sort("at", -1)
    if limit is not None:
        cursor = cursor.limit(limit)
    logs = await cursor.to_list(limit)
    return logs