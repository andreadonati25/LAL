import logging
from datetime import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException

from database import db
from utils import audit, iso, new_id, now_utc, format_diff_message, format_scadenza
from routers.notifications import add_notification
from security import get_current_user, optional_user, require_president
from business import compute_mese_prec
from models import ComposizioneRosaIn

router = APIRouter()
logger = logging.getLogger("lalega")

MESI_COMPOSIZIONE_ROSA = ["luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
                          "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno"]
SEZIONI_LISTA = ["prima_squadra", "primavera", "tribuna", "academy", "estero", "in_prestito"]
LIMITI_RUOLO_PRIMA_SQUADRA = {"P": 3, "D": 8, "C": 8, "A": 6}

# Ritorna in formato datetime la data v
def _parse_confine(v: str, nome_campo: str) -> datetime:
    if v is None:
        return v
    return datetime.fromisoformat(v.replace("Z", "+00:00"))

# Ritorna la finestra di scadenze in date_composizione_rosa in cui siamo
def obtain_finestra_composizione(season: dict, now: datetime = None) -> tuple[str, str, str, str]:
    if now is None:
        now = now_utc()
    dcr = season["date_composizione_rosa"]
    dcr_dt = {k: _parse_confine(v, k) for k, v in dcr.items()}
    # Now è nell'intervallo tra i due dcr.get(...) allora va salvata la rosa sul mese specificato inizialmente [COMPOSIZIONE IN VIGORE]
    finestre = [
        ("luglio", dcr.get("luglio"), dcr.get("agosto"), "agosto"),                     # su luglio, dcr.get(agosto) e su agosto, dcr.get(inizio_stagione) [luglio, dcr.get(agosto)]
        ("agosto", dcr.get("agosto"), dcr.get("inizio_stagione"), "inizio_stagione"),   # su agosto, dcr.get(inizio_stagione) [agosto, dcr.get(inizio_stagione)] 
        ("settembre",dcr.get("inizio_stagione"), dcr.get("settembre"), "settembre"),    # su settembre, dcr.get(settembre) e su settembre, dcr.get(asta_estiva) [agosto, dcr.get(inizio_stagione)] 
        ("settembre",dcr.get("settembre"), dcr.get("asta_estiva"), "asta_estiva"),      # su settembre, dcr.get(asta_estiva) [settembre, dcr.get(settembre)]
        ("ottobre", dcr.get("asta_estiva"), dcr.get("ottobre"), "ottobre"),             # su ottobre, dcr.get(ottobre) [settembre, dcr.get(asta_estiva)]
        ("novembre", dcr.get("ottobre"), dcr.get("novembre"), "novembre"),              # su novembre, dcr.get(novembre) [ottobre, dcr.get(ottobre)]
        ("dicembre", dcr.get("novembre"), dcr.get("dicembre"), "dicembre"),             # su dicembre, dcr.get(dicembre) [novembre, dcr.get(novembre)]
        ("gennaio", dcr.get("dicembre"), dcr.get("gennaio"), "gennaio"),                # su gennaio, dcr.get(gennaio) [dicembre, dcr.get(dicembre)]
        ("febbraio", dcr.get("gennaio"), dcr.get("febbraio"), "febbraio"),              # su febbraio, dcr.get(febbraio) e su febbraio, dcr.get(asta_invernale) [gennaio, dcr.get(gennaio)]
        ("febbraio", dcr.get("febbraio"), dcr.get("asta_invernale"), "asta_invernale"), # su febbraio, dcr.get(asta_invernale) [febbraio, dcr.get(febbraio)]
        ("marzo", dcr.get("asta_invernale"), dcr.get("marzo"), "marzo"),                # su marzo, dcr.get(marzo) [febbraio, dcr.get(asta_invernale)]
        ("aprile", dcr.get("marzo"), dcr.get("aprile"), "aprile"),                      # su aprile, dcr.get(aprile) [marzo, dcr.get(marzo)]
        ("maggio", dcr.get("aprile"), dcr.get("maggio"), "maggio"),                     # su maggio, dcr.get(maggio) [aprile, dcr.get(aprile)]
        ("giugno", dcr.get("maggio"), dcr.get("giugno"), "giugno"),                     # su giugno, dcr.get(giugno) [maggio, dcr.get(maggio)]
    ]

    for target, prec_str, scadenza_str, nome_campo in finestre:
        if not scadenza_str:
            logger.warning(f"'{nome_campo}' non ancora impostato in date_composizione_rosa: supponiamo non sia ancora arrivato")
            return target, prec_str, scadenza_str, nome_campo
        if now < dcr_dt[nome_campo]:
            return target, prec_str, scadenza_str, nome_campo
    return "giugno", dcr.get("maggio"), dcr.get("giugno"), "post_giugno"                # su giugno, dcr.get(giugno) [giugno, dcr.get(giugno)]

