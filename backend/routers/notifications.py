from typing import Optional
from fastapi import APIRouter, Depends

from database import db
from security import get_current_user
from utils import iso, new_id, now_utc

router = APIRouter()

# ---------- Notifications ----------
# Crea una notifica, con i seguenti attributi: id, user_id, text, link, read, created_at
async def add_notification(user_id: Optional[str], text: str, link: str = "/"):
    # Controlli
    if not user_id:
        return
    # Creazione
    await db.notifications.insert_one({
        "id": new_id(),
        "user_id": user_id,
        "text": text,
        "link": link,
        "read": False,
        "created_at": iso(now_utc())
    })

# Segna come letta una notifica
@router.post("/notifications/{notif_id}/read")
async def mark_read(notif_id: str, user=Depends(get_current_user)):
    await db.notifications.update_one({"id": notif_id, "user_id": user["id"]}, {"$set": {"read": True}})
    return {"ok": True}

# Segna come lette tutte le notifiche non lette
@router.post("/notifications/read-all")
async def mark_all_read(user=Depends(get_current_user)):
    await db.notifications.update_many({"user_id": user["id"], "read": False}, {"$set": {"read": True}})
    return {"ok": True}

# Ottiene le 100 notifiche più recenti dell'utente attuale
@router.get("/notifications")
async def list_notifications(limit: int = 100, user=Depends(get_current_user)):
    user_id = user["id"]
    unread = await db.notifications.find({"user_id": user_id, "read": False}, {"_id": 0}).sort("created_at", -1).to_list(None)
    unread_count = len(unread)
    total = 10
    read_limit = max(0, total - unread_count)
    read = await db.notifications.find({"user_id": user["id"], "read": True}, {"_id": 0}).sort("created_at", -1).limit(read_limit).to_list(read_limit)
    return unread + read