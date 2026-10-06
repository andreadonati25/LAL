import logging
import os
from datetime import datetime, timezone
from pymongo.errors import DuplicateKeyError
from fastapi import HTTPException
from zoneinfo import ZoneInfo

from database import db
from security import hash_pw, verify_pw
from utils import new_id, now_utc, iso
from routers.season import create_season
from routers.reminders import add_reminder
from models import SeasonSettingsIn, ReminderIn

logger = logging.getLogger("lalega")
ITALY = ZoneInfo("Europe/Rome")

# Crea presidente se non esiste e mantiene mail e password di sistema
async def seed_president():
    admin_email = os.environ.get("ADMIN_EMAIL")
    admin_pw = os.environ.get("ADMIN_PASSWORD")
    if not admin_email or not admin_pw:
        raise RuntimeError("Errore di configurazione: variabili d'ambiente obbligatorie")
    admin_email = admin_email.lower()
    existing_pres = await db.users.find_one({"email": admin_email})
    if not existing_pres: # Se non c'è il presidente, lo creiamo
        await db.users.insert_one({
            "id": new_id(),
            "email": admin_email,
            "password_hash": hash_pw(admin_pw),
            "name": "Presidente",
            "role": "presidente",
            "team_id": None,
            "created_at": iso(now_utc()),
            "updated_at": iso(now_utc()),
        })
        logger.info("Seeded presidente user")
    elif not verify_pw(admin_pw, existing_pres["password_hash"]) or admin_email != existing_pres["email"]:
        await db.users.update_one({"id": existing_pres["id"]}, {"$set": {"password_hash": hash_pw(admin_pw), "email": admin_email}})
        logger.info("Updated presidente email and password")

# Crea i reminder di default per l'inizio di una stagione (informativi + Composizione rosa Agosto)
async def seed_season_reminders(season: dict, next_taglio: int):
    season_start_year = season["season_start_year"]
    season_end_year = season_start_year + 1
    placeholder_date = iso(datetime(1999, 12, 31, tzinfo=ITALY).astimezone(timezone.utc))     # placeholder, il presidente lo corregge 
    # Creazione reminder informativi di base
    eventi = [
        ("Fair play finanziario", iso(datetime(season_start_year, 9, 1, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Asta estiva", placeholder_date),
        ("Chiusura mercato estivo", placeholder_date),
        ("Apertura mercato invernale", iso(datetime(season_end_year, 1, 2, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Asta invernale", placeholder_date),
        ("Chiusura mercato invernale", placeholder_date),
        ("Pagamento stipendi", iso(datetime(season_end_year, 6, 1, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Variazioni automatiche budget trasferimenti", iso(datetime(season_end_year, 6, 30, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Maturazione utili", iso(datetime(season_end_year, 6, 30, 23, 59, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Apertura mercato estivo", iso(datetime(season_end_year, 7, 1, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Variazioni automatiche VS", iso(datetime(season_end_year, 7, 1, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Distribuzione utili maturati", iso(datetime(season_end_year, 7, 1, 23, 59, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Cambio stagione ufficiale", iso(datetime(season_end_year, 7, 2, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
        ("Prossimo taglio", iso(datetime(next_taglio, 7, 1, 0, 1, tzinfo=ITALY).astimezone(timezone.utc))),
    ]
    for titolo, due_date in eventi:
        nuovo = {
            "title": titolo,
            "description": None,
            "due_date": due_date,
            "team_id": None,
            "entity": None,
            "entity_id": None,
            "kind": None,
            "stadium_work": 0,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass
    # Creazione reminder composizione rosa agosto
    nuovo = {
        "title": "Composizione rosa agosto",
        "description": "agosto",
        "due_date": season["date_composizione_rosa"].get("inizio_stagione"),
        "team_id": None,
        "entity": "season",
        "entity_id": season["id"],
        "kind": season["date_composizione_rosa"].get("inizio_stagione"),
        "stadium_work": 0,
    }
    try:
        await add_reminder(ReminderIn(**nuovo))
    except DuplicateKeyError:
        pass
    # Creazione reminder salvataggio dati luglio
    nuovo = {
        "title": "Salvataggio dati squadra luglio",
        "description": "luglio",
        "due_date": iso(datetime(season_start_year, 8, 1, 0, 0, tzinfo=ITALY).astimezone(timezone.utc)),
        "team_id": None,
        "entity": "season",
        "entity_id": season["id"],
        "kind": "fine_mese",
        "stadium_work": 0,
    }
    try:
        await add_reminder(ReminderIn(**nuovo))
    except DuplicateKeyError:
        pass

# Crea una stagione corrente se non esiste, quindi i reminder di default
async def seed_season():
    if await db.season_settings.find_one({"current": True}):
       return
    season_start_year = int(os.environ.get("SEASON_START_YEAR", "2026"))
    squadre_raw = os.environ.get("SEASON_SQUADRE_SERIE_A", "")
    next_taglio = int(os.environ.get("NEXT_TAGLIO", "2029"))
    squadre_serie_a = [s.strip() for s in squadre_raw.split(",") if s.strip()]
    if len(squadre_serie_a) != 20:
        logger.warning(f"SEASON_SQUADRE_SERIE_A nel .env non contiene 20 squadre valide ({len(squadre_serie_a)} trovate): stagione di default non creata")
        return
    # Creazione della stagione
    data = SeasonSettingsIn(season_start_year=season_start_year, squadre_serie_a=squadre_serie_a)
    try:
        season = await create_season(data)
    except HTTPException as e:
        logger.warning(f"Creazione stagione di default fallita: {e.detail}")
        return
    logger.info(f"Seeded season {season_start_year}/{season_start_year + 1}")
    # Crea reminder di default
    await seed_season_reminders(season, next_taglio)

async def seed_defaults():
    # Check presidente
    await seed_president()
    # Check stagione
    await seed_season()