# Ottiene gli id dei giocatori ordinati per cartellino e nome
async def _ids_players_ordinati(query: dict) -> List[str]:
        players = await db.players.find(query, {"_id": 0, "id": 1}).sort([("cartellino", -1), ("name", 1)]).to_list(None)
        return [p["id"] for p in players]

# Invio della composizione rosa mensile
async def submit_composizione_rosa(team_id: str, data: ComposizioneRosaIn, user=Depends(get_current_user)):
    # Import
    season = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    SQUADRE_SERIE_A = season["squadre_serie_a"]
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == team_id
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    academy_ids_list = await _ids_players_ordinati({"fanta_team_id": team_id, "tier": "academy"})
    in_presito_ids_list = await _ids_players_ordinati({"fanta_team_id": team_id, "current_team_id": {"$ne": team_id}, "tier": {"$ne": "academy"}})
    estero_ids_list = await _ids_players_ordinati({"current_team_id": team_id, "real_club": {"$nin": SQUADRE_SERIE_A}, "tier": {"$ne": "academy"}})
    idonei_ids_list = await _ids_players_ordinati({"current_team_id": team_id, "real_club": {"$in": SQUADRE_SERIE_A}, "tier": {"$ne": "academy"}})
    idonei_ids_set = set(idonei_ids_list)
    tutti_inviati = data.prima_squadra + data.primavera + data.tribuna
    inviati_set = set(tutti_inviati)
    if len(tutti_inviati) != len(inviati_set):
        raise HTTPException(400, "Un giocatore non può comparire in più di una sezione")
    mancanti = idonei_ids_set - inviati_set
    non_idonei = inviati_set - idonei_ids_set
    if mancanti or non_idonei:
        dettaglio = {}
        if mancanti:
            dettaglio["mancanti"] = sorted(mancanti)
        if non_idonei:
            dettaglio["non_idonei"] = sorted(non_idonei)
        raise HTTPException(400, f"La composizione deve includere tutti e soli i giocatori idonei: {dettaglio}")
    # Capitano non in primavera
    if team.get("captain_id") and team["captain_id"] in data.primavera:
        raise HTTPException(400, "Il capitano non può essere inserito in Primavera")
    # Massimo 2 over-23 in primavera
    if data.primavera:
        primavera_players = await db.players.find({"id": {"$in": data.primavera}}, {"_id": 0, "id": 1, "birth_year": 1}).to_list(None)
        over23 = [p for p in primavera_players if season["season_start_year"] - p.get("birth_year") > 23]
        if len(over23) > 2:
            raise HTTPException(400, f"Massimo 2 giocatori over-23 in Primavera, trovati {len(over23)}")
    # Massimo 3P/8D/8C/6A in Prima Squadra
    if data.prima_squadra:
        prima_squadra_players = await db.players.find({"id": {"$in": data.prima_squadra}}, {"_id": 0, "id": 1, "role": 1}).to_list(None)
        conteggio = {"P": 0, "D": 0, "C": 0, "A": 0}
        for p in prima_squadra_players:
            conteggio[p.get("role")] += 1
        eccessi = {ruolo: conteggio[ruolo] for ruolo, limite in LIMITI_RUOLO_PRIMA_SQUADRA.items() if conteggio[ruolo] > limite}
        if eccessi:
            raise HTTPException(400, f"Superato il limite di giocatori per ruolo in Prima Squadra: {eccessi} (limiti: {LIMITI_RUOLO_PRIMA_SQUADRA})")
    # Salvataggio
    target, prec_str, scadenza_str, nome_campo = obtain_finestra_composizione(season)
    doc = {
        "prima_squadra": data.prima_squadra,
        "primavera": data.primavera,
        "tribuna": data.tribuna,
        "academy": academy_ids_list,
        "estero": estero_ids_list,
        "in_prestito": in_presito_ids_list,
        "updated_at": iso(now_utc()),
    }
    await db.composizioni_rosa.update_one({"team_id": team_id, "mese": target, "scadenza": scadenza_str}, {"$set": doc})
    if target == "luglio":
        await db.composizioni_rosa.update_one({"team_id": team_id, "mese": "agosto", "scadenza": season["date_composizione_rosa"].get("inizio_stagione")}, {"$set": doc})
    if target == "settembre" and nome_campo == "settembre":
        await db.composizioni_rosa.update_one({"team_id": team_id, "mese": "settembre", "scadenza": season["date_composizione_rosa"].get("asta_estiva")}, {"$set": doc})
    if target == "febbraio" and nome_campo == "febbraio":
        await db.composizioni_rosa.update_one({"team_id": team_id, "mese": "febbraio", "scadenza": season["date_composizione_rosa"].get("asta_invernale")}, {"$set": doc})
    # Modifica ai dati: liste cambiate -> stipendi cambiati
    await update_dati_generali_composizione_rosa(team_id)
    # Storico Modifiche
    if is_president:
        extra = f"La Presidenza ha inviato la composizione rosa mensile per {target}, con scadenza {format_scadenza(scadenza_str)}, per la società {team.get('name')}"
    else:
        extra = f"La società {team.get('name')} ha inviato la composizione rosa mensile per {target}, con scadenza {format_scadenza(scadenza_str)}"
    await audit(user, "composizione_rosa", team_id, "updated", {"mese": target, "scadenza": scadenza_str}, extra)
    # Notifica se è stato il presidente
    if is_president:
        users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], f"La Presidenza ha aggiornato la composizione rosa della tua squadra per {target}", f"/squadra/{team_id}")
    # Ritorno
    return doc

