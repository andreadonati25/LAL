from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Optional

from database import db
from models import ReminderIn
from security import optional_user, require_president
from utils import audit, iso, new_id, now_utc, format_diff_message
from routers.notifications import add_notification

router = APIRouter()
ITALY = ZoneInfo("Europe/Rome")

CAMPI_FOLK = {"manager_name", "president_name", "image", "stadium_name", "motto", "organigramma"}

# ---------- Reminders / Scadenze -----------
# Crea un reminder con i seguenti attributi: 
# id, title, description, due_date, team_id, entity, entity_id, kind, created_at, updated_at, done
async def add_reminder(data: ReminderIn):
    # Import
    season = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    # Controlli
    if data.due_date:
        try:
            datetime.fromisoformat(data.due_date.replace("Z", "+00:00"))
        except (ValueError, AttributeError) as e:
            raise HTTPException(400, f"due_date non è una data valida, qui perché {str(e)}")
    if data.team_id:
        team = await db.teams.find_one({"id": data.team_id}, {"_id": 0})
        if not team:
            raise HTTPException(404, "Squadra non trovata")
    if not data.entity_id and data.entity:
        raise HTTPException(400, "Tipo di azione non coerente")
    if data.entity == "team":
        if data.entity_id != data.team_id:
            raise HTTPException(400, "Squadra ricevente e squadra da modificare differenti")
        if data.kind not in ("stadium_works", "capitano_vice", "limite_rosa", *[f"dati_mancanti_{c}" for c in CAMPI_FOLK], *[f"dati_duplicati_{c}" for c in CAMPI_FOLK]):
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind == "stadium_works" and data.stadium_work == 0:
            raise HTTPException(400, "Tipo di azione non coerente")
    if data.entity == "player":
        player = await db.players.find_one({"id": data.entity_id}, {"_id": 0})
        if not player:
            raise HTTPException(404, "Giocatore non trovato")
        if data.kind not in ("auto_release", "contract_signature", "contract_termination", "prestito_secco", "prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo", "numero_maglia_mancante", "numero_maglia_duplicato", "academy_over"):
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.stadium_work != 0:
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind not in ("prestito_secco", "prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo") and data.transfer_id:
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind in ("prestito_secco", "prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo") and not data.transfer_id:
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind in ("auto_release", "contract_signature", "contract_termination", "attivazione_prestito_diritto", "numero_maglia_mancante", "numero_maglia_duplicato", "academy_over") and not data.team_id:
            raise HTTPException(400, "Tipo di azione non coerente")
    if data.entity == "reminder":
        if data.kind not in ("auto_release_prestito",):
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind in ("auto_release_prestito",) and not data.transfer_id:
            raise HTTPException(400, "Tipo di azione non coerente")
        if not data.team_id:
            raise HTTPException(400, "Tipo di azione non coerente")
    if data.entity == "season":
        if data.entity_id != season["id"]:
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.kind != "fine_mese" and data.kind != data.due_date:
            raise HTTPException(400, "Tipo di azione non coerente")
    if data.entity == "transfer":
        if not data.transfer_id:
            raise HTTPException(400, "Tipo di azione non coerente")
        transfer = await db.transfers.find_one({"id": data.transfer_id}, {"_id": 0})
        if not transfer:
            raise HTTPException(404, "Trasferimento non trovato")
        if data.kind not in ("pagamento_trasferimento", "esecuzione_trasferimento", "clausola_libera", "bonus_misurabile"):
            raise HTTPException(400, "Tipo di azione non coerente")
        if data.stadium_work != 0:
            raise HTTPException(400, "Tipo di azione non coerente")
    # Creazione
    doc = data.model_dump()
    doc.update({"id": new_id(), "created_at": iso(now_utc()), "updated_at": iso(now_utc()), "done": False})
    await db.reminders.insert_one(doc)
    # Ritorno
    doc.pop("_id", None)
    return doc

