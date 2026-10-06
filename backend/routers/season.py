from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from database import db
from models import SeasonSettingsIn, CompRoseScadenze
from security import optional_user, require_president
from utils import audit, iso, new_id, now_utc
from business import compute_default_mese_date

router = APIRouter()

MONTHS_IT = ["luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
             "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno"]
DEADLINE_ORDER = ["luglio", "agosto", "inizio_stagione", "settembre", "asta_estiva", "ottobre",
                  "novembre", "dicembre", "gennaio", "febbraio", "asta_invernale",
                  "marzo", "aprile", "maggio", "giugno"]
DEADLINE_TO_MONTH = {"agosto": "luglio",
                    "inizio_stagione": "agosto",
                    "asta_estiva": "settembre",
                    "asta_invernale": "febbraio", }

# ---------- Season Settings ----------
# Lettura della stagione corrente.
@router.get("/season/current")
async def get_current_season(user=Depends(optional_user)):
    s = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Impostazioni di stagione non ancora create")
    s["season_end_year"] = s["season_start_year"] + 1
    return s

# Lettura di una stagione.
@router.get("/season/{season_start_year}")
async def get_season(season_start_year: int, user=Depends(optional_user)):
    s = await db.season_settings.find_one({"season_start_year": season_start_year}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Impostazioni di stagione non trovate")
    s["season_end_year"] = s["season_start_year"] + 1
    return s

# Modifica delle sole scadenze di composizione rosa. Solo il presidente.
@router.patch("/season")
async def patch_season_deadlines(patch: dict, president=Depends(require_president)):
    # Import
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    dcr = season.get("date_composizione_rosa")
    rem_comp = await db.reminders.find_one(
        {"done": False, "entity": "season", "entity_id": season["id"],
         "$expr": {"$eq": ["$due_date", "$kind"]}},
        {"_id": 0}
    )
    if not rem_comp:
        raise HTTPException(404, "Nessuna reminder di composizione rosa corrente impostato")
    # Controlli
    if "date_composizione_rosa" not in patch or not isinstance(patch["date_composizione_rosa"], dict):
        raise HTTPException(status_code=400, detail="date_composizione_rosa mancante o non valido")
    merged = {**dcr, **patch["date_composizione_rosa"]}
    try:
        validated = CompRoseScadenze(**merged).model_dump()
    except ValidationError:
        raise HTTPException(status_code=400, detail="date_composizione_rosa non valido")
    # None indica una deadline non ancora raggiunta: la consideriamo futura e non passata.
    deadline_dates = {}
    now = now_utc()
    for field in DEADLINE_ORDER:
        value = validated.get(field)
        if value is None:
            if field in MONTHS_IT:
                raise HTTPException(status_code=400, detail=f"{field}: la data non può essere nulla")
            # Le tre deadline opzionali possono restare None finché non vengono definite.
            continue
        try:
            deadline_date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail=f"{field}: {value} non è una data valida")
        if deadline_date.tzinfo is None:
            deadline_date = deadline_date.replace(tzinfo=timezone.utc)
        else:
            deadline_date = deadline_date.astimezone(timezone.utc)
        deadline_dates[field] = deadline_date
        old_value = dcr.get(field)
        # Una nuova data, anche se sostituisce None, deve essere nel futuro.
        if value != old_value and deadline_date < now:
            raise HTTPException(
                status_code=400,
                detail=f"{field}: non è possibile impostare una scadenza nel passato"
            )
        # Una deadline già valorizzata e passata non può essere spostata.
        if value != old_value and old_value is not None:
            old_date = datetime.fromisoformat(old_value.replace("Z", "+00:00"))
            if old_date.tzinfo is None:
                old_date = old_date.replace(tzinfo=timezone.utc)
            else:
                old_date = old_date.astimezone(timezone.utc)
            if old_date < now:
                raise HTTPException(
                    status_code=400,
                    detail=f"{field}: non è possibile modificare una scadenza già passata"
                )
    # Controllo che siano tutte differenti e in ordine cronologico.
    previous_field = None
    previous_date = None
    for field in DEADLINE_ORDER:
        current_date = deadline_dates.get(field)
        if current_date is None:
            continue
        if previous_date is not None and current_date <= previous_date:
            raise HTTPException(
                status_code=400,
                detail=f"Le scadenze devono essere tutte differenti e in ordine cronologico: "
                       f"{field} ({validated[field]}) non è successiva a {previous_field} ({validated[previous_field]})"
            )
        previous_field = field
        previous_date = current_date
    # Otteniamo tutti i reminder di composizione rosa passati e confermati
    confirmed = await db.reminders.find(
        {"done": True, "entity": "season", "entity_id": season["id"],
         "kind": {"$in": [dcr.get(field) for field in DEADLINE_ORDER]},
         "$expr": {"$eq": ["$due_date", "$kind"]}},
        {"_id": 0, "kind": 1}
    ).to_list(None)
    # Otteniamo gli indici delle deadline confermate
    confirmed_indexes = [
        index for reminder in confirmed
        for index, field in enumerate(DEADLINE_ORDER)
        if dcr.get(field) == reminder.get("kind")
    ]
    # Le deadline confermate non possono essere cambiate
    if confirmed_indexes:
        last_confirmed = max(confirmed_indexes)
        locked_changes = [
            field for index, field in enumerate(DEADLINE_ORDER[:last_confirmed + 1])
            if validated.get(field) != dcr.get(field)
        ]
        if locked_changes:
            raise HTTPException(
                status_code=400,
                detail=f"Scadenze già confermate e non modificabili: {', '.join(locked_changes)}"
            )
    # Modifica
    filtered = {"date_composizione_rosa": validated, "updated_at": iso(now_utc())}
    await db.season_settings.update_one({"id": season["id"]}, {"$set": filtered})
    # Storico Modifiche
    s2 = await db.season_settings.find_one({"id": season["id"]}, {"_id": 0})
    dcr2 = s2.get("date_composizione_rosa")
    diff = {"date_composizione_rosa": {"from": dcr, "to": dcr2}}
    await audit(president, "season", season["id"], "updated", diff, "La Presidenza ha modificato i termini di consegna della composizione rosa")
    # Modifica al reminder attuale
    mese = rem_comp["description"]
    if mese == "settembre":
        due_date = dcr2.get("asta_estiva")
    elif mese == "febbraio":
        due_date = dcr2.get("asta_invernale")
    else:
        due_date = dcr2.get(mese)
    try:
        await db.reminders.update_one(
            {"id": rem_comp["id"], "description": mese, "done": False, "entity": "season", "entity_id": season["id"],
            "$expr": {"$eq": ["$due_date", "$kind"]}},
            {"$set": {"due_date": due_date, "kind": due_date, "updated_at": iso(now_utc())}}
        )
    except DuplicateKeyError:
        pass
    # Modifica tutte le composizioni rosa con una deadline modificata
    for field in DEADLINE_ORDER:
        old_due_date = dcr.get(field)
        new_due_date = dcr2.get(field)
        if old_due_date == new_due_date:
            continue
        mese_deadline = DEADLINE_TO_MONTH.get(field, field)
        await db.composizioni_rosa.update_many(
            {"mese": mese_deadline, "scadenza": old_due_date},
            {"$set": {"scadenza": new_due_date, "updated_at": iso(now_utc())}}
        )
    # Ritorno
    s2["season_end_year"] = s2["season_start_year"] + 1
    return s2