# Invio della composizione rosa mensile attuale
async def submit_composizione_rosa_attuale(team_id: str, data: ComposizioneRosaIn, user=Depends(require_president)):
    # Import
    season = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    SQUADRE_SERIE_A = season["squadre_serie_a"]
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    is_president = user["role"] == "presidente"
    if not is_president:
        raise HTTPException(403, "Non autorizzato")
    academy_ids_list = await _ids_players_ordinati({"fanta_team_id": team_id, "tier": "academy"})
    in_presito_ids_list = await _ids_players_ordinati({"fanta_team_id": team_id, "current_team_id": {"$ne": team_id}, "tier": {"$ne": "academy"}})
    estero_ids_list = await _ids_players_ordinati({"current_team_id": team_id, "real_club": {"$nin": SQUADRE_SERIE_A}, "tier": {"$ne": "academy"}})
    idonei_ids_list = await _ids_players_ordinati({"current_team_id": team_id, "real_club": {"$in": SQUADRE_SERIE_A}, "tier": {"$ne": "academy"}})
    idonei_ids_set = set(idonei_ids_list)
    tutti_inviati = data.prima_squadra + data.primavera + data.tribuna
    inviati_set = set(tutti_inviati)
    if len(tutti_inviati) != len(inviati_set):
        raise HTTPException(400, "Un giocatore non può comparire in più di una sezione")
    mancanti = idonei_ids_set - inviati_set
    non_idonei = inviati_set - idonei_ids_set
    if mancanti or non_idonei:
        dettaglio = {}
        if mancanti:
            dettaglio["mancanti"] = sorted(mancanti)
        if non_idonei:
            dettaglio["non_idonei"] = sorted(non_idonei)
        raise HTTPException(400, f"La composizione deve includere tutti e soli i giocatori idonei: {dettaglio}")
    # Capitano non in primavera
    if team.get("captain_id") and team["captain_id"] in data.primavera:
        raise HTTPException(400, "Il capitano non può essere inserito in Primavera")
    # Massimo 2 over-23 in primavera
    if data.primavera:
        primavera_players = await db.players.find({"id": {"$in": data.primavera}}, {"_id": 0, "id": 1, "birth_year": 1}).to_list(None)
        over23 = [p for p in primavera_players if season["season_start_year"] - p.get("birth_year") > 23]
        if len(over23) > 2:
            raise HTTPException(400, f"Massimo 2 giocatori over-23 in Primavera, trovati {len(over23)}")
    # Massimo 3P/8D/8C/6A in Prima Squadra
    if data.prima_squadra:
        prima_squadra_players = await db.players.find({"id": {"$in": data.prima_squadra}}, {"_id": 0, "id": 1, "role": 1}).to_list(None)
        conteggio = {"P": 0, "D": 0, "C": 0, "A": 0}
        for p in prima_squadra_players:
            conteggio[p.get("role")] += 1
        eccessi = {ruolo: conteggio[ruolo] for ruolo, limite in LIMITI_RUOLO_PRIMA_SQUADRA.items() if conteggio[ruolo] > limite}
        if eccessi:
            raise HTTPException(400, f"Superato il limite di giocatori per ruolo in Prima Squadra: {eccessi} (limiti: {LIMITI_RUOLO_PRIMA_SQUADRA})")
    # Salvataggio
    target, prec_str, scadenza_str, nome_campo = obtain_finestra_composizione(season)
    doc = {
        "prima_squadra": data.prima_squadra,
        "primavera": data.primavera,
        "tribuna": data.tribuna,
        "academy": academy_ids_list,
        "estero": estero_ids_list,
        "in_prestito": in_presito_ids_list,
        "updated_at": iso(now_utc()),
    }
    mese_prec = compute_mese_prec(target)
    if nome_campo in ["agosto", "inizio_stagione", "post_giugno"]:
        new_target = target
        new_due = scadenza_str
    elif nome_campo in ["asta_estiva", "asta_invernale"]:
        new_target = target
        new_due = prec_str
    else:
        new_target = mese_prec
        new_due = prec_str
    await db.composizioni_rosa.update_one({"team_id": team_id, "mese": new_target, "scadenza": new_due}, {"$set": doc})
    # Modifica ai dati: liste cambiate -> stipendi cambiati
    await update_dati_generali_composizione_rosa(team_id)
    # Storico Modifiche
    extra = f"La Presidenza ha inviato la composizione rosa mensile per {new_target}, con scadenza {format_scadenza(new_due)}, per la società {team.get('name')}"
    await audit(user, "composizione_rosa", team_id, "updated", {"mese": new_target, "scadenza": new_due}, extra)
    # Notifica
    users = await db.users.find({"team_id": team_id}, {"id": 1, "_id": 0}).to_list(None)
    for u in users:
        await add_notification(u["id"], f"La Presidenza ha aggiornato la composizione rosa della tua squadra per {new_target}", f"/squadra/{team_id}")
    # Ritorno
    return doc

