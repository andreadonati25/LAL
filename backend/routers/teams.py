from fastapi import APIRouter, HTTPException, Depends
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from database import db
from security import get_current_user, optional_user, require_president
from models import TeamIn, VSVar, Utili, capienza_stadio, spesa_stipendi, StadiumWorkIn, ReminderIn, JerseyNumbersIn
from routers.notifications import add_notification
from utils import new_id, now_utc, iso, audit, is_number, format_diff_message
from business import compute_effective_salary, compute_contract_end, add_months, release_player_patch
from routers.system import _is_capitano_valido
from routers.monthly import init_comp_rosa_per_nuova_squadra, update_dati_generali_composizione_rosa, correggi_composizione_se_necessaria, composizione_in_vigore, prossima_composizione
from routers.reminders import add_reminder, update_reminder

router = APIRouter()

MONTHS_IT = ["luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
             "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno"]
COSTO_LAVORI_STADIO = {1_000: 1_000_000, 2_000: 2_000_000, 5_000: 5_000_000, 10_000: 10_000_000,
                        20_000: 20_000_000, 50_000: 50_000_000, 100_000: 100_000_000}
DURATA_MESI_LAVORI_STADIO = {1_000: 2, 2_000: 3, 5_000: 6, 10_000: 12, 20_000: 24, 50_000: 24, 100_000: 48}

# ---------- Teams ----------
# Modifica in blocco i numeri di maglia di tutti i giocatori non-Academy della rosa fisica (current_team_id).
# Riservato al proprietario, solo se esiste un problema segnalato sui numeri di maglia per questa squadra, o al presidente sempre.
@router.patch("/teams/{team_id}/jersey-numbers")
async def set_jersey_numbers(team_id: str, data: JerseyNumbersIn, user=Depends(get_current_user)):
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == team_id
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    if not is_president:
        rem = await db.reminders.find_one({"team_id": team_id, "kind": {"$in": ["numero_maglia_mancante", "numero_maglia_duplicato"]}, "done": False})
        if not rem:
            raise HTTPException(400, "Nessun problema sui numeri di maglia per questa squadra")
    squadra = await db.players.find({"current_team_id": team_id, "tier": {"$ne": "academy"}}, {"_id": 0, "id": 1}).to_list(None)
    attesi = {p["id"] for p in squadra}
    ricevuti = set(data.numbers.keys())
    if attesi != ricevuti:
        raise HTTPException(400, "Il payload deve contenere esattamente i giocatori non-Academy della rosa fisica")
    valori = [v for v in data.numbers.values() if v is not None]
    if len(valori) != len(set(valori)):
        raise HTTPException(400, "Numeri di maglia duplicati nel payload")
    # Modifica
    for player_id, numero in data.numbers.items():
        await db.players.update_one({"id": player_id}, {"$set": {"jersey_number": numero, "updated_at": iso(now_utc())}})
    # Storico modifiche
    if is_president:
        await audit(user, "team", team_id, "jersey_numbers_aggiornati", {"numbers": data.numbers}, f"La Presidenza ha modificato i numeri di maglia della società {team.get('name')}")
    else:
        await audit(user, "team", team_id, "jersey_numbers_aggiornati", {"numbers": data.numbers}, f"La società {team.get('name')} ha modificato i numeri di maglia")
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], "La Presidenza ha modificato i numeri di maglia della tua squadra", f"/squadra/{team_id}")
    # Ritorno
    giocatori = await db.players.find({"id": {"$in": list(attesi)}}, {"_id": 0}).to_list(None)
    return giocatori

