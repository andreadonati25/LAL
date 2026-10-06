from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from database import db
from models import ReminderIn
from security import get_current_user
from utils import audit, iso, now_utc
from business import (compute_24_hours, compute_release_amounts,
                       compute_roster_value_current, compute_cartellino, compute_effective_salary,
                       compute_contract_end, release_player_patch, compute_mese_succ, MESE_NUMERO)
from routers.reminders import add_reminder, update_reminder, CAMPI_FOLK
from routers.notifications import add_notification
from routers.monthly import create_comp_rosa, rimuovi_da_composizione, assegna_a_composizione, update_dati_generali_composizione_rosa, save_data_team
from routers.transfers import _esegui_payment, _cancel_pending_transfers_for_player

router = APIRouter()
ITALY = ZoneInfo("Europe/Rome")

BLOCCANTI = {"auto_release", "auto_release_prestito", "attivazione_prestito_diritto",
             "contract_signature", "capitano_vice", "academy_over"}
INFORMATIVI_TEAM = {
    "dati_mancanti_manager_name", "dati_mancanti_president_name", "dati_mancanti_image",
    "dati_mancanti_stadium_name", "dati_mancanti_motto", "dati_mancanti_organigramma",
    "dati_duplicati_manager_name", "dati_duplicati_president_name", "dati_duplicati_image",
    "dati_duplicati_stadium_name", "dati_duplicati_motto", "dati_duplicati_organigramma",
    "limite_rosa", "numero_maglia_mancante", "numero_maglia_duplicato",
}
INFORMATIVI_TRANSFER = {"clausola_libera", "bonus_misurabile"}
DEFAULT_TITLE = {"Fair play finanziario", "Asta estiva", "Chiusura mercato estivo", "Apertura mercato invernale",
                "Asta invernale", "Chiusura mercato invernale", "Pagamento stipendi", "Variazioni automatiche budget trasferimenti",
                "Maturazione utili", "Apertura mercato estivo", "Variazioni automatiche VS", "Distribuzione utili maturati",
                "Cambio stagione ufficiale", "Prossimo taglio"}
KIND_TO_ROUTE = {
    "auto_release": "/squadra/{team_id}?player={player_id}",
    "auto_release_prestito": "/squadra/{team_id}?player={player_id}",
    "attivazione_prestito_diritto": "/squadra/{team_id}?player={player_id}",
    "contract_signature": "/squadra/{team_id}?player={player_id}",
    "capitano_vice": "/squadra/{team_id}",
    "academy_over": "/squadra/{team_id}?player={player_id}",
}
KIND_TO_MESS = {
  "auto_release": "Devi decidere sullo svincolo automatico di {player_name}",
  "auto_release_prestito": "Devi decidere sul prestito di {player_name}, dopo la decisione sullo svincolo automatico",
  "attivazione_prestito_diritto": "Il prestito è terminato, devi decidere sul diritto di riscatto di {player_name}",
  "contract_signature": "Devi far firmare un contratto a {player_name}",
  "capitano_vice": "Devi nominare il capitano e/o vicecapitano",
  "academy_over": "Devi decidere tra svincolare a 0 o offrire un contratto a {player_name}"
}

# ---------- Controllo generale ----------
# Controlli generali e lancio di risoluzioni senza azione dell'utente
@router.post("/system/check-global")
async def check_global():
    ora = iso(now_utc())
    # 1. Controllo contract_signature:
    await _controllo_contract_signature(ora)
    # 2. Controllo capitano/vice:
    await _controllo_capitano_vice(ora)
    # 3. Controllo dati squadra:
    await _controllo_dati_squadre(ora)
    # 4. Controllo giocatori academy:
    await _controllo_giocatori_academy(ora)
    # 5. Controllo dei reminder scaduti:
    scaduti = True
    risolti = []
    while scaduti:
        scaduti, claimed = await resolve_pending(ora)
        if scaduti:
            risolti.append(claimed)
    return {"risolti": risolti}