@router.post("/teams/{team_id}/roster-next")
async def save_next_roster(team_id: str, data: ComposizioneRosaIn, user=Depends(get_current_user)):
    return await submit_composizione_rosa(team_id, data, user)

@router.post("/teams/{team_id}/roster-now")
async def save_this_roster(team_id: str, data: ComposizioneRosaIn, user=Depends(require_president)):
    return await submit_composizione_rosa_attuale(team_id, data, user)

# Ritorna il documento di composizione rosa prossimo per una squadra,
async def prossima_composizione(team_id: str, season: dict):
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    target, prec_str, scadenza_str, nome_campo = obtain_finestra_composizione(season)
    doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": target, "scadenza": scadenza_str}, {"_id": 0})
    if not doc:
        raise HTTPException(404, f"Composizione rosa di {target} della società {team.get('name')} non trovata")
    return doc

@router.get("/teams/{team_id}/roster-next")
async def get_next_roster(team_id: str, user=Depends(optional_user)):
    season = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    composition = await prossima_composizione(team_id, season)
    sections = {section: composition.get(section, []) for section in SEZIONI_LISTA}
    player_ids = list({player_id for ids in sections.values() for player_id in ids})
    players = await db.players.find({"id": {"$in": player_ids}}, {"_id": 0}).to_list(None)
    players_by_id = {player["id"]: player for player in players}
    target, _, _, _ = obtain_finestra_composizione(season)
    return {
        "target": target,
        "season_start_year": season.get("season_start_year"),
        "sections": {
            section: [players_by_id[player_id] for player_id in ids if player_id in players_by_id]
            for section, ids in sections.items()
        },
        "captain_id": composition.get("captain_id"),
        "vice_captain_id": composition.get("vice_captain_id"),
    }