# Creazione di una nuova stagione: usata ad ogni cambio stagione:
# archivia la stagione corrente attuale e attiva quella nuova.
async def create_season(data: SeasonSettingsIn):
    # Controlli
    if len(data.squadre_serie_a) != 20:
        raise HTTPException(status_code=400, detail="La lista delle squadre di Serie A deve contenere esattamente 20 squadre")
    if len(set(data.squadre_serie_a)) != len(data.squadre_serie_a):
        raise HTTPException(status_code=400, detail="La lista delle squadre di Serie A contiene duplicati")
    if await db.season_settings.find_one({"season_start_year": data.season_start_year}):
        raise HTTPException(status_code=400, detail="Questa stagione esiste già")
    if data.season_start_year < 2010:
        raise HTTPException(status_code=400, detail="Anno della stagione errato")
    doc = data.model_dump()
    validated = doc["date_composizione_rosa"]
    for m in MONTHS_IT:
        v = validated.get(m)
        if v is not None:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail=f"{m}: {v} non è una data valida")
        else:
            validated[m] = compute_default_mese_date(m, data.season_start_year)
    for f in ("inizio_stagione", "asta_estiva", "asta_invernale"):
        v = validated.get(f)
        if v is not None:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail=f"{f}: {v} non è una data valida")
    # Creazione
    doc["date_composizione_rosa"] = validated
    doc["current"] = True  # forzato: non dipende da cosa manda il client
    doc.update({"id": new_id(), "created_at": iso(now_utc()), "updated_at": iso(now_utc())})
    previous = await db.season_settings.find_one({"current": True})
    if previous:
        await db.season_settings.update_one({"id": previous["id"]}, {"$set": {"current": False, "updated_at": iso(now_utc())}})
    await db.season_settings.insert_one(doc)
    # Storico modifiche
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(president, "season", doc["id"], "created", {"season_start_year": doc["season_start_year"]}, f"La Presidenza ha creato la nuova stagione {doc['season_start_year']}/{doc['season_start_year'] + 1}")
    # Ritorno
    doc.pop("_id", None)
    doc["season_end_year"] = doc["season_start_year"] + 1
    return doc