# Risolve il reminder aperto
async def resolve_pending(ora):
    claimed = await db.reminders.find_one_and_update(
        {"done": False, "due_date": {"$ne": None, "$lte": ora}, "kind": {"$nin": list(BLOCCANTI | INFORMATIVI_TEAM | INFORMATIVI_TRANSFER)}, "title": {"$nin": list(DEFAULT_TITLE)}},
        {"$set": {"done": True, "updated_at": ora}},
        sort=[("due_date", 1)],
        return_document=ReturnDocument.AFTER
    )
    if claimed is None:
        return False, "nulla"
    try:
        if claimed["kind"] == "stadium_works":
            await _resolve_expired_stadium_works(claimed)
        elif claimed["kind"] == "contract_termination":
            await _resolve_expired_contract_termination(claimed)
        elif claimed["kind"] == "prestito_secco":
            await _resolve_expired_prestito_secco(claimed)
        elif claimed["kind"] == "prestito_diritto":
            await _resolve_expired_prestito_diritto(claimed)
        elif claimed["kind"] == "prestito_obbligo":
            await _resolve_expired_prestito_obbligo(claimed)
        elif claimed["kind"] == claimed["due_date"]:
            await _resolve_expired_composizione_rosa(claimed)
        elif claimed["kind"] == "fine_mese":
            await _resolve_expired_fine_mese(claimed)
        elif claimed["kind"] == "pagamento_trasferimento":
            await _resolve_expired_pagamento_trasferimento(claimed)
        elif claimed["kind"] == "esecuzione_trasferimento":
            await _resolve_expired_esecuzione_trasferimento(claimed)
    except Exception as e:
        president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
        await audit(president, "reminders", claimed["id"], "resolve_failed", {"error": str(e)}, f"Errore nella risoluzione di un reminder auto risolvibile: {str(e)}")
        await db.reminders.find_one_and_update(
            {"id": claimed["id"]},
            {"$set": {"done": False, "updated_at": ora}},
            return_document=ReturnDocument.AFTER
        )
        return False, "errore"
    return True, claimed["id"]