# Ritorna il documento di composizione rosa attualmente in vigore per una squadra,
async def composizione_in_vigore(team_id: str, season: dict):
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    target, prec_str, scadenza_str, nome_campo = obtain_finestra_composizione(season)
    mese_prec = compute_mese_prec(target)
    if nome_campo in ["agosto", "inizio_stagione", "post_giugno"]:
        doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": target, "scadenza": scadenza_str}, {"_id": 0})
        if not doc:
            raise HTTPException(404, f"Composizione rosa di {target} della società {team.get('name')} non trovata")
        return doc
    elif nome_campo in ["asta_estiva", "asta_invernale"]:
        doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": target, "scadenza": prec_str}, {"_id": 0})
        if not doc:
            raise HTTPException(404, f"Composizione rosa di {target} della società {team.get('name')} non trovata")
        return doc
    else:
        doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": mese_prec, "scadenza": prec_str}, {"_id": 0})
        if not doc:
            raise HTTPException(404, f"Composizione rosa di {mese_prec} della società {team.get('name')} non trovata")
        return doc

# Ritorna le liste di giocatori della composizione rosa richiesta
async def lists_players_comp(team_id: str, mese: str, scadenza: str) -> dict:
    # Controlli
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    composizione_rosa = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": mese, "scadenza": scadenza}, {"_id": 0})
    if not composizione_rosa:
        raise HTTPException(404, f"Composizione rosa di {mese} della società {team.get('name')} non trovata")
    data = {
        "prima_squadra": composizione_rosa.get("prima_squadra"),
        "primavera": composizione_rosa.get("primavera"),
        "tribuna": composizione_rosa.get("tribuna"),
        "academy": composizione_rosa.get("academy"),
        "estero": composizione_rosa.get("estero"),
        "in_prestito": composizione_rosa.get("in_prestito"),
    }
    # Ritorno
    return data

# Calcola la spesa stipendi data di un documento specifico
async def compute_spesa_stipendi_mensile(team_id: str, mese: str, scadenza: str) -> float:
    data = await lists_players_comp(team_id, mese, scadenza)
    ids_pagabili = []
    for sezione in ("prima_squadra", "tribuna", "estero", "in_prestito"):
        ids_pagabili.extend(data[sezione])
    spesa_stipendi = 0.0
    async for p in db.players.find(
        {"id": {"$in": ids_pagabili}, "paying_team_id": team_id},
        {"_id": 0, "effective_salary": 1}
    ):
        spesa_stipendi += p.get("effective_salary") or 0
    # Ritorno
    return round(spesa_stipendi / 10, 2)