# Avvio di un lavoro allo stadio (ampliamento o diminuzione). Proprietario o presidente.
@router.post("/teams/{team_id}/stadium-works")
async def start_stadium_works(team_id: str, data: StadiumWorkIn, user=Depends(get_current_user)):
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == team_id
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    stadium_work = data.stadium_work
    if stadium_work == 0:
        raise HTTPException(400, "La variazione di posti non può essere nulla")
    abs_variazione = abs(stadium_work)
    if abs_variazione not in DURATA_MESI_LAVORI_STADIO:
        raise HTTPException(400, "Variazione di posti non ammessa")
    if await db.reminders.find_one({"entity": "team", "entity_id": team_id, "kind": "stadium_works", "done": False}):
        raise HTTPException(400, "C'è già un lavoro allo stadio in corso per questa squadra")
    nuova_capienza = team.get("stadium_capacity") + stadium_work
    if nuova_capienza < 5000 or nuova_capienza > 151000:
        raise HTTPException(400, "La capienza risultante è fuori dal range ammissibile (5.000 - 151.000)")
    costo = COSTO_LAVORI_STADIO[abs_variazione]
    variazione_liberi = -costo if stadium_work > 0 else costo
    # Creazione del reminder (prima del movimento economico)
    mesi = DURATA_MESI_LAVORI_STADIO[abs_variazione]
    due_date = iso(add_months(now_utc(), mesi))
    tipo = "ampliamento" if stadium_work > 0 else "diminuzione"
    nuovo = ReminderIn(
        title=f"Lavori stadio {team.get('name')}", description=f"Lavori di {tipo} stadio di {abs_variazione} posti", due_date=due_date,
        team_id=team_id, entity="team", entity_id=team_id, kind="stadium_works", stadium_work=stadium_work,
    )
    try:
        reminder = await add_reminder(nuovo)
    except DuplicateKeyError:
        raise HTTPException(400, "C'è già un lavoro allo stadio in corso per questa squadra")
    # Modifica: movimento immediato su u_liberi
    await db.teams.update_one({"id": team_id}, {"$inc": {"u_liberi": variazione_liberi}, "$set": {"updated_at": iso(now_utc())}})
    # Storico Modifiche
    if is_president:
        await audit(user, "team", team_id, "stadium_works_avviato", {"stadium_work": stadium_work}, f"La Presidenza ha avviato un lavoro di {tipo} stadio di {abs_variazione} posti per la società {team.get('name')}")
    else:
        await audit(user, "team", team_id, "stadium_works_avviato", {"stadium_work": stadium_work}, f"La società {team.get('name')} ha avviato un lavoro di {tipo} stadio di {abs_variazione} posti")
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha avviato un lavoro di {tipo} stadio di {abs_variazione} posti per la tua squadra", f"/squadra/{team_id}")
    # Ritorno
    t2 = await db.teams.find_one({"id": team_id}, {"_id": 0})
    return {"team": t2, "reminder": reminder}

# Imposta il capitano e il vice capitano per una squadra (se necessario)
@router.post("/teams/{team_id}/capitano")
async def set_capitano_vice(team_id: str, captain_id: str, vice_captain_id: str, user=Depends(get_current_user)):
    # Import
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == team_id
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    rem = await db.reminders.find_one({"entity_id": team_id, "kind": "capitano_vice", "done": False})
    if not is_president and not rem:
        raise HTTPException(400, "Nessuna nomina di capitano/vice in corso per questa squadra")
    if captain_id == vice_captain_id:
        raise HTTPException(400, "Capitano e vice non possono essere lo stesso giocatore")
    if not await _is_capitano_valido(captain_id, team_id):
        raise HTTPException(400, "Il giocatore scelto come capitano non è valido")
    if not await _is_capitano_valido(vice_captain_id, team_id):
        raise HTTPException(400, "Il giocatore scelto come vice capitano non è valido")
    # Modifica
    patch = {"captain_id": captain_id, "vice_captain_id": vice_captain_id, "updated_at": iso(now_utc())}
    await db.teams.update_one({"id": team_id}, {"$set": patch})
    # Modifica ai documenti composizione rosa
    await correggi_composizione_se_necessaria(captain_id, season)
    await update_dati_generali_composizione_rosa(team_id)
    # Storico Modifiche
    if is_president:
        await audit(user, "team", team_id, "capitano_nominato", {"captain_id": captain_id, "vice_captain_id": vice_captain_id}, f"La presidenza ha assegnato i ruoli di capitano e vice capitano per la società {team.get('name')}")
    else:
        await audit(user, "team", team_id, "capitano_nominato", {"captain_id": captain_id, "vice_captain_id": vice_captain_id}, f"La società {team.get('name')} ha assegnato i ruoli di capitano e vice capitano")
    # Aggiorno reminder
    if rem:
        await update_reminder(rem["id"], True)
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], "La Presidenza ha assegnato i ruoli di capitano e vice capitano per la tua squadra", f"/squadra/{team_id}")
    # Ritorno
    team2 = await db.teams.find_one({"id": team_id}, {"_id": 0})
    return team2

