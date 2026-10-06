from fastapi import APIRouter, Depends
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from utils import iso
from database import db
from security import optional_user

router = APIRouter()
ITALY = ZoneInfo("Europe/Rome")

# ---------- Dashboard summary ----------
# Ottiene dal DB quello che serve alla home: 
# ultimi comunicati, prossime scadenze, le squadre e dati della propria squadra se loggato
@router.get("/dashboard/summary")
async def summary(user=Depends(optional_user)):
    latest_communiques = await db.communiques.find({}, {"_id": 0}).sort([
        ("pinned", -1),
        ("created_at", -1),
    ]).limit(5).to_list(5)
    placeholder_date = iso(datetime(1999, 12, 31, tzinfo=ITALY).astimezone(timezone.utc))
    
    team = None
    if user and user["role"] == "presidente":
        q = {}
    elif user and user.get("team_id"):
        team = await db.teams.find_one({"id": user["team_id"]}, {"_id": 0})
        q = {"$or": [{"team_id": user.get("team_id")}, {"team_id": None}]}
    else:
        q = {"team_id": None}

    q["done"] = {"$ne": True}
    q["due_date"] = {"$nin": [placeholder_date, None]}
    upcoming = await db.reminders.find(q, {"_id": 0}).sort("due_date", 1).limit(15).to_list(15)
    teams = await db.teams.find({}, {"_id": 0}).to_list(None)

    return {
        "teams": teams,
        "latest_communiques": latest_communiques,
        "upcoming_reminders": upcoming,
        "my_team": team,
    }