# Crea i documenti di composizione rosa del mese - usata alla scadenza di un reminder
async def create_comp_rosa(team_id: str, mese: str, season: dict):
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    dcr = season["date_composizione_rosa"]
    mese_prec = compute_mese_prec(mese)
    scad_prec = dcr.get(mese_prec)
    if mese_prec == "agosto":
        scad_prec = dcr.get("inizio_stagione")
    if mese_prec == "settembre":
        scad_prec = dcr.get("asta_estiva")
    if mese_prec == "febbraio":
        scad_prec = dcr.get("asta_invernale")
    # Controllo e ottengo i dati del mese passato
    data = await lists_players_comp(team_id, mese_prec, scad_prec)
    await db.composizioni_rosa.insert_one({
        "id": new_id(),
        "team_id": team_id,
        "mese": mese,
        "scadenza": dcr.get(mese),
        "prima_squadra": data["prima_squadra"],
        "primavera": data["primavera"],
        "tribuna": data["tribuna"],
        "academy": data["academy"],
        "estero": data["estero"],
        "in_prestito": data["in_prestito"],
        "captain_id": team.get("captain_id"),
        "vice_captain_id": team.get("vice_captain_id"),
        "roster_value_current": team.get("roster_value_current"),
        "stadium_capacity": 0,
        "salary_spend": 0.0,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    })
    if mese == "settembre":
        # Creiamo anche il secondo di settembre
        await db.composizioni_rosa.insert_one({
            "id": new_id(),
            "team_id": team_id,
            "mese": mese,
            "scadenza": dcr.get("asta_estiva"),
            "prima_squadra": data["prima_squadra"],
            "primavera": data["primavera"],
            "tribuna": data["tribuna"],
            "academy": data["academy"],
            "estero": data["estero"],
            "in_prestito": data["in_prestito"],
            "captain_id": team.get("captain_id"),
            "vice_captain_id": team.get("vice_captain_id"),
            "roster_value_current": team.get("roster_value_current"),
            "stadium_capacity": 0,
            "salary_spend": 0.0,
            "created_at": iso(now_utc()),
            "updated_at": iso(now_utc()),
        })
    if mese == "febbraio":
        # Creiamo anche il secondo di settembre
        await db.composizioni_rosa.insert_one({
            "id": new_id(),
            "team_id": team_id,
            "mese": mese,
            "scadenza": dcr.get("asta_invernale"),
            "prima_squadra": data["prima_squadra"],
            "primavera": data["primavera"],
            "tribuna": data["tribuna"],
            "academy": data["academy"],
            "estero": data["estero"],
            "in_prestito": data["in_prestito"],
            "captain_id": team.get("captain_id"),
            "vice_captain_id": team.get("vice_captain_id"),
            "roster_value_current": team.get("roster_value_current"),
            "stadium_capacity": 0,
            "salary_spend": 0.0,
            "created_at": iso(now_utc()),
            "updated_at": iso(now_utc()),
        })
    # Update dati
    await update_dati_generali_composizione_rosa(team_id)
    # Ritorno
    return {"ok": True}

# Documento vuoto di composizione rosa per una squadra appena creata
def _empty_comp_doc(team: dict, mese: str, scadenza: str) -> dict:
    return {
        "id": new_id(),
        "team_id": team.get("id"),
        "mese": mese,
        "scadenza": scadenza,
        "prima_squadra": [],
        "primavera": [],
        "tribuna": [],
        "academy": [],
        "estero": [],
        "in_prestito": [],
        "captain_id": team.get("captain_id"),
        "vice_captain_id": team.get("vice_captain_id"),
        "roster_value_current": team.get("roster_value_current"),
        "stadium_capacity": team.get("stadium_capacity"),
        "salary_spend": 0.0,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }

# Ritorna la lista di (mese, scadenza) dei documenti attivi (in vigore + editabile/i) in questo momento
async def documenti_attivi(season: dict) -> list:
    dcr = season["date_composizione_rosa"]
    target, prec_str, scadenza_str, nome_campo = obtain_finestra_composizione(season)
    mese_prec = compute_mese_prec(target)
    if nome_campo == "agosto":
        coppie = [(target, scadenza_str), ("agosto", dcr.get("inizio_stagione"))]
    elif nome_campo in ["inizio_stagione", "post_giugno"]:
        coppie = [(target, scadenza_str)]
    elif nome_campo == "settembre":
        coppie = [(mese_prec, prec_str), (target, scadenza_str), ("settembre", dcr.get("asta_estiva"))]
    elif nome_campo == "febbraio":
        coppie = [(mese_prec, prec_str), (target, scadenza_str), ("febbraio", dcr.get("asta_invernale"))]
    elif nome_campo in ["asta_estiva", "asta_invernale"]:
        coppie = [(target, prec_str), (target, scadenza_str)]
    else:
        coppie = [(mese_prec, prec_str), (target, scadenza_str)]
    return coppie