# Ottieni tutte le squadre
@router.get("/teams")
async def list_teams(user=Depends(optional_user)):
    teams = await db.teams.find({}, {"_id": 0}).sort("name", 1).to_list(None)
    return teams

# Ottieni una squadra
@router.get("/teams/{team_id}")
async def get_team(team_id: str, user=Depends(optional_user)):
    t = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Squadra non trovata")
    t["users"] = await db.users.find(
        {"team_id": team_id}, {"_id": 0, "name": 1}
    ).sort("name", 1).to_list(None)
    t["stadium_works_active"] = bool(await db.reminders.find_one({
        "team_id": team_id, "entity": "team", "entity_id": team_id,
        "kind": "stadium_works", "done": False,
    }, {"_id": 1}))
    return t

@router.get("/teams/{team_id}/roster-current")
async def get_current_roster(team_id: str, user=Depends(optional_user)):
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    composition = await composizione_in_vigore(team_id, season)
    sections = {section: composition.get(section, []) for section in [
        "prima_squadra", "primavera", "tribuna", "estero", "academy", "in_prestito"
    ]}
    player_ids = list({player_id for ids in sections.values() for player_id in ids})
    pipeline = [
        {"$match": {"id": {"$in": player_ids}}},
        {"$addFields": {"_role_order": {"$indexOfArray": [["P", "D", "C", "A"], "$role"]}}},
        {"$sort": {"_role_order": 1, "cartellino": -1, "birth_year": -1}},
        {"$project": {"_id": 0, "_role_order": 0}},
    ]
    cursor = db.players.aggregate(pipeline)
    players = await cursor.to_list(None)
    contracted_players = await db.players.count_documents({
        "fanta_team_id": team_id,
        "contract_start": {"$exists": True, "$ne": None},
        "contract_years": {"$gt": 0},
    })
    academy_players = await db.players.find(
        {"fanta_team_id": team_id, "tier": "academy"},
        {"_id": 0, "transfermarkt_value": 1},
    ).to_list(None)

    next_comp = await prossima_composizione(team_id, season)

    return {
        "sections": {
            section: [p for p in players if p["id"] in set(ids)]
            for section, ids in sections.items()
        },
        "captain_id": team.get("captain_id"),
        "vice_captain_id": team.get("vice_captain_id"),
        "contracted_players": contracted_players,
        "academy_market_value": sum(float(player.get("transfermarkt_value") or 0) for player in academy_players),
    }

# Elimina una squadra, solo il presidente può farlo.
@router.delete("/teams/{team_id}")
async def delete_team(team_id: str, president=Depends(require_president)):
    # Controlli
    target = await db.teams.find_one({"id": team_id})
    if not target:
        raise HTTPException(404, "Squadra non trovata")
    # Eliminazione
    await db.teams.delete_one({"id": team_id})
    # Storico modifiche
    await audit(president, "team", team_id, "deleted", {}, f"Il presidente ha eliminato la società {target.get('name')}")
    # Notifica ai proprietari
    users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], "La Presidenza ha eliminato la tua squadra", f"/")
    # Dissociazione proprietari - squadra
    await db.users.update_many({"team_id": team_id}, {"$set": {"team_id": None, "updated_at": iso(now_utc())}})
    # Svincolare tutti i giocatori in modo automatico 
    await mass_termination_contracts(team_id, president)
    # Eliminare tutti i reminder relativi a quella squadra
    await db.reminders.delete_many({"team_id": team_id})
    # Ritorno
    return {"ok": True}

# Funzione di sistema per "svincolare" tutti i giocatori di una squadra eliminata
async def mass_termination_contracts(team_id: str, president: dict):
    # Import
    SYSTEM = await db.season_settings.find_one({"current": True})
    if not SYSTEM:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    SQUADRE_SERIE_A = SYSTEM["squadre_serie_a"]
    players = await db.players.find({"fanta_team_id": team_id}).to_list(None)
    for p in players:
        serie_a = p.get("real_club") in SQUADRE_SERIE_A
        patch = release_player_patch(serie_a)
        if p.get("current_team_id") != p.get("fanta_team_id"):
            patch["current_team_id"] = p.get("current_team_id")
            patch["jersey_number"] = p.get("jersey_number")
            if p.get("paying_team_id") == p.get("current_team_id"):
                patch["paying_team_id"] = p.get("paying_team_id")
        patch["effective_salary"] = compute_effective_salary(p.get("salary"), patch["renewal_count"])
        patch["contract_end"] = compute_contract_end(patch["contract_years"], patch["contract_start"])
        patch["updated_at"] = iso(now_utc())
        await db.players.update_one({"id": p.get("id")}, {"$set": patch})
    return {"ok": True}

