from datetime import datetime
import io
from typing import Optional
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pymongo.errors import DuplicateKeyError
import pandas as pd
import calendar

from business import (
    compute_cartellino, compute_effective_salary, compute_contract_end,
    compute_roster_value_current, compute_years_in_team, compute_release_amounts,
    release_player_patch, compute_24_hours, compute_contract_termination_due,
)
from routers.notifications import add_notification
from database import db
from models import PlayerIn, ReminderIn
from security import get_current_user, optional_user, require_president
from utils import audit, iso, new_id, now_utc, is_number, format_diff_message
from routers.reminders import update_reminder, add_reminder
from routers.system import (
    _resolve_expired_prestito_obbligo,
    _resolve_expired_prestito_secco,
    _resolve_expired_prestito_diritto,
    _resolve_expired_esecuzione_trasferimento,
    _crea_transfer_redenzione,
)
from routers.transfers import _cancel_pending_transfers_for_player
from routers.monthly import (
    rimuovi_da_composizione, assegna_a_composizione,
    update_dati_generali_composizione_rosa, correggi_composizione_se_necessaria,
)

router = APIRouter()

# ---------- Players ----------
async def _get_reminder_prestito_e_auto_release(player_id: str):
    reminder_prestito = await db.reminders.find_one({"entity_id": player_id, "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]}})
    if not reminder_prestito:
        raise HTTPException(404, "Reminder del prestito non trovato")
    rem = await db.reminders.find_one({"entity": "reminder", "entity_id": reminder_prestito["id"], "kind": "auto_release_prestito", "done": False})
    if not rem:
        raise HTTPException(400, "Nessuna decisione di prestito in corso per questo giocatore")
    return reminder_prestito, rem

# Ottiene i trasferimenti convalidati con un giocatore coinvolto
async def _get_pending_transfer_movement(player_id: str):
    transfer = await db.transfers.find_one(
        {"status": "convalidato", "movements.player_id": player_id},
        {"_id": 0},
    )
    if not transfer:
        return None
    movement = next((item for item in transfer.get("movements", []) if item.get("player_id") == player_id), None)
    if not movement:
        return None
    reminder_query = {
        "transfer_id": transfer["id"],
        "entity_id": movement["id"],
        "kind": "esecuzione_trasferimento",
    }
    execution_reminder = await db.reminders.find_one({**reminder_query, "done": False}, {"_id": 0})
    if not execution_reminder:
        completed_reminder = await db.reminders.find_one({**reminder_query, "done": True}, {"_id": 0, "id": 1})
        if completed_reminder:
            return None
    return transfer, movement, execution_reminder

# Termina immediatamente il prestito (secco o diritto), invece di aspettare la scadenza naturale
@router.post("/players/{player_id}/prestito/termina")
async def termina_prestito(player_id: str, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    reminder_prestito, rem = await _get_reminder_prestito_e_auto_release(player_id)
    team = await db.teams.find_one({"id": rem.get("team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_current = user.get("team_id") is not None and user.get("team_id") == rem.get("team_id")
    if not is_president and not is_current:
        raise HTTPException(403, "Non autorizzato")
    # Termina il prestito (secco o diritto)
    if reminder_prestito["kind"] == "prestito_secco":
        await _resolve_expired_prestito_secco(reminder_prestito)
    elif reminder_prestito["kind"] == "prestito_diritto":
        await _resolve_expired_prestito_diritto(reminder_prestito)
    else:
        raise Exception(f"Kind {reminder_prestito['kind']} inatteso in auto_release_prestito")
    await update_reminder(reminder_prestito["id"], True)
    await update_reminder(rem["id"], True)
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "prestito_terminato", {}, f"Dopo la decisione sullo svincolo automatico, la Presidenza ha deciso di terminare il prestito di {p.get('name')} alla società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "prestito_terminato", {}, f"Dopo la decisione sullo svincolo automatico, la società {team.get('name')} ha deciso di terminare il prestito di {p.get('name')}")
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": rem.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha terminato il prestito di {p.get('name')}", f"/listone?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Mantiene il prestito: nessuna modifica, prosegue fino alla scadenza naturale
@router.post("/players/{player_id}/prestito/mantieni")
async def mantieni_prestito(player_id: str, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    _, rem = await _get_reminder_prestito_e_auto_release(player_id)
    is_president = user["role"] == "presidente"
    is_current = user.get("team_id") is not None and user.get("team_id") == rem.get("team_id")
    if not is_president and not is_current:
        raise HTTPException(403, "Non autorizzato")
    team = await db.teams.find_one({"id": rem.get("team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    # Scelta di non terminare, ma comunque scelta effettuata
    await update_reminder(rem["id"], True)
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "prestito_mantenuto", {}, f"Dopo la decisione sullo svincolo automatico, la Presidenza ha deciso di mantenere attivo il prestito di {p.get('name')} alla società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "prestito_mantenuto", {}, f"Dopo la decisione sullo svincolo automatico, la società {team.get('name')} ha deciso di mantenere attivo il prestito di {p.get('name')}")
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": rem.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha mantenuto il prestito di {p.get('name')}", f"/squadra/{rem.get('team_id')}?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Non esercita il diritto: come un prestito secco
@router.post("/players/{player_id}/diritto/termina")
async def termina_diritto(player_id: str, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    rem = await db.reminders.find_one({"entity_id": player_id, "kind": "attivazione_prestito_diritto", "done": False})
    if not rem:
        raise HTTPException(400, "Nessuna decisione di riscatto in corso per questo giocatore")
    is_president = user["role"] == "presidente"
    is_current = user.get("team_id") is not None and user.get("team_id") == rem.get("team_id")
    if not is_president and not is_current:
        raise HTTPException(403, "Non autorizzato")
    team = await db.teams.find_one({"id": rem.get("team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    # Risolvi
    await _resolve_expired_prestito_secco(rem)
    await update_reminder(rem["id"], True)
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "prestito_terminato", {}, f"La Presidenza ha deciso di terminare il prestito di {p.get('name')} alla società {team.get('name')} senza esercitare il diritto di riscatto")
    else:
        await audit(user, "player", player_id, "prestito_terminato", {}, f"La società {team.get('name')} ha deciso di terminare il prestito di {p.get('name')} senza esercitare il diritto di riscatto")
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": rem.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha deciso di non esercitare il diritto di riscatto per {p.get('name')}", f"/listone?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Esercita il diritto di riscatto
@router.post("/players/{player_id}/diritto/riscatta")
async def riscatta_diritto(player_id: str, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    rem = await db.reminders.find_one({"entity_id": player_id, "kind": "attivazione_prestito_diritto", "done": False})
    if not rem:
        raise HTTPException(400, "Nessuna decisione di riscatto in corso per questo giocatore")
    is_president = user["role"] == "presidente"
    is_current = user.get("team_id") is not None and user.get("team_id") == rem.get("team_id")
    if not is_president and not is_current:
        raise HTTPException(403, "Non autorizzato")
    # Risolvi
    await _crea_transfer_redenzione(rem, user)
    await update_reminder(rem["id"], True)
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": rem.get("team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha deciso di esercitare il diritto di riscatto per {p.get('name')}", f"/squadra/{rem.get('team_id')}?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Rinnovo di contratto
@router.patch("/players/{player_id}/renewal-contract")
async def renewal_contract(player_id: str, contract_years: int, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == p.get("fanta_team_id")
    if not is_president and not is_owner:
        raise HTTPException(403, "Non puoi rinnovare il contratto per questo giocatore")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    if not p.get("contract_start"):
        raise HTTPException(400, "Il giocatore non può rinnovare un contratto che non ha")
    if contract_years not in {1, 2, 3, 5}:
        raise HTTPException(400, "Errore negli anni di contratto")
    rem = await db.reminders.find_one({"entity_id": player_id, "kind": "contract_termination", "done": False})
    if not rem:
        raise HTTPException(400, f"Reminder contract_termination non trovato per il giocatore {player_id}")
    # Controllo di essere negli ultimi 6 mesi di contratto del giocatore
    years_in_team = compute_years_in_team(p.get("contract_start"))
    if years_in_team < p.get("contract_years"):
        raise HTTPException(400, "Il giocatore non può ancora rinnovare il contratto")
    # Modifica
    patch = {
        "contract_years": contract_years,
        "contract_start": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
    patch["effective_salary"] = compute_effective_salary(p.get("salary"), p.get("renewal_count") + 1)
    await db.players.update_one({"id": player_id}, {"$inc": {"renewal_count": 1}, "$set": patch})
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "contract_renewal", {}, f"La presidenza ha rinnovato il contratto di {p.get('name')} con la società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "contract_renewal", {}, f"La società {team.get('name')} ha rinnovato il contratto di {p.get('name')}")
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    # Cambiamenti reminder
    await db.reminders.update_one({"id": rem["id"]}, {"$set": {"due_date": compute_contract_termination_due(p2.get("contract_end")), "updated_at": iso(now_utc())}})
    # Notifica ai proprietari se il presidente:
    if is_president:
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha rinnovato il contratto del giocatore {p.get('name')} dalla tua rosa", f"/squadra/{p['fanta_team_id']}?player={player_id}")
    # Si è modificato solo lo stipendio
    await update_dati_generali_composizione_rosa(p2.get("fanta_team_id"))
    if p2.get("paying_team_id") != p2.get("fanta_team_id"):
        await update_dati_generali_composizione_rosa(p2.get("paying_team_id"))
    # Ritorno
    return p2

# Firma del (primo) contratto
@router.patch("/players/{player_id}/sign-contract")
async def sign_contract(player_id: str, contract_years: int, jersey_number: int, user=Depends(get_current_user)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == p.get("fanta_team_id")
    if not is_president and not is_owner:
        raise HTTPException(403, "Non puoi firmare il contratto per questo giocatore")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    if p.get("contract_start"):
        raise HTTPException(400, "Il giocatore non deve firmare un contratto")
    if contract_years not in {1, 2, 3, 5}:
        raise HTTPException(400, "Errore negli anni di contratto")
    if p.get("tier") != "academy":
        rem = await db.reminders.find_one({"entity_id": player_id, "kind": "contract_signature", "done": False})
        if not rem:
            raise HTTPException(400, f"Reminder contract_signature non trovato per il giocatore {player_id}")
    # Modifica
    patch = {
        "jersey_number": jersey_number,
        "renewal_count": 0,
        "contract_years": contract_years,
        "contract_start": iso(now_utc()),
        "first_contract_start": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    if p.get("tier") == "academy":
        if p.get("real_club") in SQUADRE_SERIE_A:
            patch["tier"] = "utilizzabile"
        else:
            patch["tier"] = "altrove"
        rem_academy = await db.reminders.find_one({"entity_id": player_id, "kind": "academy_over", "done": False})
        if rem_academy:
            await update_reminder(rem_academy["id"], True)
    patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
    patch["effective_salary"] = compute_effective_salary(p.get("salary"), patch["renewal_count"])
    await db.players.update_one({"id": player_id}, {"$set": patch})
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "signed_first_contract", {}, f"La presidenza ha firmato il primo contratto di {p.get('name')} con la società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "signed_first_contract", {}, f"La società {team.get('name')} ha firmato il primo contratto di {p.get('name')}")
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    # Cambiamenti reminder
    if p.get("tier") != "academy":
        await update_reminder(rem["id"], True)
    new_reminder = {
        "title": "Scadenza rinnovo",
        "description": f"Ultimo momento per rinnovare il contratto di {p2['name']}",
        "due_date": compute_contract_termination_due(p2["contract_end"]),
        "team_id": p2["fanta_team_id"],
        "entity": "player",
        "entity_id": p2["id"],
        "kind": "contract_termination",
        "stadium_work": 0}
    try:
        await add_reminder(ReminderIn(**new_reminder))
    except DuplicateKeyError:
        pass
    except Exception as e:
        await audit(user, "reminders", p2["id"], "add_reminder_failed", {"error": str(e)}, f"Errore nella creazione di un reminder contract_termination: {str(e)}")
    # Ricalcolo roster_current_value se arriva dall'academy
    if p.get("tier") == "academy":
        tid = p2.get("fanta_team_id")
        new_rvc = await compute_roster_value_current(tid)
        await db.teams.update_one({"id": tid}, {"$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
    # Notifica ai proprietari se il presidente:
    if is_president:
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha firmato il primo contratto del giocatore {p.get('name')} dalla tua rosa", f"/squadra/{p['fanta_team_id']}?player={player_id}")
    # Aggiornamento composizione rosa solo se viene dall'academy e cambia dati.
    if p.get("tier") == "academy":
        await rimuovi_da_composizione(p2.get("fanta_team_id"), player_id, SEASON)
        await assegna_a_composizione(p2.get("fanta_team_id"), player_id, SEASON)
    await update_dati_generali_composizione_rosa(p2.get("fanta_team_id"))
    # Ritorno
    return p2

# Mantenimento in rosa post proposta di svincolo automatico
@router.post("/players/{player_id}/keep-in-squad")
async def keep_in_squad(player_id: str, user=Depends(get_current_user)):
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    rem = await db.reminders.find_one({"entity_id": p.get("id"), "kind": "auto_release", "done": False}, {"_id": 0, "id": 1})
    if not rem:
        raise HTTPException(400, "Nessuna proposta di svincolo automatico in corso per questo giocatore")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == p.get("fanta_team_id")
    is_current = user.get("team_id") is not None and user.get("team_id") == p.get("current_team_id")
    # Se il giocatore non ha un proprietario, vuol dire che siamo nel caso di un prestito senza obbligo di un giocatore svincolato deliberatamente
    if not p.get("fanta_team_id"):
        if not is_president and not is_current:
            raise HTTPException(403, "Non autorizzato")
        team_dete = await db.teams.find_one({"id": p.get("current_team_id")})
        if not team_dete:
            raise HTTPException(404, "Squadra non trovata")
        patch = {"fantavalore": 1}
        patch["cartellino"] = compute_cartellino(p.get("transfermarkt_value"), patch["fantavalore"])
        patch["updated_at"] = iso(now_utc())
        await db.players.update_one({"id": player_id}, {"$set": patch})
        # Storico Modifiche
        if is_president:
            await audit(user, "player", player_id, "kept_in_squad", {}, f"La presidenza ha mantenuto in rosa {p.get('name')} in nome della società {team_dete.get('name')}")
        else:
            await audit(user, "player", player_id, "kept_in_squad", {}, f"La società {team_dete.get('name')} ha mantenuto in rosa {p.get('name')}")
        # Modifica del reminder:
        await update_reminder(rem["id"], True)
        # Se è stato il presidente, notifica al proprietario:
        if is_president:
            users = await db.users.find({"team_id": p["current_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"La Presidenza ha mantenuto in rosa il giocatore in prestito {p.get('name')}", f"/squadra/{p['current_team_id']}?player={player_id}")
        # Ritorno
        p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
        return p2
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    if p.get("current_team_id") != p.get("fanta_team_id"):
        reminder_prestito = await db.reminders.find_one({"entity_id": p.get("id"), "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]}})
        if not reminder_prestito:
            raise HTTPException(404, "Reminder del prestito non trovato")
        # Crea il reminder per mantenimento o termine prestito.
        new_reminder = {
            "title": f"Svincolo automatico {p['name']} in prestito",
            "description": "Scegli tra mantenere il prestito a scadenza o interromperlo immediatamente.",
            "due_date": iso(now_utc()),
            "team_id": p["current_team_id"],
            "entity": "reminder",
            "entity_id": reminder_prestito["id"],
            "kind": "auto_release_prestito",
            "stadium_work": 0,
            "transfer_id": reminder_prestito["transfer_id"]}
        try:
            await add_reminder(ReminderIn(**new_reminder))
        except DuplicateKeyError:
            pass
        # Creazione notifica
        users = await db.users.find({"team_id": p.get("current_team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"Il proprietario ha mantenuto il giocatore {p.get('name')}, devi decidere sul futuro del prestito", f"/squadra/{p.get('current_team_id')}?player={player_id}")
    # Al termine del processo di svincolo automatico, fantavalore = 1
    patch = {"fantavalore": 1}
    patch["cartellino"] = compute_cartellino(p.get("transfermarkt_value"), patch["fantavalore"])
    patch["updated_at"] = iso(now_utc())
    await db.players.update_one({"id": player_id}, {"$set": patch})
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "kept_in_squad", {}, f"La presidenza ha mantenuto in rosa {p.get('name')} in nome della società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "kept_in_squad", {}, f"La società {team.get('name')} ha mantenuto in rosa {p.get('name')}")
    # Modifica del reminder:
    await update_reminder(rem["id"], True)
    # Se è stato il presidente, notifica al proprietario:
    if is_president:
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha mantenuto in rosa il giocatore {p.get('name')}", f"/squadra/{p['fanta_team_id']}?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Svincolo automatico accettato
@router.post("/players/{player_id}/accept-auto-release")
async def accept_auto_release(player_id: str, user=Depends(get_current_user)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    rem = await db.reminders.find_one({"entity_id": p.get("id"), "kind": "auto_release", "done": False}, {"_id": 0, "id": 1})
    if not rem:
        raise HTTPException(400, "Nessuna proposta di svincolo automatico in corso per questo giocatore")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == p.get("fanta_team_id")
    is_current = user.get("team_id") is not None and user.get("team_id") == p.get("current_team_id")
    # Se il giocatore non ha un proprietario, vuol dire che siamo nel caso di un prestito senza obbligo di un giocatore svincolato deliberatamente
    if not p.get("fanta_team_id"):
        if not is_president and not is_current:
            raise HTTPException(403, "Non autorizzato")
        team_dete = await db.teams.find_one({"id": p.get("current_team_id")})
        if not team_dete:
            raise HTTPException(404, "Squadra non trovata")
        await _cancel_pending_transfers_for_player(player_id, user)
        # Svincolo
        patch = release_player_patch(False)
        patch["fantavalore"] = 1
        patch["cartellino"] = compute_cartellino(p.get("transfermarkt_value"), patch["fantavalore"])
        patch["updated_at"] = iso(now_utc())
        await db.players.update_one({"id": player_id}, {"$set": patch})
        # Storico Modifiche
        if is_president:
            await audit(user, "player", player_id, "auto_release_accepted", {}, f"La presidenza ha accettato lo svincolo automatico per {p.get('name')} in nome della società {team_dete.get('name')}")
        else:
            await audit(user, "player", player_id, "auto_release_accepted", {}, f"La società {team_dete.get('name')} ha accettato lo svincolo automatico per {p.get('name')}")
        # Terminiamo il reminder del prestito
        reminder_prestito = await db.reminders.find_one({"entity_id": p.get("id"), "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto"]}})
        if not reminder_prestito:
            raise HTTPException(404, "Reminder del prestito non trovato")
        if reminder_prestito.get("kind") == "prestito_secco":
            await _resolve_expired_prestito_secco(reminder_prestito)
        if reminder_prestito.get("kind") == "prestito_diritto":
            await _resolve_expired_prestito_diritto(reminder_prestito)
        await update_reminder(reminder_prestito["id"], True)
        # Se è stato il presidente, notifica:
        if is_president:
            users = await db.users.find({"team_id": p.get("current_team_id")}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"La Presidenza ha svincolato il giocatore {p.get('name')} dalla tua rosa", f"/listone?player={player_id}")
        # Aggiornamento composizione rosa: giocatore esce dalla composizione e cambia stipendio
        await rimuovi_da_composizione(p.get("current_team_id"), player_id, SEASON)
        await update_dati_generali_composizione_rosa(p.get("current_team_id"))
        # Ritorno
        p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
        return p2
    if not is_president and not is_owner:
            raise HTTPException(403, "Non autorizzato")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    # Parte economica
    cartellino = p.get("cartellino")
    transfermarkt_value = p.get("transfermarkt_value")
    valore_base_ridotto = 0.9 * cartellino
    porzione_attuale, porzione_30_06, porzione_utili = compute_release_amounts(transfermarkt_value, valore_base_ridotto)
    # Svincolo
    patch = release_player_patch(False)
    # Se il giocatore è in prestito, ormai è un prestito secco o con diritto:
    if p.get("current_team_id") != p.get("fanta_team_id"):
        reminder_prestito = await db.reminders.find_one({"entity_id": p.get("id"), "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]}})
        if not reminder_prestito:
            raise HTTPException(404, "Reminder del prestito non trovato")
        # Crea il reminder per mantenimento o termine prestito.
        new_reminder = {
            "title": f"Svincolo automatico {p['name']} in prestito",
            "description": "Scegli tra mantenere il prestito a scadenza o interromperlo immediatamente.",
            "due_date": iso(now_utc()),
            "team_id": p["current_team_id"],
            "entity": "reminder",
            "entity_id": reminder_prestito["id"],
            "kind": "auto_release_prestito",
            "stadium_work": 0,
            "transfer_id": reminder_prestito["transfer_id"]}
        try:
            await add_reminder(ReminderIn(**new_reminder))
        except DuplicateKeyError:
            pass
        # Creazione notifica
        users = await db.users.find({"team_id": p.get("current_team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"Il proprietario ha svincolato il giocatore {p.get('name')}, devi decidere sul futuro del prestito", f"/squadra/{p.get('current_team_id')}?player={player_id}")
        # Per ora non modifichiamo alcune cose:
        patch["current_team_id"] = p.get("current_team_id")
        patch["jersey_number"] = p.get("jersey_number")
        if p.get("paying_team_id") == p.get("current_team_id"):
            patch["paying_team_id"] = p.get("paying_team_id")
    # Al termine del processo di svincolo automatico, fantavalore = 1
    patch["fantavalore"] = 1
    patch["cartellino"] = compute_cartellino(p.get("transfermarkt_value"), patch["fantavalore"])
    patch["effective_salary"] = compute_effective_salary(p.get("salary"), patch["renewal_count"])
    patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
    patch["updated_at"] = iso(now_utc())
    await _cancel_pending_transfers_for_player(player_id, user)
    await db.players.update_one({"id": player_id}, {"$set": patch})
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "auto_release_accepted", {}, f"La presidenza ha accettato lo svincolo automatico per {p.get('name')} in nome della società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "auto_release_accepted", {}, f"La società {team.get('name')} ha accettato lo svincolo automatico per {p.get('name')}")
    # Modifica dei reminder:
    await update_reminder(rem["id"], True)
    rem_contract = await db.reminders.find_one({"entity_id": p.get("id"), "kind": "contract_termination", "done": False}, {"_id": 0, "id": 1})
    if rem_contract:
        await update_reminder(rem_contract["id"], True)
    # Rimozione reminder informativi sul numero
    r_dup = await db.reminders.find_one({"entity_id": player_id, "kind": "numero_maglia_duplicato", "done": False})
    if r_dup:
        await update_reminder(r_dup["id"], True)
    r_man = await db.reminders.find_one({"entity_id": player_id, "kind": "numero_maglia_mancante", "done": False})
    if r_man:
        await update_reminder(r_man["id"], True)
    # Modifica della squadra se c'è parte economica:
    new_rvc = await compute_roster_value_current(p.get("fanta_team_id"))
    await db.teams.update_one({"id": p.get("fanta_team_id")},
        {"$inc": {
            "bdg_trasferimenti": porzione_attuale * 1000000,
            "bdgt_dilazionato_30giu": porzione_30_06 * 1000000,
            "utili.mercato": porzione_utili * 1000000,
        }, "$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
    # Se è stato il presidente, notifica all'ex proprietario:
    if is_president:
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha svincolato il giocatore {p.get('name')} dalla tua rosa", f"/listone?player={player_id}")
    # Aggiornamento composizione rosa: giocatore esce dalla composizione del proprietario e cambia dati, inoltre cambia stipendio
    await rimuovi_da_composizione(p.get("fanta_team_id"), player_id, SEASON)
    await update_dati_generali_composizione_rosa(p.get("fanta_team_id"))
    if p.get("paying_team_id") != p.get("fanta_team_id"):
        await update_dati_generali_composizione_rosa(p.get("paying_team_id"))
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Inizio procedura svincolo automatico da parte del presidente 
# (4 casi: fanta=current=None, fanta=current!=None, fanta!=current!=None, fanta=None e current!=None)
@router.post("/players/{player_id}/propose-auto-release")
async def propose_auto_release(player_id: str, new_real_club: str, president=Depends(require_president)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    if p.get("tier") == "academy":
        raise HTTPException(400, "Lo svincolo automatico non si applica ai giocatori in academy")
    # Se c'è una proposta di svincolo automatico, non si può fare ancora
    if await db.reminders.find_one({"entity_id": p.get("id"), "kind": "auto_release", "done": False}, {"_id": 0, "id": 1}):
        raise HTTPException(400, "È già in corso una proposta di svincolo automatico per questo giocatore")
    if new_real_club.title() in SQUADRE_SERIE_A:
        raise HTTPException(400, "Il nuovo club è in Serie A")
    if p.get("real_club") not in SQUADRE_SERIE_A:
        raise HTTPException(400, "Il giocatore è già fuori dalla Serie A")
    if p.get("fanta_team_id"):
        team = await db.teams.find_one({"id": p.get("fanta_team_id")})
        if not team:
            raise HTTPException(404, "Squadra non trovata")
    if p.get("current_team_id"):
        team_dete = await db.teams.find_one({"id": p.get("current_team_id")})
        if not team_dete:
            raise HTTPException(404, "Squadra non trovata")
    reminder_prestito = None
    if p.get("fanta_team_id") != p.get("current_team_id"):
        reminder_prestito = await db.reminders.find_one({
            "entity_id": p.get("id"),
            "done": False,
            "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]},
        })
        if not reminder_prestito:
            raise HTTPException(404, "Reminder del prestito non trovato")
    pending_transfer = await _get_pending_transfer_movement(player_id)
    if pending_transfer:
        transfer, movement, execution_reminder = pending_transfer
        if not execution_reminder:
            raise HTTPException(400, "Il trasferimento convalidato non ha un reminder di esecuzione attivo")
        await _resolve_expired_esecuzione_trasferimento(execution_reminder)
        await update_reminder(execution_reminder["id"], True)
        p = await db.players.find_one({"id": player_id})
        if not p:
            raise HTTPException(404, "Giocatore non trovato dopo l'esecuzione del trasferimento")
        if p.get("fanta_team_id"):
            team = await db.teams.find_one({"id": p.get("fanta_team_id")})
            if not team:
                raise HTTPException(404, "Nuova squadra proprietaria non trovata")
        if p.get("current_team_id"):
            team_dete = await db.teams.find_one({"id": p.get("current_team_id")})
            if not team_dete:
                raise HTTPException(404, "Squadra detentrice non trovata")
    # Se il giocatore è in prestito:
    if p.get("fanta_team_id") != p.get("current_team_id"):
        if reminder_prestito is None:
            reminder_prestito = await db.reminders.find_one({"entity_id": p.get("id"), "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]}})
            if not reminder_prestito:
                raise HTTPException(404, "Reminder del prestito non trovato")
        # current_team_id risponde dello svincolo automatico se c'è l'obbligo (diventando il proprietario) o se non c'è un proprietario.
        if reminder_prestito.get("kind") == "prestito_obbligo" or not p.get("fanta_team_id"):
            if reminder_prestito.get("kind") == "prestito_obbligo":
                await _resolve_expired_prestito_obbligo(reminder_prestito) # Questo fa sì che il giocatore sia ora di proprietà di p.["current_team_id"]
            # Crea il reminder per la squadra corrente.
            new_reminder = {
                "title": f"Svincolo automatico {p['name']}",
                "description": f"{team_dete.get('name')} scegli tra svincolo automatico e mantenimento in rosa entro la scadenza.",
                "due_date": compute_24_hours(iso(now_utc())),
                "team_id": p["current_team_id"],
                "entity": "player",
                "entity_id": p["id"],
                "kind": "auto_release",
                "stadium_work": 0}
            try:
                await add_reminder(ReminderIn(**new_reminder))
            except DuplicateKeyError:
                pass
            # Manda la notifica alla squadra corrente
            users = await db.users.find({"team_id": team_dete["id"]}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"La Presidenza ha iniziato il processo di svincolo automatico di {p.get('name')}", f"/squadra/{team_dete['id']}?player={player_id}")
            # Modifica giocatore [FANTAVALORE = 1 SOLO DOPO IL MANTENIMENTO]
            patch = {"tier": "altrove", "real_club": new_real_club.title(), "updated_at": iso(now_utc())}
            await db.players.update_one({"id": player_id}, {"$set": patch})
            # Aggiornamento composizione rosa: così si sposta in "estero" - non cambiano valori e stipendi
            await rimuovi_da_composizione(p.get("current_team_id"), player_id, SEASON)
            await assegna_a_composizione(p.get("current_team_id"), player_id, SEASON)
            # Storico Modifiche
            await audit(president, "player", player_id, "auto_release_proposed", {}, f"La Presidenza ha mandato la richiesta di svincolo automatico per il giocatore {p.get('name')} alla società {team_dete.get('name')}")
            # Ritorno
            p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
            return p2
    # Se il giocatore è svincolato il processo termina subito.
    if not p.get("fanta_team_id"):
        await _cancel_pending_transfers_for_player(player_id, president)
        patch = {"tier": "altrove", "fantavalore": 1, "real_club": new_real_club.title(), "updated_at": iso(now_utc())}
        patch["cartellino"] = compute_cartellino(p.get("transfermarkt_value"), patch["fantavalore"])
        await db.players.update_one({"id": player_id}, {"$set": patch})
        # Storico Modifiche
        await audit(president, "player", player_id, "auto_release", {}, f"La Presidenza ha spostato fuori dalla Serie A il giocatore svincolato {p.get('name')}")
        # Ritorno
        p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
        return p2
    # In tutti gli altri casi: non in prestito o in prestito senza obbligo con ancora una squadra proprietaria
    # Crea il reminder
    new_reminder = {
        "title": f"Svincolo automatico {p['name']}",
        "description": "Scegli tra svincolo automatico e mantenimento in rosa entro la scadenza.",
        "due_date": compute_24_hours(iso(now_utc())),
        "team_id": p["fanta_team_id"],
        "entity": "player",
        "entity_id": p["id"],
        "kind": "auto_release",
        "stadium_work": 0}
    try:
        await add_reminder(ReminderIn(**new_reminder))
    except DuplicateKeyError:
        pass
    # Manda la notifica
    users = await db.users.find({"team_id": team["id"]}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"La Presidenza ha iniziato il processo di svincolo automatico di {p.get('name')}", f"/squadra/{team['id']}?player={player_id}")
    # Modifica giocatore [FANTAVALORE = 1 SOLO DOPO IL MANTENIMENTO]
    patch = {"tier": "altrove", "real_club": new_real_club.title(), "updated_at": iso(now_utc())}
    await db.players.update_one({"id": player_id}, {"$set": patch})
    # Storico Modifiche
    await audit(president, "player", player_id, "auto_release_proposed", {}, f"La Presidenza ha mandato la richiesta di svincolo automatico per il giocatore {p.get('name')} alla società {team.get('name')}")
     # Aggiornamento composizione rosa: così si sposta in "estero" - non cambiano valori e stipendi
    await rimuovi_da_composizione(p.get("fanta_team_id"), player_id, SEASON)
    await assegna_a_composizione(p.get("fanta_team_id"), player_id, SEASON)
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Svincola deliberatamente un giocatore, solo il presidente o il proprietario possono farlo.
@router.patch("/players/{player_id}/release")
async def release_player(player_id: str, user=Depends(get_current_user)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == p.get("fanta_team_id")
    if not is_president and not is_owner:
        raise HTTPException(403, "Non puoi svincolare questo giocatore")
    if await _get_pending_transfer_movement(player_id):
        raise HTTPException(400, "Non puoi svincolare deliberatamente un giocatore con un trasferimento convalidato non ancora eseguito")
    if not p.get("fanta_team_id"):
        raise HTTPException(400, "Il giocatore è già svincolato")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    # Se il numero di giocatori di proprietà è 25, non si può fare:
    team_players_count = await db.players.count_documents({"fanta_team_id": team["id"], "tier": {"$ne": "academy"}})
    if team_players_count <= 25:
        raise HTTPException(400, "Non puoi scendere sotto i 25 giocatori deliberatamente")
    # Se c'è una proposta di svincolo automatico, non si può svincolare deliberatamente
    if await db.reminders.find_one({"entity_id": p.get("id"), "kind": "auto_release", "done": False}, {"_id": 0, "id": 1}):
        raise HTTPException(400, "C'è una proposta di svincolo automatico in corso per questo giocatore")
    # Calcolo della parte economica se non academy
    if p.get("tier") != "academy":
        years_in_team = min(compute_years_in_team(p.get("contract_start")), p.get("contract_years"))
        if not years_in_team:
            raise HTTPException(400, "Non puoi svincolare: deve passare almeno un mese dall'inizio del contratto")
        contract_years = p.get("contract_years")
        if not contract_years:
            raise HTTPException(400, "Il giocatore non ha anni di contratto validi")
        # Calcolo parte economica svincolo:
        cartellino = p.get("cartellino")
        transfermarkt_value = p.get("transfermarkt_value")
        valore_base_ridotto = 0.9 * cartellino * years_in_team / contract_years
        porzione_attuale, porzione_30_06, porzione_utili = compute_release_amounts(transfermarkt_value, valore_base_ridotto)
    # Svincolo
    serie_a = p.get("real_club") in SQUADRE_SERIE_A
    patch = release_player_patch(serie_a)
    # In caso di prestito non modifichiamo current, jersey e paying se paying = current
    if p.get("fanta_team_id") != p.get("current_team_id"):
        patch["current_team_id"] = p.get("current_team_id")
        patch["jersey_number"] = p.get("jersey_number")
        if p.get("paying_team_id") == p.get("current_team_id"):
            patch["paying_team_id"] = p.get("paying_team_id")
    # Non serve compute_cartellino (né transfermarkt_value né fantavalore modificati)
    patch["effective_salary"] = compute_effective_salary(p.get("salary"), patch["renewal_count"])
    patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
    patch["updated_at"] = iso(now_utc())
    await _cancel_pending_transfers_for_player(player_id, user)
    await db.players.update_one({"id": player_id}, {"$set": patch})
    # Storico Modifiche
    if is_president:
        await audit(user, "player", player_id, "released", {}, f"La Presidenza ha svincolato deliberatamente il giocatore {p.get('name')} dalla società {team.get('name')}")
    else:
        await audit(user, "player", player_id, "released", {}, f"La società {team.get('name')} ha svincolato deliberatamente il giocatore {p.get('name')}")
    # Modifica della squadra e modifica reminder contract_termination:
    if p.get("tier") != "academy":
        new_rvc = await compute_roster_value_current(p.get("fanta_team_id"))
        await db.teams.update_one({"id": p.get("fanta_team_id")},
            {"$inc": {
                "bdg_trasferimenti": porzione_attuale * 1000000,
                "bdgt_dilazionato_30giu": porzione_30_06 * 1000000,
                "utili.mercato": porzione_utili * 1000000,
            }, "$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
        rem = await db.reminders.find_one({"entity_id": p.get("id"), "kind": "contract_termination", "done": False})
        if not rem:
            raise HTTPException(status_code=404, detail="reminder contract_termination non trovato")
        await update_reminder(rem["id"], True)
    else:
        rem_academy = await db.reminders.find_one({"entity_id": player_id, "kind": "academy_over", "done": False})
        if rem_academy:
            await update_reminder(rem_academy["id"], True)
    # Aggiornamento composizione rosa: il giocatore esce dalla squadra proprietaria
    await rimuovi_da_composizione(p.get("fanta_team_id"), player_id, SEASON)
    # Cambiati roster_value_current e (forse) spesa stipendi
    await update_dati_generali_composizione_rosa(p.get("fanta_team_id"))
    # Rimozione reminder informativi sul numero
    r_dup = await db.reminders.find_one({"entity_id": player_id, "kind": "numero_maglia_duplicato", "done": False})
    if r_dup:
        await update_reminder(r_dup["id"], True)
    r_man = await db.reminders.find_one({"entity_id": player_id, "kind": "numero_maglia_mancante", "done": False})
    if r_man:
        await update_reminder(r_man["id"], True)
    # Se è stato il presidente, notifica all'ex proprietario:
    if is_president:
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha svincolato il giocatore {p.get('name')} dalla tua rosa", f"/listone?player={player_id}")
    # Se era in prestito, notifica alla squadra corrente:
    if p.get("fanta_team_id") != p.get("current_team_id"):
        team_curr = await db.teams.find_one({"id": p.get("current_team_id")})
        if team_curr:
            users = await db.users.find({"team_id": team_curr["id"]}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"Il giocatore {p.get('name')} in prestito alla tua squadra è stato svincolato", f"/squadra/{team_curr['id']}?player={player_id}")
    # Ritorno
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    return p2

# Ottieni un giocatore singolo
@router.get("/players/{player_id}")
async def get_player(player_id: str, user=Depends(optional_user)):
    player = await db.players.find_one({"id": player_id}, {"_id": 0})
    return player

# Ottieni i giocatori con filtro sul numero, sulla squadra di proprietà.
@router.get("/players")
async def list_players(limit: Optional[int] = None, fanta_team_id: Optional[str] = None, user=Depends(optional_user)):
    q = {}
    if fanta_team_id:
        q["fanta_team_id"] = fanta_team_id
    pipeline = [
        {"$match": q},
        {"$addFields": {"_role_order": {"$indexOfArray": [["P", "D", "C", "A"], "$role"]}}},
        {"$lookup": {"from": "teams", "localField": "fanta_team_id", "foreignField": "id", "as": "_team"}},
        {"$unwind": {"path": "$_team", "preserveNullAndEmptyArrays": True}},
        {"$sort": {"_team.name": 1, "_role_order": 1, "cartellino": -1, "birth_year": -1}},
        {"$project": {"_id": 0, "_role_order": 0, "_team": 0}},
    ]
    cursor = db.players.aggregate(pipeline)
    if limit is not None:
        cursor = cursor.limit(limit)
    players = await cursor.to_list(limit)
    return players

# Modifica diretta di un giocatore, può farlo solo il presidente nei campi:
# name, birth_year, image, role, real_club, salary, transfermarkt_value, fantavalore, jersey_number
@router.patch("/players/{player_id}")
async def patch_player(player_id: str, patch: dict, president=Depends(require_president)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    allowed = {"name", "birth_year", "image", "role", "real_club", "salary", "transfermarkt_value", "fantavalore", "jersey_number"}
    filtered = {k: v for k, v in patch.items() if k in allowed}
    if "name" in filtered:
        if not isinstance(filtered["name"], str) or not filtered["name"]:
            raise HTTPException(status_code=400, detail="Nome non valido")
        filtered["name"] = filtered["name"].upper()
    if "birth_year" in filtered:
        v = filtered["birth_year"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise HTTPException(status_code=400, detail="Anno di nascita non valido")
        if v < 1950:
            raise HTTPException(status_code=400, detail="Anno di nascita non utilizzabile")
    if "name" in filtered or "birth_year" in filtered:
        result_name = filtered.get("name", p.get("name"))
        result_birth_year = filtered.get("birth_year", p.get("birth_year"))
        dup = await db.players.find_one({"name": result_name, "birth_year": result_birth_year, "id": {"$ne": player_id}})
        if dup:
            raise HTTPException(status_code=400, detail="Nome già utilizzato per un giocatore di quell'anno di nascita")
    if "image" in filtered and filtered["image"] is not None and not isinstance(filtered["image"], str):
        raise HTTPException(status_code=400, detail="image deve essere una stringa")
    if "role" in filtered and filtered["role"] not in {"P", "D", "C", "A"}:
        raise HTTPException(status_code=400, detail="Ruolo non valido")
    if "real_club" in filtered:
        if not isinstance(filtered["real_club"], str) or not filtered["real_club"]:
            raise HTTPException(status_code=400, detail="real_club non valido")
        filtered["real_club"] = filtered["real_club"].title()
        if filtered["real_club"] not in SQUADRE_SERIE_A and p.get("real_club") in SQUADRE_SERIE_A:
            raise HTTPException(status_code=400, detail="Utilizza l'apposito processo di svincolo automatico")
        if filtered["real_club"] in SQUADRE_SERIE_A and p.get("real_club") not in SQUADRE_SERIE_A and p.get("tier") == "altrove":
            filtered["tier"] = "utilizzabile"
    for f in {"salary", "transfermarkt_value"} & filtered.keys():
        if not is_number(filtered[f]):
            raise HTTPException(status_code=400, detail=f"{f} non valido")
        if filtered[f] < 0:
            raise HTTPException(status_code=400, detail=f"{f} deve essere maggiore di 0")
        if f == "transfermarkt_value" and filtered[f] == 0:
            raise HTTPException(status_code=400, detail=f"{f} deve essere maggiore di 0")
        filtered[f] = round(filtered[f], 1)
    if "fantavalore" in filtered:
        v = filtered["fantavalore"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise HTTPException(status_code=400, detail="FantaValore non valido")
        if v < 1:
            raise HTTPException(status_code=400, detail="FantaValore non utilizzabile")
    if "jersey_number" in filtered:
        v = filtered["jersey_number"]
        if v is not None and (not isinstance(v, int) or isinstance(v, bool)):
            raise HTTPException(status_code=400, detail="Numero di maglia non valido")
        if p.get("fanta_team_id") is None or p.get("tier") == "academy":
            if v is not None:
                raise HTTPException(status_code=400, detail="Numero di maglia non valido")
    # Modifica
    if "transfermarkt_value" in filtered or "fantavalore" in filtered:
        tm = filtered.get("transfermarkt_value", p.get("transfermarkt_value"))
        fv = filtered.get("fantavalore", p.get("fantavalore"))
        filtered["cartellino"] = compute_cartellino(tm, fv)
    if "salary" in filtered or "renewal_count" in filtered:
        sa = filtered.get("salary", p.get("salary"))
        re = filtered.get("renewal_count", p.get("renewal_count"))
        filtered["effective_salary"] = compute_effective_salary(sa, re)
    # Non serve compute_contract_end (né contract_start né contract_years modificati)
    if not filtered:
        return p
    filtered["updated_at"] = iso(now_utc())
    await db.players.update_one({"id": player_id}, {"$set": filtered})
    # Storico Modifiche
    p2 = await db.players.find_one({"id": player_id}, {"_id": 0})
    diff = {k: {"from": p.get(k), "to": p2.get(k)} for k in filtered if k != "updated_at" and p.get(k) != p2.get(k)}
    diff_str = format_diff_message(diff)
    if diff_str != False:
        await audit(president, "player", player_id, "updated", diff, f"La Presidenza ha modificato i dati {diff_str} del giocatore {p2.get('name')}")
    # Ricalcolo roster_current_value e notifica ai proprietari
    if p2.get("fanta_team_id"):
        team_fanta = await db.teams.find_one({"id": p2.get("fanta_team_id")})
        if team_fanta:
            new_rvc = await compute_roster_value_current(team_fanta["id"])
            await db.teams.update_one({"id": team_fanta["id"]}, {"$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
            users = await db.users.find({"team_id": team_fanta["id"]}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"La Presidenza ha modificato il giocatore {p2.get('name')} della tua squadra", f"/squadra/{team_fanta['id']}?player={player_id}")
    # Manda una notifica alla fantasquadra se è in prestito
    if p2.get("fanta_team_id") != p2.get("current_team_id"):
        team_curr = await db.teams.find_one({"id": p2.get("current_team_id")})
        if team_curr:
            users = await db.users.find({"team_id": team_curr["id"]}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], f"La Presidenza ha modificato il giocatore {p2.get('name')} in prestito nella tua squadra", f"/squadra/{team_curr['id']}?player={player_id}")
    if p2.get("current_team_id"):
        # Se cambia real_club da fuori a dentro Serie A: "estero" non è più la sezione corretta, va riassegnato
        if p2.get("real_club") in SQUADRE_SERIE_A and p.get("real_club") not in SQUADRE_SERIE_A:
            await rimuovi_da_composizione(p2.get("current_team_id"), player_id, SEASON)
            await assegna_a_composizione(p2.get("current_team_id"), player_id, SEASON)
        # Se cambia birth_year o role: corregge solo se la scelta esistente non rispetta più le regole
        if p2.get("birth_year") != p.get("birth_year") or p2.get("role") != p.get("role"):
            await correggi_composizione_se_necessaria(player_id, SEASON)
    # Aggiornamento aggregati (spesa stipendi/valore/capitano) - dopo le eventuali correzioni alle liste
    await update_dati_generali_composizione_rosa(p2.get("fanta_team_id"))
    if p2.get("current_team_id") != p2.get("fanta_team_id"):
        await update_dati_generali_composizione_rosa(p2.get("current_team_id"))
    # Ritorno
    return p2

# Elimina un giocatore, solo il presidente può farlo.
@router.delete("/players/{player_id}")
async def delete_player(player_id: str, president=Depends(require_president)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": player_id})
    if not p:
        raise HTTPException(404, "Giocatore non trovato")
    # Eliminazione
    await db.players.delete_one({"id": player_id})
    # Storico modifiche
    await audit(president, "player", player_id, "deleted", {"name": p.get("name")}, f"La Presidenza ha eliminato il giocatore {p.get('name')}")
    # Ricalcolo roster_current_value della squadra
    t = await db.teams.find_one({"id": p["fanta_team_id"]})
    if t:
        new_rvc = await compute_roster_value_current(t["id"])
        await db.teams.update_one({"id": t["id"]}, {"$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
        # Manda una notifica ai proprietari di quella squadra
        users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha eliminato il giocatore {p.get('name')} della tua squadra", f"/squadra/{p['fanta_team_id']}")
    # Elimina tutti i reminder relativi a quel giocatore
    await db.reminders.delete_many({"entity": "player", "entity_id": player_id})
    # Annulla i trasferimenti in corso (non validati) del giocatore
    await _cancel_pending_transfers_for_player(player_id, president)
    # Aggiornamento composizione rosa: il giocatore esce dalla squadra proprietaria e corrente
    await rimuovi_da_composizione(p.get("fanta_team_id"), player_id, SEASON)
    await update_dati_generali_composizione_rosa(p.get("fanta_team_id"))
    if p.get("current_team_id") != p.get("fanta_team_id"):
        await rimuovi_da_composizione(p.get("current_team_id"), player_id, SEASON)
        await update_dati_generali_composizione_rosa(p.get("current_team_id"))
    # Ritorno
    return {"ok": True}

# Crea un giocatore, solo il presidente può farlo, con i seguenti attributi:
# id, created_at, updated_at, name, birth_year, image, role, real_club, salary, transfermarkt_value,
# fantavalore, cartellino, tier, fanta_team_id, current_team_id, paying_team_id, jersey_number,
# renewal_count, effective_salary, purchase_price, contract_years, contract_start, contract_end, first_contract_start
@router.post("/players")
async def create_player(data: PlayerIn, president=Depends(require_president)):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    name = data.name.upper()
    real_club = data.real_club.strip()
    if not real_club or real_club.lower() == "svincolato":
        real_club = "Svincolato"
    p2 = await db.players.find_one({"name": name}, {"birth_year": 1})
    if p2:
        if data.birth_year == p2.get("birth_year"):
            raise HTTPException(status_code=400, detail="Nome già utilizzato per un giocatore di quell'anno di nascita")
    if data.birth_year < 1950:
        raise HTTPException(status_code=400, detail="Anno di nascita non utilizzabile")
    if data.salary < 0:
        raise HTTPException(status_code=400, detail="Stipendio non utilizzabile")
    else:
        stip = round(data.salary, 1)
    if data.transfermarkt_value <= 0:
        raise HTTPException(status_code=400, detail="Valore non utilizzabile")
    else:
        val = round(data.transfermarkt_value, 1)
    if data.fantavalore < 1:
        raise HTTPException(status_code=400, detail="FantaValore non utilizzabile")
    if data.tier == "utilizzabile" and real_club not in SQUADRE_SERIE_A:
        raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore non in Serie A")
    if data.tier == "altrove" and real_club in SQUADRE_SERIE_A:
        raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore in Serie A")
    if not data.fanta_team_id:
        if data.current_team_id or data.paying_team_id or data.jersey_number or data.contract_start or data.first_contract_start:
            raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore svincolato")
        if data.renewal_count != 0 or data.contract_years != 0 or data.purchase_price != 0:
            raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore svincolato")
        if data.tier == "academy":
            raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore svincolato")
    else:
        team = await db.teams.find_one({"id": data.fanta_team_id})
        if not team:
            raise HTTPException(status_code=404, detail="FantaSquadra proprietaria non trovata")
        if data.current_team_id:
            if not await db.teams.find_one({"id": data.current_team_id}):
                raise HTTPException(status_code=404, detail="FantaSquadra non trovata")
        else:
            raise HTTPException(status_code=404, detail="FantaSquadra non trovata")
        if data.current_team_id != data.fanta_team_id:
            raise HTTPException(status_code=404, detail="Non puoi creare un giocatore già in prestito")
        if data.tier == "academy":
            if data.jersey_number or data.renewal_count != 0 or data.purchase_price != 0 or data.contract_years != 0 or data.contract_start or data.first_contract_start:
                raise HTTPException(status_code=400, detail="Dati non coerenti per un giocatore in Academy")
            if SEASON["season_start_year"] - data.birth_year > 20:
                raise HTTPException(status_code=400, detail="Età non coerente per un giocatore in Academy")
        if data.paying_team_id != data.fanta_team_id:
            raise HTTPException(status_code=400, detail="La squadra pagante non è relativa a questo giocatore")
        if data.renewal_count < 0:
            raise HTTPException(status_code=400, detail="Numero di rinnovi errato")
        if data.contract_years < 0 or data.contract_years == 4:
            raise HTTPException(status_code=400, detail="Anni di contratto errati")
        if data.contract_years > 0 and not data.contract_start:
            raise HTTPException(status_code=400, detail="Anni di contratto non coerenti")
        if data.contract_start:
            try:
                start_dt = datetime.fromisoformat(data.contract_start.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail="contract_start non è una data valida")
            if data.contract_years == 0:
                raise HTTPException(status_code=400, detail="Anni di contratto non coerenti")
            if not data.first_contract_start:
                raise HTTPException(status_code=400, detail="Non puoi avere un contratto senza aver mai firmato il primo contratto")
            try:
                first_dt = datetime.fromisoformat(data.first_contract_start.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail="first_contract_start non è una data valida")
            if first_dt > start_dt:
                raise HTTPException(status_code=400, detail="first_contract_start deve precedere o coincidere con contract_start")    
    # Creazione
    cart = compute_cartellino(val, data.fantavalore)
    efsal = compute_effective_salary(stip, data.renewal_count)
    coend = compute_contract_end(data.contract_years, data.contract_start)
    doc = data.model_dump()
    doc["name"] = name
    doc["real_club"] = real_club.title()
    doc["salary"] = stip
    doc["transfermarkt_value"] = val
    doc.update({"id": new_id(), "created_at": iso(now_utc()), "updated_at": iso(now_utc())})
    doc["contract_end"] = coend
    doc["effective_salary"] = efsal
    doc["cartellino"] = cart
    await db.players.insert_one(doc)
    # Storico modifiche
    await audit(president, "player", doc["id"], "created", {"name": doc["name"]}, f"La Presidenza ha creato il giocatore {doc['name']}")
    # Creazione reminder contract_termination
    if doc["contract_end"]:
        new_reminder = {
            "title": "Scadenza rinnovo",
            "description": f"Ultimo momento per rinnovare il contratto di {doc['name']}",
            "due_date": compute_contract_termination_due(doc["contract_end"]),
            "team_id": doc["fanta_team_id"],
            "entity": "player",
            "entity_id": doc["id"],
            "kind": "contract_termination",
            "stadium_work": 0}
        try:
            await add_reminder(ReminderIn(**new_reminder))
        except DuplicateKeyError:
            pass
        except Exception as e:
            await audit(president, "reminders", doc["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nella creazione di un reminder contract_termination: {str(e)}")
    # Ricalcolo roster_current_value e notifica ai proprietari
    if data.fanta_team_id and team:
        new_rvc = await compute_roster_value_current(team["id"])
        await db.teams.update_one({"id": team["id"]}, {"$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
        users = await db.users.find({"team_id": data.fanta_team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha creato il giocatore {doc['name']} nella tua squadra", f"/squadra/{data.fanta_team_id}")
    # Aggiornamento composizione rosa: il giocatore entra nella squadra proprietaria
    if doc["fanta_team_id"]:
        await assegna_a_composizione(doc["fanta_team_id"], doc["id"], SEASON)
    await update_dati_generali_composizione_rosa(doc["fanta_team_id"])
    # Ritorno
    doc.pop("_id", None)
    return doc

# Upload di un file Excel/CSV con la lista dei giocatori. Solo il presidente può farlo.
# Se il giocatore già esiste, non fa nulla, altrimenti lo inserisce.
@router.post("/players/upload")
async def upload_players(file: UploadFile = File(...), president=Depends(require_president)):
    # Controlli
    if not file or not file.filename:
        raise HTTPException(400, "File mancante")
    filename = file.filename.lower()
    if not (filename.endswith(".csv") or filename.endswith(".xlsx") or filename.endswith(".xls")):
        raise HTTPException(400, "Formato file non supportato. Usa .csv, .xlsx o .xls")
    content = await file.read()
    if len(content) == 0:
        raise HTTPException(400, "File vuoto")
    max_bytes = 10 * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(400, "File troppo grande: massimo 10MB")
    try:
        if filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Impossibile leggere il file: {e}")
    if df.empty:
        raise HTTPException(400, "Il file non contiene righe valide")
    df.columns = [str(c).strip().lower() for c in df.columns]
    # se ci sono colonne duplicati dopo normalizzazione, fallo saltare
    if len(df.columns) != len(set(df.columns)):
        raise HTTPException(400, "Il file contiene colonne duplicate")
    required = {"nome", "ruolo"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise HTTPException(400, f"Colonne mancanti: {', '.join(missing)}")
    # rimuove righe completamente vuote
    df = df.dropna(how="all")
    if df.empty:
        raise HTTPException(400, "Il file non contiene righe valide")

    def col(row, *aliases):
        for a in aliases:
            if a in row.index and pd.notna(row[a]):
                return row[a]
        return None

    def parse_str(v, default=None):
        if v is None:
            return default
        s = str(v).strip()
        return s if s else default

    def parse_num(v, default=0.0):
        if v is None:
            return default
        s = str(v).replace(",", ".").strip()
        try:
            return float(s)
        except Exception:
            return default

    def parse_date(v):
        if v is None:
            return None
        try:
            return pd.to_datetime(v).isoformat()
        except Exception:
            return None

    # Calcola data inizio contratto
    def compute_contract_start(contract_years: int, contract_end: Optional[str]) -> Optional[str]:
        if not contract_end:
            return None
        if contract_years < 0:
            contract_years = 0
        try:
            end_dt = datetime.fromisoformat(contract_end.replace("Z", "+00:00"))
        except ValueError:
            return None
        target_year = end_dt.year - contract_years
        try: 
            start_dt = end_dt.replace(year=target_year)
        except ValueError:
            last_day = calendar.monthrange(target_year, end_dt.month)[1]
            start_dt = end_dt.replace(year=target_year, day=min(end_dt.day, last_day))
        if "T" in contract_end:
            return start_dt.isoformat()
        return start_dt.date().isoformat()

    # Preload teams and build a normalized name -> id map for FantaSquadra matching
    def norm(s):
        return "".join(ch for ch in str(s).lower() if ch.isalnum())
    teams = await db.teams.find({}, {"_id": 0}).to_list(None)
    team_by_name = {norm(t["name"]): t["id"] for t in teams}

    created_num, skipped_num, error_num = 0, 0, 0
    created, skipped, error = {}, {}, {}
    for idx, row in df.iterrows():
        # Lettura
        riga = idx + 2
        # Lettura campi obbligatori per riga: se mancano, si salta subito con un errore chiaro
        name_raw = parse_str(col(row, "nome"))
        role_raw = parse_str(col(row, "ruolo"))
        anno_raw = col(row, "anno")
        if not name_raw or not role_raw or anno_raw is None:
            error_num += 1
            error[f"riga_{riga}"] = [None, "Nome, ruolo o anno mancanti in questa riga"]
            continue
        name = name_raw.upper()
        role = role_raw.upper()[:1]
        anno = int(parse_num(anno_raw))
        # Se il giocatore esiste già, si salta (non è un errore)
        existing = await db.players.find_one({"name": name, "birth_year": anno})
        if existing:
            skipped_num += 1
            skipped[f"{name} ({anno})"] = [None, "Giocatore già esistente, riga saltata"]
            continue
        tier = parse_str(col(row, "tier"), "utilizzabile").lower()
        image = parse_str(col(row, "immagine"))
        fanta_name = parse_str(col(row, "fantasquadra"))
        jersey = int(parse_num(col(row, "numero"))) or None
        club = parse_str(col(row, "squadra"), "Svincolato").title()
        salary = parse_num(col(row, "stipendio base"), 0) or 0
        rinn = int(parse_num(col(row, "numero rinnovo")))
        prezzo = int(parse_num(col(row, "prezzo")))
        valore_tm = parse_num(col(row, "valore"), 0.1) or 0.1
        fantaval = int(parse_num(col(row, "fantavalore"), 1)) or 1
        anni_contratto = int(parse_num(col(row, "anni di contratto")))
        scadenza = parse_date(col(row, "scadenza di contratto"))
        # Calcoli
        fanta_team_id = team_by_name.get(norm(fanta_name)) if fanta_name and fanta_name.lower() != "svincolati" else None
        inizio_contratto = compute_contract_start(anni_contratto, scadenza)
        doc = {
            "name": name,
            "birth_year": anno,
            "image": image,
            "role": role,
            "real_club": club,
            "salary": salary,
            "transfermarkt_value": valore_tm,
            "fantavalore": fantaval,
            "cartellino": compute_cartellino(valore_tm, fantaval),
            "tier": tier,
            "fanta_team_id": fanta_team_id,
            "current_team_id": fanta_team_id,
            "paying_team_id": fanta_team_id,
            "jersey_number": jersey,
            "renewal_count": rinn,
            "effective_salary": compute_effective_salary(salary, rinn),
            "purchase_price": prezzo,
            "contract_years": anni_contratto,
            "contract_start": inizio_contratto,
            "contract_end": scadenza,
            "first_contract_start": inizio_contratto,
        }
        try:
            await create_player(PlayerIn(**doc), president)
            created_num += 1
            created[f"{name} ({anno})"] = doc
        except Exception as e:
            error_num += 1
            error[f"{name} ({anno})"] = [doc, str(e)]
    # Storico modifiche:
    await audit(president, "players", None, "upload", {"created": created_num, "error": error_num, "skipped": skipped_num}, f"La Presidenza ha caricato un file con {created_num} giocatori creati, {error_num} con errori e {skipped_num} saltati perché esistenti")
    if len(list(error.keys())) != 0:
        await audit(president, "players", None, "upload", error, f"I giocatori con errori sono: {list(error.keys())}")
    return {"created": created, "error": error, "skipped": skipped, "created_num": created_num, "error_num": error_num, "skipped_num": skipped_num}