# Crea i documenti di composizione rosa (vuoti) corretti per una squadra
# appena creata, rispetto al momento esatto della stagione in cui viene creata.
async def init_comp_rosa_per_nuova_squadra(team_id: str, season: dict):
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    coppie = await documenti_attivi(season)
    for mese, scadenza in coppie:
        await db.composizioni_rosa.insert_one(_empty_comp_doc(team, mese, scadenza))
    # Ritorno
    return {"ok": True}

# Aggiorna i dati del team sulle composizioni rosa in vigore e future
async def update_dati_generali_composizione_rosa(team_id: str):
    if not team_id:
        return
    # Import
    season = await db.season_settings.find_one({"current": True}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    coppie = await documenti_attivi(season)
    for mese, scadenza in coppie:
        # Calcolo della spesa stipendi
        salary_spend = await compute_spesa_stipendi_mensile(team_id, mese, scadenza)
        # Salvataggio
        await db.composizioni_rosa.update_one({"team_id": team_id, "mese": mese, "scadenza": scadenza}, {"$set": {
            "captain_id": team.get("captain_id"),
            "vice_captain_id": team.get("vice_captain_id"),
            "roster_value_current": team.get("roster_value_current"),
            "stadium_capacity": team.get("stadium_capacity"),
            "salary_spend": salary_spend,
            "updated_at": iso(now_utc()),
        }})
    # Ritorno
    return {"ok": True}

# Rimuove un giocatore da qualunque sezione lo contenga, nei documenti attivi di una squadra
async def rimuovi_da_composizione(team_id: str, player_id: str, season: dict):
    if not team_id:
        return
    coppie = await documenti_attivi(season)
    pull = {sezione: player_id for sezione in SEZIONI_LISTA}
    for mese, scadenza in coppie:
        await db.composizioni_rosa.update_one(
            {"team_id": team_id, "mese": mese, "scadenza": scadenza},
            {"$pull": pull, "$set": {"updated_at": iso(now_utc())}}
        )
    return {"ok": True}

# Inserisce un giocatore in una sezione specifica, nei documenti attivi di una squadra
async def assegna_a_composizione(team_id: str, player_id: str, season: dict):
    if not team_id:
        raise HTTPException(400, "Squadra non idonea") 
    coppie = await documenti_attivi(season)
    for mese, scadenza in coppie:
        sezione = await sezione_default_ingresso(player_id, team_id, mese, scadenza, season)
        await db.composizioni_rosa.update_one(
            {"team_id": team_id, "mese": mese, "scadenza": scadenza},
            {"$addToSet": {sezione: player_id}, "$set": {"updated_at": iso(now_utc())}}
        )
    return {"ok": True}

# Sezione di default per un giocatore che diventa idoneo in UN documento specifico:
# primavera se c'è spazio over-23 in quel documento, altrimenti tribuna.
async def sezione_default_ingresso(player_id: str, team_id: str, mese: str, scadenza: str, season: dict) -> str:
    p = await db.players.find_one({"id": player_id}, {"_id": 0})
    if not p:
        raise Exception(f"Giocatore {player_id} non trovato")
    if not p.get("current_team_id"):
        raise HTTPException(400, "Giocatore non idoneo") 
    if p.get("tier") == "academy":
        return "academy"
    elif p.get("fanta_team_id") == team_id and p.get("current_team_id") != team_id:
        return "in_prestito"
    elif p.get("current_team_id") == team_id and p.get("real_club") not in season["squadre_serie_a"]:
        return "estero"
    elif p.get("current_team_id") == team_id:
        is_over23 = season["season_start_year"] - p.get("birth_year") > 23
        if not is_over23:
            return "primavera"
        doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": mese, "scadenza": scadenza}, {"_id": 0, "primavera": 1})
        primavera_ids = doc.get("primavera", []) if doc else []
        over23_count = 0
        if primavera_ids:
            pls = await db.players.find({"id": {"$in": primavera_ids}}, {"_id": 0, "birth_year": 1}).to_list(None)
            over23_count = sum(1 for pl in pls if season["season_start_year"] - pl.get("birth_year") > 23)
        return "primavera" if over23_count < 2 else "tribuna"
    else:
        raise HTTPException(400, "Giocatore non idoneo") 

# Corregge la sezione di un giocatore nei documenti attivi dopo una modifica (di role o birth_year e nomina capitano).
# Non tocca nulla se la scelta esistente è ancora valida.
async def correggi_composizione_se_necessaria(player_id: str, season: dict):
    p = await db.players.find_one({"id": player_id}, {"_id": 0, "current_team_id": 1, "birth_year": 1, "role": 1})
    if not p or not p.get("current_team_id"):
        return
    team_id = p.get("current_team_id")
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata") 
    coppie = await documenti_attivi(season)
    for mese, scadenza in coppie:
        doc = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": mese, "scadenza": scadenza}, {"_id": 0})
        if not doc:
            continue
        invalido = False
        if player_id in doc.get("primavera", []):
            is_over23 = season["season_start_year"] - p.get("birth_year") > 23
            if is_over23:
                pls = await db.players.find({"id": {"$in": doc.get("primavera", [])}}, {"_id": 0, "birth_year": 1}).to_list(None)
                over23_count = sum(1 for pl in pls if season["season_start_year"] - pl.get("birth_year") > 23)
                if over23_count > 2:
                    invalido = True
            is_capitano = team.get("captain_id") == player_id
            if is_capitano:
                invalido = True
        elif player_id in doc.get("prima_squadra", []):
            pls = await db.players.find({"id": {"$in": doc.get("prima_squadra", [])}}, {"_id": 0, "role": 1}).to_list(None)
            conteggio = {"P": 0, "D": 0, "C": 0, "A": 0}
            for pl in pls:
                conteggio[pl.get("role")] += 1
            if conteggio.get(p.get("role"), 0) > LIMITI_RUOLO_PRIMA_SQUADRA.get(p.get("role"), 0):
                invalido = True
        if invalido:
            await db.composizioni_rosa.update_one(
                {"team_id": team_id, "mese": mese, "scadenza": scadenza},
                {"$pull": {"primavera": player_id, "prima_squadra": player_id},
                 "$addToSet": {"tribuna": player_id},
                 "$set": {"updated_at": iso(now_utc())}}
            )
    return {"ok": True}

# Salva i dati della composizione finale del mese sul file del team
async def save_data_team(team_id: str, mese: str, season: dict):
    team = await db.teams.find_one({"id": team_id}, {"_id": 0})
    if not team:
        raise HTTPException(404, "Squadra non trovata")
    salary_spend = team.get("salary_spend_by_month")
    stadium_capacity = team.get("stadium_capacity_by_month")
    dcr = season["date_composizione_rosa"]
    # Compute coppie (mese_documento, scadenza) da archiviare
    if mese == "luglio":
        coppie = [(mese, dcr.get("agosto"))]
    elif mese == "agosto":
        coppie = [(mese, dcr.get("inizio_stagione"))]
    elif mese == "settembre":
        coppie = [(mese, dcr.get("asta_estiva"))]
    elif mese == "febbraio":
        coppie = [(mese, dcr.get("asta_invernale"))]
    else:
        coppie = [(mese, dcr.get(mese))]
    for mese_doc, scad in coppie:
        comp = await db.composizioni_rosa.find_one({"team_id": team_id, "mese": mese_doc, "scadenza": scad})
        if not comp:
            raise HTTPException(404, f"Composizione rosa di {mese_doc} della società {team.get('name')} non trovata")
        salary_spend[mese_doc] = comp.get("salary_spend") * 1000000
        stadium_capacity[mese_doc] = comp.get("stadium_capacity")
    patch = {
        "salary_spend_by_month": salary_spend,
        "stadium_capacity_by_month": stadium_capacity,
        "updated_at": iso(now_utc()),
    }
    await db.teams.update_one({"id": team_id}, {"$set": patch})
    # Ritorno
    return {"ok": True}