# Modifica diretta di una squadra, il presidente può farlo quasi completamente e il proprietario solo in parte:
# Presidente: tutto tranne i campi informatici, capitano e vice_capitano e roster_value_current (che è calcolato).
# Proprietario: name e i campi folkloristici
@router.patch("/teams/{team_id}")
async def patch_team(team_id: str, patch: dict, user=Depends(get_current_user)):
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == team_id
    if is_president:
        allowed = {"name", "manager_name", "president_name", "motto", "organigramma", "color_1", "color_2", "color_3", "image", "stadium_name",
                    "stadium_capacity", "vs", "bdg_trasferimenti", "bdg_stipendi", "u_liberi", "vs_var", "aspettativa_stagionale",
                    "roster_value_summer", "bdgt_dilazionato_30giu", "utili", "stadium_capacity_by_month", "salary_spend_by_month"}
    elif is_owner:
        allowed = {"name", "manager_name", "president_name", "motto", "organigramma", "image", "color_1", "color_2", "color_3", "stadium_name"}
    else:
        raise HTTPException(403, "Puoi modificare solo la tua squadra")
    filtered = {k: v for k, v in patch.items() if k in allowed}
    # Campi stringa opzionali
    string_optional_fields = {"manager_name", "president_name", "motto", "organigramma", "color_1", "color_2", "color_3", "image", "stadium_name"}
    for f in string_optional_fields & filtered.keys():
        if filtered[f] is not None and not isinstance(filtered[f], str):
            raise HTTPException(status_code=400, detail=f"{f} deve essere una stringa")
    # name: stringa esistente + unicità
    if "name" in filtered:
        if not isinstance(filtered["name"], str) or not filtered["name"]:
            raise HTTPException(status_code=400, detail="Nome non valido")
        if await db.teams.find_one({"name": filtered["name"], "id": {"$ne": team_id}}):
            raise HTTPException(status_code=400, detail="Nome già utilizzato")
    # stadium_capacity, aspettativa_stagionale: intero esistente nel range
    if "stadium_capacity" in filtered:
        v = filtered["stadium_capacity"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise HTTPException(status_code=400, detail="Capienza stadio non valida")
        if v < 5000 or v > 151000:
            raise HTTPException(status_code=400, detail="Capienza stadio fuori dal range ammissibile")
    if "aspettativa_stagionale" in filtered:
        v = filtered["aspettativa_stagionale"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise HTTPException(status_code=400, detail="Aspettativa stagionale non valida")
        if v < 0 or v > 8:
            raise HTTPException(status_code=400, detail="Aspettativa stagionale fuori dal range ammissibile")
    # campi economici float esistenti
    numeric_fields = {"vs", "bdg_trasferimenti", "bdg_stipendi", "u_liberi", "roster_value_summer", "bdgt_dilazionato_30giu"}
    for f in numeric_fields & filtered.keys():
        if not is_number(filtered[f]):
            raise HTTPException(status_code=400, detail=f"{f} deve essere un numero")
    # vs_var: unione col valore esistente + validazione via il modello Pydantic stesso
    if "vs_var" in filtered:
        if not isinstance(filtered["vs_var"], dict):
            raise HTTPException(status_code=400, detail="vs_var non valido")
        merged = {**team.get("vs_var", {}), **filtered["vs_var"]}
        try:
            filtered["vs_var"] = VSVar(**merged).model_dump()
        except ValidationError:
            raise HTTPException(status_code=400, detail="vs_var non valido")
    # utili: unione col valore esistente + validazione via il modello Pydantic stesso
    if "utili" in filtered:
        if not isinstance(filtered["utili"], dict):
            raise HTTPException(status_code=400, detail="utili non valido")
        merged = {**team.get("utili", {}), **filtered["utili"]}
        try:
            filtered["utili"] = Utili(**merged).model_dump()
        except ValidationError:
            raise HTTPException(status_code=400, detail="utili non valido")
    # stadium_capacity_by_month: unione + validazione struttura + range su ogni mese
    if "stadium_capacity_by_month" in filtered:
        if not isinstance(filtered["stadium_capacity_by_month"], dict):
            raise HTTPException(status_code=400, detail="stadium_capacity_by_month non valido")
        merged = {**team.get("stadium_capacity_by_month", {}), **filtered["stadium_capacity_by_month"]}
        try:
            validated = capienza_stadio(**merged).model_dump()
        except ValidationError:
            raise HTTPException(status_code=400, detail="stadium_capacity_by_month non valido")
        for m in MONTHS_IT:
            if validated[m] < 5000 or validated[m] > 151000:
                raise HTTPException(status_code=400, detail=f"Capienza stadio di {m} fuori dal range ammissibile")
        filtered["stadium_capacity_by_month"] = validated
    # salary_spend_by_month: unione + validazione struttura
    if "salary_spend_by_month" in filtered:
        if not isinstance(filtered["salary_spend_by_month"], dict):
            raise HTTPException(status_code=400, detail="salary_spend_by_month non valido")
        merged = {**team.get("salary_spend_by_month", {}), **filtered["salary_spend_by_month"]}
        try:
            filtered["salary_spend_by_month"] = spesa_stipendi(**merged).model_dump()
        except ValidationError:
            raise HTTPException(status_code=400, detail="salary_spend_by_month non valido")
    if not filtered:
        return team
    # Modifica
    filtered["updated_at"] = iso(now_utc())
    await db.teams.update_one({"id": team_id}, {"$set": filtered})
    # Storico Modifiche
    t = await db.teams.find_one({"id": team_id}, {"_id": 0})
    diff = {k: {"from": team.get(k), "to": t.get(k)} for k in filtered if k != "updated_at" and team.get(k) != t.get(k)}
    diff_str = format_diff_message(diff)
    if diff_str != False:
        if is_president:
            await audit(user, "team", team_id, "updated", diff, f"Il presidente ha modificato i dati {diff_str} della società {t.get('name')}")
        else:
            await audit(user, "team", team_id, "updated", diff, f"La società {t.get('name')} ha modificato i propri dati {diff_str}")
    # Se è stato il presidente, notifica ai proprietari:
    if is_president:
        users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], "La Presidenza ha modificato la tua società", f"/squadra/{team_id}")  
    # Se è stato modificato lo stadio aggiorna composizioni rosa:
    if t.get("stadium_capacity") != team.get("stadium_capacity"):
        await update_dati_generali_composizione_rosa(team_id)
    # Ritorno
    return t