# Modifica di sistema ai reminder: a seguito della scelta o del termine cambia su done = result (di base True, ma teniamoci flessibili).
async def update_reminder(rem_id: str, result: bool):
    # Controlli
    target = await db.reminders.find_one({"id": rem_id})
    if not target:
        raise HTTPException(404, "Reminder non trovato")
    # Modifica
    if result == target.get('done'):
        return target
    await db.reminders.update_one({"id": rem_id}, {"$set": {"updated_at": iso(now_utc()), "done": result}})
    # Ritorno
    r = await db.reminders.find_one({"id": rem_id}, {"_id": 0})
    return r

# Modifica esplicita del presidente: modifica dinamica.
@router.patch("/reminders/{rem_id}")
async def patch_reminder(rem_id: str, patch: dict, editing_enabled: bool, editing_enabled_absolute: bool, president=Depends(require_president)):
    # Controlli
    if not editing_enabled and not editing_enabled_absolute:
        raise HTTPException(400, "Editing non disponibile")
    target = await db.reminders.find_one({"id": rem_id})
    if not target:
        raise HTTPException(404, "Reminder non trovato")
    allowed = {"due_date", "done", "title", "description"} if editing_enabled_absolute else {
        None: {"due_date"},
        "fine_mese": {"due_date"},
        "esecuzione_trasferimento": {"due_date"},
        "stadium_works": {"due_date", "done"},
        "pagamento_trasferimento": {"due_date", "done"},
        "bonus_misurabile": {"due_date", "done"},
        "clausola_libera": {"due_date", "done", "title", "description"},
    }.get(target.get("kind"), set())
    if not allowed:
        raise HTTPException(400, "Questo tipo di reminder non è modificabile")
    if not target.get("kind") and target.get("entity"):
        raise HTTPException(400, "Questo tipo di reminder non è modificabile")
    if any(key not in allowed for key in patch):
        raise HTTPException(400, "Uno o più campi non sono modificabili per questo reminder")
    filtered = dict(patch)
    if not filtered:
        raise HTTPException(400, "Nessuna modifica indicata")
    if "title" in filtered and (filtered["title"] is None or not isinstance(filtered["title"], str)):
        raise HTTPException(status_code=400, detail="Titolo non valido")
    if "description" in filtered and filtered["description"] is not None and not isinstance(filtered["description"], str):
        raise HTTPException(status_code=400, detail="La descrizione deve essere una stringa")
    if "due_date" in filtered:
        if filtered["due_date"] is None or not isinstance(filtered["due_date"], str):
            raise HTTPException(400, "due_date non è una data valida")
        try:
            parsed = datetime.fromisoformat(filtered["due_date"].replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            raise HTTPException(400, "due_date non è una data valida")
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
        if parsed <= now_utc():
            raise HTTPException(400, "due_date deve essere futura")
        filtered["due_date"] = iso(parsed)
    if "done" in filtered and filtered["done"] is not True:
        raise HTTPException(400, "done può essere impostato solo a true per annullare il reminder")

    transfer_cancellation = None
    if filtered.get("done") is True and target.get("kind") in ("bonus_misurabile", "clausola_libera"):
        transfer_id = target.get("transfer_id")
        entity_id = target.get("entity_id")
        if not transfer_id or not entity_id:
            raise HTTPException(400, "Il reminder non è collegato correttamente al trasferimento")
        field = "bonus" if target["kind"] == "bonus_misurabile" else "clausole_libere"
        result = await db.transfers.update_one(
            {"id": transfer_id, f"{field}.id": entity_id},
            {"$set": {f"{field}.$.stato": "annullata", "updated_at": iso(now_utc())}},
        )
        if result.matched_count == 0:
            raise HTTPException(404, "Elemento del trasferimento non trovato")
        transfer_cancellation = (transfer_id, field, entity_id)

    filtered["updated_at"] = iso(now_utc())
    await db.reminders.update_one({"id": rem_id}, {"$set": filtered})
    r = await db.reminders.find_one({"id": rem_id}, {"_id": 0})

    if transfer_cancellation:
        transfer_id, field, entity_id = transfer_cancellation
        item_label = "bonus" if field == "bonus" else "clausola"
        await audit(
            president,
            "transfer",
            transfer_id,
            f"{item_label}_annullata",
            {"entity_id": entity_id},
            f"La Presidenza ha annullato il {item_label} collegato al trasferimento",
        )

    if r.get("done"):
        if r.get("team_id"):
            team = await db.teams.find_one({"id": r.get("team_id")}, {"_id": 0})
            if not team:
                raise HTTPException(404, "Squadra non trovata")
            extra = f"Il presidente ha annullato il reminder {r.get('title')} indirizzato alla società {team.get('name')}"
        else:
            extra = f"Il presidente ha annullato il reminder {r.get('title')} indirizzato a tutte le società"
        await audit(president, "reminders", rem_id, "updated", {}, extra)
    else:
        diff = {k: {"from": target.get(k), "to": r.get(k)} for k in filtered if k != "updated_at" and target.get(k) != r.get(k)}
        diff_str = format_diff_message(diff)
        if diff_str:
            if r.get("team_id"):
                team = await db.teams.find_one({"id": r.get("team_id")}, {"_id": 0})
                if not team:
                    raise HTTPException(404, "Squadra non trovata")
                extra = f"Il presidente ha modificato i dati {diff_str} del reminder {r.get('title')} indirizzato alla società {team.get('name')}"
            else:
                extra = f"Il presidente ha modificato i dati {diff_str} del reminder {r.get('title')} indirizzato a tutte le società"
            await audit(president, "reminders", rem_id, "updated", diff, extra)
    # Notifica agli utenti delle squadre interessate
    if r.get("team_id"):
        users = await db.users.find({"team_id": r.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
    else:
        users = await db.users.find({"role": {"$ne": "presidente"}}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"Reminder dal titolo {r.get('title')} modificato", "/scadenze")
    # Ritorno
    return r

# Eliminazione di un reminder, solo il presidente può farlo.
@router.delete("/reminders/{rem_id}")
async def del_reminder(rem_id: str, president=Depends(require_president)):
    # Controlli
    target = await db.reminders.find_one({"id": rem_id})
    if not target:
        raise HTTPException(404, "Reminder non trovato")
    # Eliminazione
    await db.reminders.delete_one({"id": rem_id})
    # Storico modifiche
    if target.get("team_id"):
        team = await db.teams.find_one({"id": target.get("team_id")}, {"_id": 0})
        if not team:
            raise HTTPException(404, "Squadra non trovata")
        extra = f"Il presidente ha eliminato il reminder {target.get('title')} indirizzato alla società {team.get('name')}"
    else:
        extra = f"Il presidente ha eliminato il reminder {target.get('title')} indirizzato a tutte le società"
    await audit(president, "reminders", rem_id, "deleted", {}, extra)
    # Notifica agli utenti delle squadre interessate
    if target.get("team_id"):
        users = await db.users.find({"team_id": target.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
    else:
        users = await db.users.find({}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"Reminder dal titolo {target.get('title')} eliminato", "/scadenze")
    # Ritorno
    return {"ok": True}

# Lista dei 100 reminder più urgenti in base all'user loggato.
@router.get("/reminders")
async def list_reminders(limit: Optional[int] = None, user=Depends(optional_user)):
    placeholder_date = iso(datetime(1999, 12, 31, tzinfo=ITALY).astimezone(timezone.utc))
    if not user:
        q = {"team_id": None}
        q["due_date"] = {"$nin": [placeholder_date, None]}
    elif user["role"] == "presidente":
        q = {}
    else:
        q = {"$or": [{"team_id": user.get("team_id")}, {"team_id": None}]}
        q["due_date"] = {"$nin": [placeholder_date, None]}
    q["done"] = False
    if limit is not None:
        items = await db.reminders.find(q, {"_id": 0}).sort([
            ("due_date", 1),
            ("created_at", -1),
        ]).limit(limit).to_list(limit)
    else:
        items = await db.reminders.find(q, {"_id": 0}).sort([
            ("due_date", 1),
            ("created_at", -1),
        ]).to_list(limit)
    return items