# Controlla che i giocatori ingaggiati abbiano un contratto e altrimenti crea il reminder
async def _controllo_contract_signature(ora):
    senza_contratto = await db.players.find(
        {"fanta_team_id": {"$ne": None}, "tier": {"$ne": "academy"}, "contract_start": None},
        {"_id": 0, "id": 1, "fanta_team_id": 1, "name": 1}
    ).to_list(None)
    for p in senza_contratto:
        nuovo = {
            "title": f"Firma contratto per {p['name']}",
            "description": "Contratto mancante: inserisci i dati contrattuali.",
            "due_date": compute_24_hours(ora),
            "team_id": p["fanta_team_id"],
            "entity": "player",
            "entity_id": p["id"],
            "kind": "contract_signature",
            "stadium_work": 0,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass
        except Exception as e:
            president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
            await audit(president, "reminders", p["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nella creazione di un reminder contract_signature: {str(e)}")

# Controlla che tutte le squadre abbiano un capitano e un vice validi e altrimenti crea il reminder
async def _controllo_capitano_vice(ora):
    teams = await db.teams.find({}, {"_id": 0, "id": 1, "captain_id": 1, "vice_captain_id": 1, "name": 1}).to_list(None)
    for t in teams:
        capitano_valido = await _is_capitano_valido(t.get("captain_id"), t["id"])
        vice_valido = await _is_capitano_valido(t.get("vice_captain_id"), t["id"])
        if not capitano_valido or not vice_valido:
            nuovo = {
                "title": "Nomina capitano e vice",
                "description": f"Capitano e/o vice non validi: {t['name']} effettua la nomina.",
                "due_date": ora,
                "team_id": t["id"],
                "entity": "team",
                "entity_id": t["id"],
                "kind": "capitano_vice",
                "stadium_work": 0,
            }
            try:
                await add_reminder(ReminderIn(**nuovo))
            except DuplicateKeyError:
                pass
            except Exception as e:
                president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
                await audit(president, "reminders", t["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nella creazione di un reminder capitano_vice: {str(e)}")

# Controlla i dati folkloristici e il limite rosa delle squadre, e i numeri di maglia dei giocatori
async def _controllo_dati_squadre(ora):
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    teams = await db.teams.find({}, {"_id": 0}).to_list(None)
    
    # ---- Campi folkloristici: mancanti e duplicati ----
    for campo in CAMPI_FOLK:
        valori = {}
        for t in teams:
            v = t.get(campo)
            if v:
                valori.setdefault(v, []).append(t["id"])
        for t in teams:
            v = t.get(campo)
            try:
                if not v:
                    nuovo = {
                        "title": f"Dato mancante: {campo}",
                        "description": f"{t['name']} non ha ancora inserito il campo {campo}.",
                        "due_date": ora, "team_id": t["id"], "entity": "team",
                        "entity_id": t["id"], "kind": f"dati_mancanti_{campo}", "stadium_work": 0,
                    }
                    try:
                        await add_reminder(ReminderIn(**nuovo))
                    except DuplicateKeyError:
                        pass
                else:
                    rem = await db.reminders.find_one({"entity_id": t["id"], "kind": f"dati_mancanti_{campo}", "done": False})
                    if rem:
                        await update_reminder(rem["id"], True)
                if v and len(valori.get(v, [])) >= 2:
                    nuovo = {
                        "title": f"Dato duplicato: {campo}",
                        "description": f"{t['name']} ha lo stesso {campo} di un'altra società.",
                        "due_date": ora, "team_id": t["id"], "entity": "team",
                        "entity_id": t["id"], "kind": f"dati_duplicati_{campo}", "stadium_work": 0,
                    }
                    try:
                        await add_reminder(ReminderIn(**nuovo))
                    except DuplicateKeyError:
                        pass
                else:
                    rem = await db.reminders.find_one({"entity_id": t["id"], "kind": f"dati_duplicati_{campo}", "done": False})
                    if rem:
                        await update_reminder(rem["id"], True)
            except Exception as e:
                await audit(president, "reminders", t["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nel controllo del campo {campo} per {t['name']}: {str(e)}")

    # ---- Limite rosa (esclusa academy) ----
    for t in teams:
        try:
            count = await db.players.count_documents({"fanta_team_id": t["id"], "tier": {"$ne": "academy"}})
            if count > 40:
                nuovo = {
                    "title": "Limite rosa superato",
                    "description": f"{t['name']} ha {count} giocatori in rosa, {count - 40} in eccesso rispetto al limite di 40.",
                    "due_date": ora, "team_id": t["id"], "entity": "team",
                    "entity_id": t["id"], "kind": "limite_rosa", "stadium_work": 0,
                }
                try:
                    await add_reminder(ReminderIn(**nuovo))
                except DuplicateKeyError:
                    pass
            else:
                rem = await db.reminders.find_one({"entity_id": t["id"], "kind": "limite_rosa", "done": False})
                if rem:
                    await update_reminder(rem["id"], True)
        except Exception as e:
            await audit(president, "reminders", t["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nel controllo del limite rosa per {t['name']}: {str(e)}")

    # ---- Numeri di maglia ----
    giocatori = await db.players.find(
        {"current_team_id": {"$ne": None}, "tier": {"$ne": "academy"}},
        {"_id": 0, "id": 1, "name": 1, "current_team_id": 1, "jersey_number": 1}
    ).to_list(None)
    per_numero = {}
    for p in giocatori:
        if p.get("jersey_number") is not None:
            per_numero.setdefault((p["current_team_id"], p["jersey_number"]), []).append(p["id"])
    for p in giocatori:
        try:
            if p.get("jersey_number") is None:
                nuovo = {
                    "title": f"Numero di maglia mancante per {p['name']}",
                    "description": None, "due_date": ora, "team_id": p["current_team_id"],
                    "entity": "player", "entity_id": p["id"], "kind": "numero_maglia_mancante", "stadium_work": 0,
                }
                try:
                    await add_reminder(ReminderIn(**nuovo))
                except DuplicateKeyError:
                    pass
                rem = await db.reminders.find_one({"entity_id": p["id"], "kind": "numero_maglia_duplicato", "done": False})
                if rem:
                    await update_reminder(rem["id"], True)
            else:
                rem = await db.reminders.find_one({"entity_id": p["id"], "kind": "numero_maglia_mancante", "done": False})
                if rem:
                    await update_reminder(rem["id"], True)
                gruppo = per_numero.get((p["current_team_id"], p["jersey_number"]), [])
                if len(gruppo) >= 2:
                    nuovo = {
                        "title": f"Numero di maglia duplicato per {p['name']}",
                        "description": str(p["jersey_number"]), "due_date": ora, "team_id": p["current_team_id"],
                        "entity": "player", "entity_id": p["id"], "kind": "numero_maglia_duplicato", "stadium_work": 0,
                    }
                    try:
                        await add_reminder(ReminderIn(**nuovo))
                    except DuplicateKeyError:
                        pass
                else:
                    rem = await db.reminders.find_one({"entity_id": p["id"], "kind": "numero_maglia_duplicato", "done": False})
                    if rem:
                        await update_reminder(rem["id"], True)
        except Exception as e:
            await audit(president, "reminders", p["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nel controllo del numero di maglia per {p['name']}: {str(e)}")

# Controlla che i giocatori academy abbiano la corretta età.
async def _controllo_giocatori_academy(ora):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise Exception("Nessuna stagione corrente impostata")
    anno_over = SEASON["season_start_year"] - 21
    academy_over = await db.players.find({"tier": "academy", "birth_year": {"$lte": anno_over}}, {"_id": 0}).to_list(None)
    for p in academy_over:
        nuovo = {
            "title": f"Decadenza requisiti d'età Academy",
            "description": f"Il giocatore {p['name']} ha superato l'età minima per fare parte dell'Academy",
            "due_date": ora,
            "team_id": p["fanta_team_id"],
            "entity": "player",
            "entity_id": p["id"],
            "kind": "academy_over",
            "stadium_work": 0,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass
        except Exception as e:
            president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
            await audit(president, "reminders", p["id"], "resolve_pending_failed", {"error": str(e)}, f"Errore nella creazione di un reminder academy_over: {str(e)}")

# Controllo che il giocatore sia un valido capitano/vice
async def _is_capitano_valido(player_id, team_id) -> bool:
    if not player_id:
        return False
    p = await db.players.find_one({"id": player_id}, {"_id": 0})
    if not p:
        return False
    # Un capitano valido è un giocatore della squadra, nella squadra e utilizzabile (non in academy)
    if p.get("fanta_team_id") != team_id or p.get("current_team_id") != team_id or p.get("tier") != "utilizzabile":
        return False
    return True

# Risoluzione reminder stadium_works
async def _resolve_expired_stadium_works(reminder: dict):
    prima = await db.teams.find_one({"id": reminder["entity_id"]}, {"_id": 0, "stadium_capacity": 1})
    if not prima:
        raise Exception(f"Squadra {reminder['entity_id']} non trovata")
    dopo = await db.teams.find_one_and_update(
        {"id": reminder["entity_id"]},
        {"$inc": {"stadium_capacity": reminder["stadium_work"]}, "$set": {"updated_at": iso(now_utc())}},
        return_document=ReturnDocument.AFTER,
    )
    # Modifica ai documenti composizione rosa
    await update_dati_generali_composizione_rosa(dopo["id"])
    # Storico Modifiche
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(president, "team", reminder["entity_id"], "stadium_capacity_updated",
                {"stadium_capacity": {"from": prima.get("stadium_capacity"), "to": dopo.get("stadium_capacity")}}, f"Sono terminati i lavori dello stadio {dopo.get('stadium_name')} della società {dopo.get('name')}. Nuova capienza: {dopo.get('stadium_capacity')}")
    # Notifica
    users = await db.users.find({"team_id": reminder["entity_id"]}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"I lavori allo stadio sono terminati: nuova capienza {dopo.get('stadium_capacity')}", f"/squadra/{reminder['entity_id']}")
    # Ritorno
    return {"ok": True}

# Risoluzione reminder contract_termination: svincolo del giocatore
async def _resolve_expired_contract_termination(reminder: dict):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise Exception("Nessuna stagione corrente impostata")
    SQUADRE_SERIE_A = SEASON["squadre_serie_a"]
    # Controlli
    p = await db.players.find_one({"id": reminder["entity_id"]})
    if not p:
        raise Exception(f"Giocatore {reminder['entity_id']} non trovato")
    if not p.get("fanta_team_id"):
        raise Exception(f"Giocatore {reminder['entity_id']} già svincolato: reminder contract_termination incoerente")
    team = await db.teams.find_one({"id": p.get("fanta_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    # Se c'è una proposta di svincolo automatico attiva
    auto_release_rem = await db.reminders.find_one({"entity_id": p["id"], "kind": "auto_release", "done": False})
    # Parte economica: porzione massima, il contratto è stato onorato per intero.
    contract_years = p.get("contract_years")
    if not contract_years:
        raise Exception(f"Giocatore {reminder['entity_id']} senza anni di contratto validi")
    cartellino = p.get("cartellino")
    transfermarkt_value = p.get("transfermarkt_value")
    valore_base_ridotto = 0.9 * cartellino
    porzione_attuale, porzione_30_06, porzione_utili = compute_release_amounts(transfermarkt_value, valore_base_ridotto)
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await _cancel_pending_transfers_for_player(p["id"], president)
    # Svincolo
    serie_a = p.get("real_club") in SQUADRE_SERIE_A
    patch = release_player_patch(serie_a)
    # In caso di prestito non modifichiamo current, jersey e paying se paying = current
    if p.get("fanta_team_id") != p.get("current_team_id"):
        patch["current_team_id"] = p.get("current_team_id")
        patch["jersey_number"] = p.get("jersey_number")
        if p.get("paying_team_id") == p.get("current_team_id"):
            patch["paying_team_id"] = p.get("paying_team_id")
        # In questo caso c'è una scelta per il detentore in prestito
        if auto_release_rem:
            reminder_prestito = await db.reminders.find_one(
                {"entity_id": p["id"], "done": False, "kind": {"$in": ["prestito_secco", "prestito_diritto", "prestito_obbligo"]}}
            )
            if not reminder_prestito:
                raise Exception(f"Reminder del prestito non trovato per {p['id']}")
            new_reminder = {
                "title": f"Svincolo automatico {p['name']} in prestito",
                "description": "Il proprietario ha perso il giocatore per scadenza contrattuale: decidi se mantenere o terminare il prestito.",
                "due_date": iso(now_utc()),
                "team_id": p["current_team_id"],
                "entity": "reminder",
                "entity_id": reminder_prestito["id"],
                "kind": "auto_release_prestito",
                "stadium_work": 0,
                "transfer_id": reminder_prestito["transfer_id"],
            }
            try:
                await add_reminder(ReminderIn(**new_reminder))
            except DuplicateKeyError:
                pass
    if auto_release_rem:
        patch["fantavalore"] = 1
        patch["cartellino"] = compute_cartellino(transfermarkt_value, 1)
    patch["effective_salary"] = compute_effective_salary(p.get("salary"), patch["renewal_count"])
    patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
    patch["updated_at"] = iso(now_utc())
    await db.players.update_one({"id": p["id"]}, {"$set": patch})
    # Storico Modifiche
    await audit(president, "player", p["id"], "contract_expired", {"name": p.get("name"), "auto_release_superseded": bool(auto_release_rem)}, f"È terminato il contratto di {p.get('name')} con la società {team.get('name')}")
    # Modifica della squadra (introiti)
    new_rvc = await compute_roster_value_current(p.get("fanta_team_id"))
    await db.teams.update_one({"id": p.get("fanta_team_id")},
        {"$inc": {
            "bdg_trasferimenti": porzione_attuale,
            "bdgt_dilazionato_30giu": porzione_30_06,
            "utili.mercato": porzione_utili,
        }, "$set": {"roster_value_current": new_rvc, "updated_at": iso(now_utc())}})
    # Chiudiamo l'eventuale proposta di svincolo automatico
    if auto_release_rem:
        await update_reminder(auto_release_rem["id"], True)
    # Notifica al proprietario
    users = await db.users.find({"team_id": p["fanta_team_id"]}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"Il contratto di {p.get('name')} è scaduto: il giocatore è stato svincolato automaticamente", f"/listone?player={reminder['entity_id']}")
    # Se era in prestito, notifica anche al detentore
    if p.get("fanta_team_id") != p.get("current_team_id"):
        users_curr = await db.users.find({"team_id": p.get("current_team_id")}, {"id": 1, "_id": 0}).to_list(None)
        for u in users_curr:
            await add_notification(u["id"], f"Il contratto di {p.get('name')}, in prestito alla tua squadra, è scaduto ed è stato svincolato", f"/squadra/{p['current_team_id']}?player={reminder['entity_id']}")
    # Aggiornamento composizione rosa: il giocatore esce dalla squadra proprietaria originale
    await rimuovi_da_composizione(p.get("fanta_team_id"), p["id"], SEASON)
    await update_dati_generali_composizione_rosa(p.get("fanta_team_id"))
    # Ritorno
    return {"ok": True}

# Risoluzione reminder prestito_secco
async def _resolve_expired_prestito_secco(reminder: dict):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise Exception("Nessuna stagione corrente impostata")
    # Controlli
    p = await db.players.find_one({"id": reminder["entity_id"]})
    if not p:
        raise Exception(f"Giocatore {reminder['entity_id']} non trovato")
    squadra_detentrice = p.get("current_team_id")
    team = await db.teams.find_one({"id": p.get("current_team_id")})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    proprietario = p.get("fanta_team_id")  # può essere None: il giocatore torna svincolato
    patch = {
        "current_team_id": proprietario,
        "paying_team_id": proprietario,
        "jersey_number": None,
        "updated_at": iso(now_utc()),
    }
    await db.players.update_one({"id": p["id"]}, {"$set": patch})
    # Storico Modifiche
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(president, "player", p["id"], "prestito_terminato", {"name": p.get("name")}, f"È terminato il prestito di {p.get('name')} alla squadra {team.get('name')}")
    # Notifica al proprietario, se esiste ancora
    if proprietario:
        proprietario_users = await db.users.find({"team_id": proprietario}, {"id": 1, "_id": 0}).to_list(None)
        for u in proprietario_users:
            await add_notification(u["id"], f"Il prestito di {p.get('name')} è terminato: il giocatore è tornato alla tua squadra", f"/squadra/{proprietario}?player={reminder['entity_id']}")
    # Notifica al detentore
    if squadra_detentrice:
        detentore_users = await db.users.find({"team_id": squadra_detentrice}, {"id": 1, "_id": 0}).to_list(None)
        testo = (f"Il prestito di {p.get('name')} è terminato: il giocatore è tornato alla squadra proprietaria"
                 if proprietario else
                 f"Il prestito di {p.get('name')} è terminato: il giocatore è ora svincolato")
        for u in detentore_users:
            await add_notification(u["id"], testo, f"/listone?player={reminder['entity_id']}")
    # Aggiornamento composizione rosa: esce dal detentore; se c'è un proprietario, rientra tra i suoi idonei
    await rimuovi_da_composizione(squadra_detentrice, p["id"], SEASON)
    await update_dati_generali_composizione_rosa(squadra_detentrice)
    if proprietario:
        await rimuovi_da_composizione(proprietario, p["id"], SEASON)
        await assegna_a_composizione(proprietario, p["id"], SEASON)
        await update_dati_generali_composizione_rosa(proprietario)
    # Ritorno
    return {"ok": True}

# Risoluzione reminder prestito_diritto
async def _resolve_expired_prestito_diritto(reminder: dict):
    # Controlli
    p = await db.players.find_one({"id": reminder["entity_id"]}, {"_id": 0, "name": 1})
    if not p:
        raise Exception(f"Giocatore {reminder['entity_id']} non trovato")
    nome = p.get("name")
    # Inserimento reminder per la decisione sul diritto
    new_reminder = {
        "title": f"Diritto di riscatto per {nome}",
        "description": "Decidi se riscattare il giocatore o terminare il prestito.",
        "due_date": iso(now_utc()),
        "team_id": p.get('current_team_id'),
        "entity": "player",
        "entity_id": reminder["entity_id"],
        "kind": "attivazione_prestito_diritto",
        "stadium_work": 0,
        "transfer_id": reminder["transfer_id"],
    }
    try:
        await add_reminder(ReminderIn(**new_reminder))
    except DuplicateKeyError:
        pass
    # Ritorno
    return {"ok": True}

# Crea (ed esegue subito) il Transfer definitivo conseguente alla redenzione di un prestito
# (diritto deciso a scadenza naturale, o obbligo). Se non c'era un vecchio proprietario (il giocatore
# era già svincolato durante il prestito), è un'assegnazione (team_a_id = None): il nuovo proprietario
# paga comunque la cifra pattuita, ma non c'è nessuno a riceverla.
async def _crea_transfer_redenzione(reminder: dict, user: dict = None) -> dict:
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise Exception("Nessuna stagione corrente impostata")
    # Controlli
    p = await db.players.find_one({"id": reminder["entity_id"]})
    if not p:
        raise Exception(f"Giocatore {reminder['entity_id']} non trovato")
    vecchio_proprietario = p.get("fanta_team_id")
    nuovo_proprietario = p.get("current_team_id")
    if not nuovo_proprietario:
        raise Exception(f"Giocatore {reminder['entity_id']}: current_team_id mancante, trasferimento incoerente")
    prestito = await db.transfers.find_one({"id": reminder["transfer_id"]}, {"_id": 0})
    if not prestito:
        raise Exception(f"Trasferimento {reminder['transfer_id']} non trovato")
    movement = next((m for m in prestito["movements"] if m["player_id"] == p["id"]), None)
    if not movement or movement.get("cifra_riscatto") is None:
        raise Exception(f"Trasferimento {reminder['transfer_id']}: cifra_riscatto mancante per {p.get('name')}")
    redemption_owner = movement.get("redemption_owner_team_id", movement["from_team_id"])
    if vecchio_proprietario != redemption_owner:
        raise Exception(f"Il giocatore {p.get('name')} non è più di proprietà della squadra cedente prevista nel prestito originale")
    cifra = movement["cifra_riscatto"]
    ora = now_utc()
    ora_iso = iso(ora)
    # Creazione del Transfer, già convalidato
    doc = {
        "id": new_id(), "team_a_id": vecchio_proprietario, "team_b_id": nuovo_proprietario,
        "movements": [{
            "id": new_id(), "player_id": p["id"], "from_team_id": vecchio_proprietario,
            "to_team_id": nuovo_proprietario, "tipo": "definitivo",
            "purchase_price": cifra, "cifra_riscatto": None, "paying_team_id": None, "loan_due_date": None,
        }],
        "payments": [], "bonus": [], "clausole_libere": [],
        "status": "convalidato",
        "confirmations": {k: True for k in filter(None, [vecchio_proprietario, nuovo_proprietario])},
        "origin_transfer_id": prestito["id"],
        "window_year": SEASON["season_start_year"], "window_session": None, "proposed_by_president": True,
        "created_at": ora_iso, "updated_at": ora_iso, "validated_at": ora_iso, "executed_at": None,
    }
    if vecchio_proprietario:
        doc["payments"] = [{
            "id": new_id(), "amount": cifra, "tipo": "now",
            "paid_by_team_id": nuovo_proprietario, "paid_to_team_id": vecchio_proprietario,
        }]
    await db.transfers.insert_one(doc)
    # Movimento economico solo se c'è un vecchio proprietario
    if vecchio_proprietario:
        await _esegui_payment(doc["payments"][0], ora_iso)
    # Storico modifiche
    audit_user = user or await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(audit_user, "transfer", doc["id"], "creato", {}, f"Riscatto del prestito di {p.get('name')}: creato il trasferimento conseguente")
    # Esecuzione immediata: finalizza un accordo già pattuito, non una nuova trattativa di mercato
    await _esegui_movimento_definitivo(doc["movements"][0], SEASON, ora_iso)
    await db.transfers.update_one({"id": doc["id"]}, {"$set": {"status": "eseguito", "executed_at": ora_iso}})
    doc.pop("_id", None)
    return await db.transfers.find_one({"id": doc["id"]}, {"_id": 0})

# Risoluzione reminder prestito_obbligo
async def _resolve_expired_prestito_obbligo(reminder: dict):
    return await _crea_transfer_redenzione(reminder)

# Risoluzione reminder composizione rosa
async def _resolve_expired_composizione_rosa(reminder: dict):
    # Import
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    dcr = season["date_composizione_rosa"]
    # Per capire quale composizione rosa sto chiudendo posso guardare description
    mese_succ = compute_mese_succ(reminder["description"])
    # Ottengo le squadre
    teams = await db.teams.find({}, {"_id": 0}).to_list(None)
    if mese_succ == "giugno":
        for team in teams:
            # Creazione del documento di composizione rosa di giugno
            await create_comp_rosa(team["id"], mese_succ, season)
        # Ritorno
        return {"ok": True}
    # Ottengo il due date corretto
    if mese_succ == "settembre":
        due_date = dcr.get("asta_estiva")
    elif mese_succ == "febbraio":
        due_date = dcr.get("asta_invernale")
    else:
        due_date = dcr.get(mese_succ)
    # Crea il nuovo reminder
    nuovo = {
        "title": f"Composizione rosa {mese_succ}",
        "description": mese_succ,
        "due_date": due_date,
        "team_id": None,
        "entity": "season",
        "entity_id": season["id"],
        "kind": due_date,
        "stadium_work": 0,
    }
    try:
        await add_reminder(ReminderIn(**nuovo))
    except DuplicateKeyError:
        pass
    for team in teams:
        # Creazione del documento di composizione rosa
        await create_comp_rosa(team["id"], mese_succ, season)
    # Storico Modifiche
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(president, "season", season["id"], "composizione_rosa", {}, f"Si è chiusa la composizione rosa di {reminder['description']}: è stata creata quella di {mese_succ}")
    # Ritorno
    return {"ok": True}

# Risoluzione reminder fine_mese
async def _resolve_expired_fine_mese(reminder: dict):
    # Import
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    dcr = season["date_composizione_rosa"]
    # Per capire quale mese sto salvando posso guardare description
    mese = reminder["description"]
    mese_succ = compute_mese_succ(mese)
    # Ottengo le squadre
    teams = await db.teams.find({}, {"_id": 0}).to_list(None)
    if mese_succ == "giugno":
        for team in teams:
            # Salvataggio dati squadra di maggio
            await save_data_team(team["id"], mese, season)
        # Ritorno
        return {"ok": True}
    # Ottengo il due date corretto
    numero = MESE_NUMERO[compute_mese_succ(mese_succ)]
    anno = season["season_start_year"] if numero >= 7 else season["season_start_year"] + 1
    due_date = iso(datetime(anno, numero, 1, tzinfo=ITALY).astimezone(timezone.utc))
    # Creazione reminder salvataggio dati mese prossimo
    nuovo = {
        "title": f"Salvataggio dati squadra {mese_succ}",
        "description": mese_succ,
        "due_date": due_date,
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
    for team in teams:
        # Salvataggio dati squadra del mese
        await save_data_team(team["id"], mese, season)
    # Storico Modifiche
    president = await db.users.find_one({"role": "presidente"}, {"_id": 0})
    await audit(president, "season", season["id"], "composizione_rosa", {}, f"Si è chiusa la fase di salvataggio dati squadra di {mese}: è stata creata quella di {mese_succ}")
    # Ritorno
    return {"ok": True}

# Risoluzione reminder pagamento_trasferimento
async def _resolve_expired_pagamento_trasferimento(reminder: dict):
    # Controlli
    transfer = await db.transfers.find_one({"id": reminder["transfer_id"]}, {"_id": 0})
    if not transfer:
        raise Exception(f"Trasferimento {reminder['transfer_id']} non trovato")
    pay = next((p for p in transfer["payments"] if p["id"] == reminder["entity_id"]), None)
    if not pay:
        raise Exception(f"Pagamento {reminder['entity_id']} non trovato nel trasferimento {transfer['id']}")
    ora_iso = iso(now_utc())
    # Movimenti economici
    await _esegui_payment(pay, ora_iso)
    # Ritorno
    return {"ok": True}

# Risoluzione reminder esecuzione_trasferimento
async def _resolve_expired_esecuzione_trasferimento(reminder: dict):
    # Import
    SEASON = await db.season_settings.find_one({"current": True})
    if not SEASON:
        raise Exception("Nessuna stagione corrente impostata")
    # Controlli
    transfer = await db.transfers.find_one({"id": reminder["transfer_id"]}, {"_id": 0})
    if not transfer:
        raise Exception(f"Trasferimento {reminder['transfer_id']} non trovato")
    m = next((mv for mv in transfer["movements"] if mv["id"] == reminder["entity_id"]), None)
    if not m:
        raise Exception(f"Movimento {reminder['entity_id']} non trovato nel trasferimento {transfer['id']}")
    player = await db.players.find_one({"id": m["player_id"]}, {"_id": 0})
    if not player or player.get("fanta_team_id") != m["from_team_id"]:
        raise Exception(f"Il giocatore {m['player_id']} non è più di proprietà della squadra cedente prevista")
    ora_iso = iso(now_utc())
    # Esecuzione del movimento
    if m["tipo"] == "definitivo":
        await _esegui_movimento_definitivo(m, SEASON, ora_iso)
    else:
        await _esegui_movimento_prestito(m, transfer["id"], SEASON, ora_iso)
    # Se non restano altri movimenti in attesa per questo trasferimento, è concluso
    residui = await db.reminders.find_one({"entity": "transfer", "kind": "esecuzione_trasferimento", "transfer_id": transfer["id"], "done": False, "id": {"$ne": reminder["id"]}})
    if not residui:
        await db.transfers.update_one({"id": transfer["id"]}, {"$set": {"status": "eseguito", "executed_at": ora_iso, "updated_at": ora_iso}})
    # Ritorno
    return {"ok": True}

# Ricerca del più vecchio reminder bloccante e invio della pagina a cui rimandare per risolverlo.
@router.get("/system/check-blocking")
async def check_blocking(user=Depends(get_current_user)):
    # Controlli
    if user["role"] == "presidente":
        return {"block": False}
    if not user.get("team_id"):
        return {"block": False}
    # Ricerca
    ora = iso(now_utc())
    team_id = user["team_id"]
    reminder = await db.reminders.find_one({"team_id": team_id, "kind": {"$in": list(BLOCCANTI)}, "done": False, "due_date": {"$ne": None, "$lte": ora}}, {"_id": 0}, sort=[("due_date", 1)])
    if not reminder:
        return {"block": False}
    kind = reminder["kind"]
    entity = reminder["entity"]
    entity_id = reminder["entity_id"]
    route_temp = KIND_TO_ROUTE.get(kind)
    message_temp = KIND_TO_MESS.get(kind)
    # non dovrebbe succedere se BLOCCANTI e KIND_TO_ROUTE restano sincronizzati
    if not route_temp:
        return {"block": False}

    if entity == "player":
        p = await db.players.find_one({"id": entity_id})
        player_name = p.get("name", "Errore")
        route = route_temp.format(team_id=team_id, player_id=entity_id)
        message = message_temp.format(player_name=player_name)
    elif entity == "reminder":
        # Solo kind = auto_release_prestito
        rem_pres = await db.reminders.find_one({"id": entity_id})
        p = await db.reminders.find_one({"id": rem_pres.get("entity_id")})
        player_name = p.get("name", "Errore")
        route = route_temp.format(team_id=team_id, player_id=entity_id)
        message = message_temp.format(player_name=player_name)
    else:
        # Solo kind = capitano_vice
        route = route_temp.format(team_id=team_id)
        message = message_temp    
    
    return {
        "block": True,
        "redirect": route,
        "message": message,
        "reminder_id": reminder["id"],
        "kind": kind,
    }