# Crea una FantaSquadra, solo il presidente può farlo, con i seguenti attributi (nota che non esistono ancora giocatori associati):
# id, created_at, updated_at, name, manager_name, president_name, motto, organigramma, color_1, color_2, color_3, image, stadium_name,
# stadium_capacity, vs, bdg_trasferimenti, bdg_stipendi, u_liberi, captain_id, vice_captain_id, vs_var, aspettativa_stagionale, 
# roster_value_summer, roster_value_current, bdgt_dilazionato_30giu, utili, stadium_capacity_by_month, salary_spend_by_month
@router.post("/teams")
async def create_team(data: TeamIn, president=Depends(require_president)):
    # Import
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(status_code=404, detail="ERRORE GRAVE DI SISTEMA")
    # Controlli
    name = data.name
    if await db.teams.find_one({"name": name}):
        raise HTTPException(status_code=400, detail="Nome già utilizzato")
    # Creazione
    doc = data.model_dump()
    doc.update({"id": new_id(), "created_at": iso(now_utc()), "updated_at": iso(now_utc())})
    await db.teams.insert_one(doc)
    # Creazione dei documenti di composizione rosa iniziali
    await init_comp_rosa_per_nuova_squadra(doc["id"], season)
    # Storico modifiche
    await audit(president, "team", doc.get("id"), "created", {"name": doc["name"]}, f"Il presidente ha creato la società {doc['name']}")
    # Ritorno
    doc.pop("_id", None)
    return doc