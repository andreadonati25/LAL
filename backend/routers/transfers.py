from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import Optional

from database import db
from models import TransferIn, MovementIn, PaymentIn, BonusIn, ClausolaLiberaIn, ReminderIn
from security import get_current_user, require_president, optional_user
from utils import audit, iso, new_id, now_utc
from business import add_months, compute_roster_value_current
from routers.notifications import add_notification
from routers.reminders import add_reminder
from routers.monthly import rimuovi_da_composizione, assegna_a_composizione, update_dati_generali_composizione_rosa

router = APIRouter()
ITALY = ZoneInfo("Europe/Rome")

PLACEHOLDER_DATE = iso(datetime(1999, 12, 31, tzinfo=ITALY).astimezone(timezone.utc))

STATUS_ORDER = {"proposto": 0, "confermato": 1, "convalidato": 2, "eseguito": 3, "annullato": 4}

CONTENT_KEYS = ("movements", "payments", "bonus", "clausole_libere")

# Controlli sulle date per transfer
def _normalize_future_date(value: Optional[str], label: str, now: datetime, minimum: Optional[datetime] = None) -> Optional[str]:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(400, f"{label} non è una data valida")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if parsed <= now:
        raise HTTPException(400, f"{label} deve essere futura")
    if minimum and parsed < minimum:
        raise HTTPException(400, "Un prestito deve durare almeno 6 mesi")
    return iso(parsed)

# Controlli sul payload di patch e create transfer.
async def _validate_transfer_payload(payload: dict, exclude_transfer_id: Optional[str] = None) -> None:
    team_a_id, team_b_id = payload["team_a_id"], payload["team_b_id"]
    if team_a_id == team_b_id:
        raise HTTPException(400, "Le due squadre devono essere diverse")
    if not await db.teams.find_one({"id": team_b_id}):
        raise HTTPException(404, "Squadra ricevente non trovata")
    if team_a_id is not None and not await db.teams.find_one({"id": team_a_id}):
        raise HTTPException(404, "Squadra cedente non trovata")

    movements = payload["movements"]
    payments = payload["payments"]
    bonus = payload["bonus"]
    clauses = payload["clausole_libere"]
    if not movements and not payments and not bonus and not clauses:
        raise HTTPException(400, "Il trasferimento è vuoto")
    if not movements and team_a_id is None:
        raise HTTPException(400, "Un trasferimento senza giocatori non può coinvolgere gli Svincolati")
    if team_a_id is None and (payments or bonus or clauses):
        raise HTTPException(400, "Un'assegnazione non ha attributi particolari")

    now = now_utc()
    min_loan_date = add_months(now, 6)
    active_query = {"status": {"$in": ["proposto", "confermato", "convalidato"]}}
    if exclude_transfer_id:
        active_query["id"] = {"$ne": exclude_transfer_id}
    active_transfers = await db.transfers.find(active_query, {"movements.player_id": 1, "_id": 0}).to_list(None)
    players_with_active_transfer = {
        movement["player_id"]
        for active_transfer in active_transfers
        for movement in active_transfer.get("movements", [])
        if movement.get("player_id")
    }
    movement_player_ids = set()
    for movement in movements:
        player_id = movement["player_id"]
        if player_id in movement_player_ids:
            raise HTTPException(400, "Un giocatore non può comparire più volte nei movimenti dello stesso trasferimento")
        movement_player_ids.add(player_id)
        if player_id in players_with_active_transfer:
            raise HTTPException(400, "Il giocatore è già coinvolto in un trasferimento non ancora eseguito")
        if movement["from_team_id"] not in (team_a_id, team_b_id, None):
            raise HTTPException(400, "from_team_id di un movimento non coerente con le squadre coinvolte")
        if movement["to_team_id"] not in (team_a_id, team_b_id):
            raise HTTPException(400, "to_team_id di un movimento non coerente con le squadre coinvolte")
        if movement["from_team_id"] == movement["to_team_id"]:
            raise HTTPException(400, "Un movimento non può avere partenza e arrivo nella stessa squadra")
        player = await db.players.find_one({"id": movement["player_id"]}, {"_id": 0})
        if not player:
            raise HTTPException(404, f"Giocatore {movement['player_id']} non trovato")
        if player.get("fanta_team_id") != movement["from_team_id"]:
            raise HTTPException(400, f"Il giocatore {player.get('name')} non è di proprietà della squadra indicata come cedente")

        is_loan = movement["tipo"] in ("prestito_secco", "prestito_diritto", "prestito_obbligo")
        has_redemption = movement["tipo"] in ("prestito_diritto", "prestito_obbligo")
        player_is_loaned = bool(player.get("current_team_id") and player.get("current_team_id") != player.get("fanta_team_id"))
        if not is_loan and player_is_loaned and movement["to_team_id"] == player["current_team_id"]:
            raise HTTPException(400, "Il giocatore in prestito non può essere ceduto definitivamente alla squadra che lo detiene")
        if not is_loan and player_is_loaned:
            loan_reminder = await db.reminders.find_one({
                "entity": "player",
                "entity_id": player_id,
                "done": False,
                "kind": {"$in": ["prestito_secco", "prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo"]},
            }, {"_id": 0, "transfer_id": 1})
            if not loan_reminder:
                raise HTTPException(400, "Prestito in corso senza reminder attivo: la cessione non è valida")
            loan_transfer = await db.transfers.find_one({"id": loan_reminder["transfer_id"]}, {"_id": 0, "movements": 1})
            if not loan_transfer or not any(item["player_id"] == player_id for item in loan_transfer.get("movements", [])):
                raise HTTPException(400, "Movimento originario del prestito non trovato")
        if is_loan and player.get("current_team_id") and player.get("current_team_id") != player.get("fanta_team_id"):
            raise HTTPException(400, "Il giocatore è già in prestito e non può essere prestato nuovamente")
        if has_redemption and movement["cifra_riscatto"] is None:
            raise HTTPException(400, "cifra_riscatto obbligatoria per prestito_diritto e prestito_obbligo")
        if not has_redemption and movement["cifra_riscatto"] is not None:
            raise HTTPException(400, "cifra_riscatto ammessa solo per prestito_diritto e prestito_obbligo")
        if is_loan:
            if movement["from_team_id"] is None:
                raise HTTPException(400, "Un prestito non può partire dagli Svincolati")
            if not movement["loan_due_date"]:
                raise HTTPException(400, "loan_due_date obbligatoria per un movimento di prestito")
            if movement["paying_team_id"] is None:
                movement["paying_team_id"] = movement["to_team_id"]
            elif movement["paying_team_id"] not in (movement["from_team_id"], movement["to_team_id"]):
                raise HTTPException(400, "paying_team_id deve essere il cedente o il detentore del prestito")
            movement["loan_due_date"] = _normalize_future_date(
                movement["loan_due_date"], "loan_due_date", now, min_loan_date
            )
        else:
            if movement["loan_due_date"] or movement["paying_team_id"]:
                raise HTTPException(400, "loan_due_date/paying_team_id ammessi solo per i prestiti")
            movement["loan_due_date"] = None
            movement["paying_team_id"] = None

    for payment in payments:
        if {payment["paid_by_team_id"], payment["paid_to_team_id"]} != {team_a_id, team_b_id}:
            raise HTTPException(400, "paid_by_team_id/paid_to_team_id di un pagamento non coerenti con le squadre coinvolte")
        if payment["tipo"] == "data":
            if not payment["due_date"]:
                raise HTTPException(400, "due_date obbligatoria per un pagamento a data fissa")
            payment["due_date"] = _normalize_future_date(payment["due_date"], "due_date", now)
        else:
            if payment["due_date"]:
                raise HTTPException(400, "due_date non ammessa per un pagamento immediato")
            payment["due_date"] = None

    movement_player_ids = {movement["player_id"] for movement in movements}
    for item in bonus:
        if {item["paid_by_team_id"], item["paid_to_team_id"]} != {team_a_id, team_b_id}:
            raise HTTPException(400, "paid_by_team_id/paid_to_team_id di un bonus non coerenti con le squadre coinvolte")
        if item["player_id"] not in movement_player_ids:
            raise HTTPException(400, "Il giocatore del bonus deve essere coinvolto in un movimento")
        if not await db.players.find_one({"id": item["player_id"]}, {"_id": 0}):
            raise HTTPException(404, f"Giocatore {item['player_id']} non trovato")

    for clause in clauses:
        clause["testo"] = clause["testo"].strip()
        if not clause["testo"]:
            raise HTTPException(400, "Il testo della clausola non può essere vuoto")
        clause["due_date"] = _normalize_future_date(clause["due_date"], "due_date", now)

# Presidente può modificare essenzialmente tutto, prima della convalida
@router.patch("/transfers/{transfer_id}")
async def patch_transfer(transfer_id: str, patch: dict, president=Depends(require_president)):
    # Controlli
    transfer = await db.transfers.find_one({"id": transfer_id})
    if not transfer:
        raise HTTPException(404, "Trasferimento non trovato")
    if transfer["status"] not in ("proposto", "confermato"):
        raise HTTPException(400, "Il trasferimento non è più modificabile in questo stato")
    filtered = {k: v for k, v in patch.items() if k in CONTENT_KEYS}
    if not filtered:
        return transfer
    try:
        payload = {
            "team_a_id": transfer["team_a_id"],
            "team_b_id": transfer["team_b_id"],
            "movements": [MovementIn(**item).model_dump() for item in filtered.get("movements", transfer.get("movements", []))],
            "payments": [PaymentIn(**item).model_dump() for item in filtered.get("payments", transfer.get("payments", []))],
            "bonus": [BonusIn(**item).model_dump() for item in filtered.get("bonus", transfer.get("bonus", []))],
            "clausole_libere": [ClausolaLiberaIn(**item).model_dump() for item in filtered.get("clausole_libere", transfer.get("clausole_libere", []))],
        }
    except ValidationError:
        raise HTTPException(400, "Dati non validi")
    await _validate_transfer_payload(payload, exclude_transfer_id=transfer_id)
    parsed = {}
    for key in CONTENT_KEYS:
        if key in filtered:
            state = {"stato": "aperta"} if key in ("bonus", "clausole_libere") else {}
            parsed[key] = [{**item, **state, "id": new_id()} for item in payload[key]]
        else:
            parsed[key] = [
                {**original, **item}
                for original, item in zip(transfer.get(key, []), payload[key])
            ]
    # Modifica
    ora = now_utc()
    ora_iso = iso(ora)
    parsed["updated_at"] = ora_iso
    parsed["status"] = "proposto"
    parsed["confirmations"] = {tid: False for tid in transfer["confirmations"]}
    await db.transfers.update_one({"id": transfer_id}, {"$set": parsed})
    t2 = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    # Storico modifiche
    await audit(president, "transfer", transfer_id, "updated", {k: True for k in filtered}, "La Presidenza ha modificato un trasferimento")
    # Notifica le squadre coinvolte
    for tid in filter(None, [transfer["team_a_id"], transfer["team_b_id"]]):
        users = await db.users.find({"team_id": tid}, {"id": 1, "_id": 0}).to_list(None)
        for u in users:
            await add_notification(u["id"], "La Presidenza ha modificato un trasferimento, conferma di nuovo", f"/trasferimenti?id={transfer_id}")
    # Ritorno
    return await db.transfers.find_one({"id": transfer_id}, {"_id": 0})

# Ottieni un trasferimento
@router.get("/transfers/{transfer_id}")
async def get_transfer(transfer_id: str, user=Depends(optional_user)):
    t = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Trasferimento non trovato")
    return t

# Ottieni i trasferimenti
@router.get("/transfers")
async def list_transfers(team_id: Optional[str] = None, status: Optional[str] = None, user=Depends(optional_user)):
    q = {}
    if team_id:
        q["$or"] = [{"team_a_id": team_id}, {"team_b_id": team_id}]
    if status:
        q["status"] = status

    cursor = db.transfers.find(q, {"_id": 0}).sort("created_at", -1)
    items = await cursor.to_list(None)
    items.sort(key=lambda t: (STATUS_ORDER.get(t["status"], 99)))
    return items

async def _genera_reminder_transfer(transfer: dict, season: dict, ora: datetime, ora_iso: str, transfer_id: str):
    team_a = await db.teams.find_one({"id": transfer["team_a_id"]}, {"_id": 0}) if transfer["team_a_id"] else None
    team_b = await db.teams.find_one({"id": transfer["team_b_id"]}, {"_id": 0})

    for pay in transfer["payments"]:
        if pay["tipo"] != "data":
            continue
        paid_by = team_a if pay["paid_by_team_id"] == transfer["team_a_id"] else team_b
        paid_to = team_b if paid_by is team_a else team_a
        desc = f"Pagamento di {pay['amount']}M dalla società {paid_by['name']} alla società {paid_to['name']}"
        nuovo = {
            "title": "Pagamento dilazionato", "description": desc, "due_date": pay["due_date"], "team_id": None,
            "entity": "transfer", "entity_id": pay["id"], "kind": "pagamento_trasferimento",
            "stadium_work": 0, "transfer_id": transfer_id,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass

    variazioni_bdgt = await _get_anchor_due_date("Variazioni automatiche budget trasferimenti")
    for b in transfer["bonus"]:
        player = await db.players.find_one({"id": b["player_id"]}, {"_id": 0, "name": 1})
        if not player or b["ambito"] != "stagione":
            continue
        paid_by = team_a if b["paid_by_team_id"] == transfer["team_a_id"] else team_b
        paid_to = team_b if paid_by is team_a else team_a
        desc = f"Pagamento di {b['amount']}M dalla società {paid_by['name']} alla società {paid_to['name']} al raggiungimento di {b['soglia']} {b['metrica']} in stagione"
        desc += " ne LA Lega" if b["maglia"] == "fantasquadra" else " in Serie A"
        nuovo = {
            "title": f"Bonus su {player['name']}", "description": desc, "due_date": variazioni_bdgt, "team_id": None,
            "entity": "transfer", "entity_id": b["id"], "kind": "bonus_misurabile",
            "stadium_work": 0, "transfer_id": transfer_id,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass

    for c in transfer["clausole_libere"]:
        if not c["due_date"]:
            continue
        nuovo = {
            "title": "Clausola libera trasferimento", "description": c["testo"], "due_date": c["due_date"], "team_id": None,
            "entity": "transfer", "entity_id": c["id"], "kind": "clausola_libera",
            "stadium_work": 0, "transfer_id": transfer_id,
        }
        try:
            await add_reminder(ReminderIn(**nuovo))
        except DuplicateKeyError:
            pass

    finestra = await _finestra_mercato_corrente(ora, season)
    if not (finestra["aperta"] or not transfer["movements"] or not transfer["team_a_id"]):
        for m in transfer["movements"]:
            from_team_name = team_a.get("name", "Svincolati") if m["from_team_id"] == transfer["team_a_id"] else (
                team_b.get("name", "Svincolati") if m["from_team_id"] == transfer["team_b_id"] else "Svincolati"
            )
            to_team_name = team_a.get("name", "Svincolati") if m["to_team_id"] == transfer["team_a_id"] else team_b.get("name", "Svincolati")
            tipo_desc = {"definitivo": "definitivo", "prestito_secco": "prestito secco", "prestito_diritto": "prestito con diritto di riscatto", "prestito_obbligo": "prestito con obbligo di riscatto"}
            desc = f"da {from_team_name} a {to_team_name} del tipo {tipo_desc[m['tipo']]}"
            nuovo = {
                "title": f"Trasferimento di {m['name']}", "description": desc,
                "due_date": finestra["prossima_apertura"], "team_id": None,
                "entity": "transfer", "entity_id": m["id"], "kind": "esecuzione_trasferimento",
                "stadium_work": 0, "transfer_id": transfer_id,
            }
            try:
                await add_reminder(ReminderIn(**nuovo))
            except DuplicateKeyError:
                pass
    return finestra

async def _esegui_movimento_prestito(m: dict, transfer_id: str, season: dict, ora_iso: str):
    p = await db.players.find_one({"id": m["player_id"]})
    patch = {
        "current_team_id": m["to_team_id"],
        "paying_team_id": m["paying_team_id"],
        "jersey_number": None,
        "updated_at": ora_iso,
    }
    await db.players.update_one({"id": p["id"]}, {"$set": patch})
    await rimuovi_da_composizione(m["from_team_id"], p["id"], season)
    await assegna_a_composizione(m["from_team_id"], p["id"], season)
    await assegna_a_composizione(m["to_team_id"], p["id"], season)
    await update_dati_generali_composizione_rosa(m["from_team_id"])
    await update_dati_generali_composizione_rosa(m["to_team_id"])
    nuovo = {
        "title": f"Termine prestito di {p.get('name')}", "description": None,
        "due_date": m["loan_due_date"], "team_id": None,
        "entity": "player", "entity_id": p["id"], "kind": m["tipo"],
        "stadium_work": 0, "transfer_id": transfer_id,
    }
    try:
        await add_reminder(ReminderIn(**nuovo))
    except DuplicateKeyError:
        pass

async def _esegui_movimento_definitivo(m: dict, season: dict, ora_iso: str):
    p = await db.players.find_one({"id": m["player_id"]})
    player_is_loaned = bool(p.get("current_team_id") and p.get("current_team_id") != p.get("fanta_team_id"))
    if player_is_loaned:
        loan_reminder = await db.reminders.find_one({
            "entity": "player",
            "entity_id": p["id"],
            "done": False,
            "kind": {"$in": ["prestito_secco", "prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo"]},
        }, {"_id": 0, "transfer_id": 1, "kind": 1})
        if not loan_reminder:
            raise HTTPException(400, "Prestito in corso senza reminder attivo: la cessione non può essere completata")
        if loan_reminder["kind"] in ("prestito_diritto", "attivazione_prestito_diritto", "prestito_obbligo"):
            loan_transfer = await db.transfers.find_one({"id": loan_reminder["transfer_id"]}, {"_id": 0})
            if not loan_transfer:
                raise HTTPException(400, "Trasferimento del prestito in corso non trovato")
            loan_movements = loan_transfer.get("movements", [])
            loan_movement = next((movement for movement in loan_movements if movement["player_id"] == p["id"]), None)
            if not loan_movement:
                raise HTTPException(400, "Movimento del prestito in corso non trovato")
            if m["to_team_id"] != p.get("current_team_id"):
                loan_movement["redemption_owner_team_id"] = m["to_team_id"]
                await db.transfers.update_one(
                    {"id": loan_transfer["id"]},
                    {"$set": {"movements": loan_movements, "updated_at": ora_iso}},
                )
    patch = {
        "fanta_team_id": m["to_team_id"],
        "current_team_id": p["current_team_id"] if player_is_loaned else m["to_team_id"],
        "paying_team_id": (
            m["to_team_id"] if p.get("paying_team_id") == p.get("fanta_team_id") else p.get("current_team_id")
        ) if player_is_loaned else m["to_team_id"],
        "contract_start": None, "first_contract_start": None,
        "contract_years": 0, "contract_end": None,
        "jersey_number": p.get("jersey_number") if player_is_loaned else None,
        "purchase_price": m["purchase_price"], "updated_at": ora_iso,
    }
    await db.players.update_one({"id": p["id"]}, {"$set": patch})
    if m["from_team_id"]:
        await rimuovi_da_composizione(m["from_team_id"], p["id"], season)
        await update_dati_generali_composizione_rosa(m["from_team_id"])
    else:
        await db.teams.update_one({"id": m["to_team_id"]},
            {"$inc": {"bdg_trasferimenti": round(-m["purchase_price"] * 1000000, 3)}, "$set": {"updated_at": ora_iso}})
    await assegna_a_composizione(m["to_team_id"], p["id"], season)
    await update_dati_generali_composizione_rosa(m["to_team_id"])
    for team_id in filter(None, [m["from_team_id"], m["to_team_id"]]):
        rvc = await compute_roster_value_current(team_id)
        await db.teams.update_one({"id": team_id}, {"$set": {"roster_value_current": rvc}})

# Esegue un Payment tra le due squadre coinvolte.
async def _esegui_payment(pay: dict, ora_iso: str):
    await db.teams.update_one({"id": pay["paid_by_team_id"]},
        {"$inc": {"bdg_trasferimenti": round(-pay["amount"] * 1000000, 3)}, "$set": {"updated_at": ora_iso}})
    await db.teams.update_one({"id": pay["paid_to_team_id"]},
        {"$inc": {"bdg_trasferimenti": round(pay["amount"] * 900000, 3), "utili.mercato": round(pay["amount"] * 100000, 3)}, "$set": {"updated_at": ora_iso}})

# Convalida un trasferimento confermato da entrambe le parti: esegue subito se il mercato è aperto,
# altrimenti lo lascia come precontratto in attesa dell'apertura della finestra successiva.
@router.post("/transfers/{transfer_id}/validate")
async def validate_transfer(transfer_id: str, president=Depends(require_president)):
    # Controlli
    transfer = await db.transfers.find_one({"id": transfer_id})
    if not transfer:
        raise HTTPException(404, "Trasferimento non trovato")
    if transfer["status"] != "confermato":
        raise HTTPException(400, "Il trasferimento deve essere confermato da entrambe le parti prima della convalida")
    season = await db.season_settings.find_one({"current": True})
    if not season:
        raise HTTPException(404, "Nessuna stagione corrente impostata")
    ora = now_utc()
    ora_iso = iso(ora)
    for m in transfer["movements"]:
        player = await db.players.find_one({"id": m["player_id"]}, {"_id": 0})
        if not player:
            raise HTTPException(404, f"Giocatore {m['player_id']} non trovato")
        if player.get("fanta_team_id") != m["from_team_id"]:
            raise HTTPException(400, f"Il giocatore {player.get('name')} non è più di proprietà della squadra cedente prevista")
        m["name"] = player.get("name")
    # Pagamento quote istantanee
    for pay in transfer["payments"]:
        if pay["tipo"] == "now":
            await _esegui_payment(pay, ora_iso)
    # Generazione reminders
    finestra = await _genera_reminder_transfer(transfer, season, ora, ora_iso, transfer_id)
    # Esecuzione o rinvio a precontratto
    eseguibile_ora = finestra["aperta"] or not transfer["movements"] or not transfer["team_a_id"]
    if eseguibile_ora:
        for m in transfer["movements"]:
            if m["tipo"] == "definitivo":
                await _esegui_movimento_definitivo(m, season, ora_iso)
            else:
                await _esegui_movimento_prestito(m, transfer["id"], season, ora_iso)
        patch = {
            "status": "eseguito", "validated_at": ora_iso, "executed_at": ora_iso,
            "window_session": finestra["session"], "window_year": season["season_start_year"], "updated_at": ora_iso,
        }
    else:
        patch = {
            "status": "convalidato", "validated_at": ora_iso,
            "window_session": finestra["session"], "window_year": season["season_start_year"], "updated_at": ora_iso
        }
    await db.transfers.update_one({"id": transfer_id}, {"$set": patch})
    await audit(president, "transfer", transfer_id, "convalidato", {}, f"La Presidenza ha {patch['status']} un trasferimento")
    # Aggiungi notifica alle squadre interessate
    teams = [tid for tid in transfer["confirmations"]]
    for t in teams:
        users = await db.users.find({"team_id": t}, {"id": 1, "_id": 0}).to_list(None)
        testo = "Trasferimento convalidato da LA Lega"
        for u in users:
            await add_notification(u["id"], testo, f"/trasferimenti?id={transfer_id}")
    t2 = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    return t2

# Ritorna il due_date di un reminder dal titolo + 1 minuto
# (None se è la placeholder) - da usare solo per i DEFAULT_TITLE
async def _get_anchor_due_date(title: str) -> Optional[str]:
    rem = await db.reminders.find_one({"title": title}, {"_id": 0, "due_date": 1}, sort=[("created_at", -1)])
    due_date = rem.get("due_date") if rem else None
    if not due_date or due_date == PLACEHOLDER_DATE:
        return None
    dt = datetime.fromisoformat(due_date.replace("Z", "+00:00"))
    return iso(dt + timedelta(minutes=1))

# Determina se il mercato è aperto ora e, se sì, in quale finestra.
# "Apertura mercato invernale" ha sempre una data (2 gennaio); le altre tre possono
# essere ancora al placeholder: in quel caso si assume che la finestra sia ancora aperta.
async def _finestra_mercato_corrente(ora: datetime, season: dict):
    chiusura_estiva = await _get_anchor_due_date("Chiusura mercato estivo")
    apertura_invernale = await _get_anchor_due_date("Apertura mercato invernale")
    chiusura_invernale = await _get_anchor_due_date("Chiusura mercato invernale")
    apertura_estiva_prossima = await _get_anchor_due_date("Apertura mercato estivo")
    if not chiusura_estiva or ora <= datetime.fromisoformat(chiusura_estiva.replace("Z", "+00:00")):
        return {"aperta": True, "session": "estiva", "prossima_apertura": None}
    if not apertura_invernale or ora < datetime.fromisoformat(apertura_invernale.replace("Z", "+00:00")):
        return {"aperta": False, "session": None, "prossima_apertura": apertura_invernale}
    if not chiusura_invernale or ora <= datetime.fromisoformat(chiusura_invernale.replace("Z", "+00:00")):
        return {"aperta": True, "session": "invernale", "prossima_apertura": None}
    return {"aperta": False, "session": None, "prossima_apertura": apertura_estiva_prossima}

# Crea una proposta di trasferimento tra due squadre (o da Svincolati verso una squadra, solo presidente).
@router.post("/transfers")
async def create_transfer(data: TransferIn, user=Depends(get_current_user)):
    # Controlli
    is_president = user["role"] == "presidente"
    doc = data.model_dump()
    await _validate_transfer_payload(doc)
    team_a = await db.teams.find_one({"id": data.team_a_id}) if data.team_a_id is not None else None
    team_b = await db.teams.find_one({"id": data.team_b_id})
    if not is_president:
        if data.team_a_id is None:
            raise HTTPException(403, "Solo il presidente può proporre un'assegnazione da Svincolati")
        if user.get("team_id") not in (data.team_a_id, data.team_b_id):
            raise HTTPException(403, "Puoi proporre solo trasferimenti che coinvolgono la tua squadra")
    # Creazione
    for m in doc["movements"]:
        if m["tipo"] in ("prestito_secco", "prestito_diritto", "prestito_obbligo") and m["paying_team_id"] is None:
            m["paying_team_id"] = m["to_team_id"]
    doc["movements"] = [{**m, "id": new_id()} for m in doc["movements"]]
    doc["payments"] = [{**p, "id": new_id()} for p in doc["payments"]]
    doc["clausole_libere"] = [{**c, "id": new_id(), "stato": "aperta"} for c in doc["clausole_libere"]]
    doc["bonus"] = [{**b, "id": new_id(), "stato": "aperta"} for b in doc["bonus"]]
    status = "proposto"
    confirmations = {data.team_b_id: False}
    if data.team_a_id is not None:
        confirmations[data.team_a_id] = False
    if not is_president and user.get("team_id") in confirmations:
        confirmations[user.get("team_id")] = True
    if is_president and data.team_a_id is None:
        confirmations[data.team_b_id] = True
        status = "confermato"
    doc.update({
        "id": new_id(),
        "status": status,
        "confirmations": confirmations,
        "origin_transfer_id": None,
        "window_year": None,
        "window_session": None,
        "proposed_by_president": is_president,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
        "validated_at": None,
        "executed_at": None,
    })
    await db.transfers.insert_one(doc)
    # Storico modifiche
    proposer_label = "La Presidenza" if is_president else (team_a if user.get("team_id") == data.team_a_id else team_b).get("name")
    await audit(user, "transfer", doc["id"], "proposto", {}, f"{proposer_label} ha proposto un trasferimento")
    # Notifiche agli utenti delle squadre interessate (+ presidente eventualmente)
    if status == "proposto":
        squadre = [tid for tid in confirmations if tid != user.get("team_id")]
        for t in squadre:
            users = await db.users.find({"team_id": t}, {"id": 1, "_id": 0}).to_list(None)
            testo = "Trasferimento proposto in attesa di tua conferma"
            for u in users:
                await add_notification(u["id"], testo, f"/trasferimenti?id={doc['id']}")
    # Ritorno
    doc.pop("_id", None)
    return doc

# Conferma un trasferimento per una delle due squadre coinvolte.
@router.post("/transfers/{transfer_id}/confirm")
async def confirm_transfer(transfer_id: str, team_id: Optional[str] = None, user=Depends(get_current_user)):
    # Controlli
    transfer = await db.transfers.find_one({"id": transfer_id})
    if not transfer:
        raise HTTPException(404, "Trasferimento non trovato")
    if transfer["status"] != "proposto":
        raise HTTPException(400, "Il trasferimento non è in attesa di conferma")
    is_president = user["role"] == "presidente"
    if is_president:
        if not team_id:
            raise HTTPException(400, "Specifica la squadra per cui confermi")
    else:
        team_id = user.get("team_id")
    if team_id not in transfer["confirmations"]:
        raise HTTPException(403, "Squadra non coinvolta in questo trasferimento")
    if transfer["confirmations"][team_id]:
        raise HTTPException(400, "Questa squadra ha già confermato")
    # Modifica
    confirmations = {**transfer["confirmations"], team_id: True}
    patch = {"confirmations": confirmations, "updated_at": iso(now_utc())}
    completo = all(confirmations.values())
    if completo:
        patch["status"] = "confermato"
    await db.transfers.update_one({"id": transfer_id}, {"$set": patch})
    # Storico modifiche
    team = await db.teams.find_one({"id": team_id}, {"_id": 0, "name": 1})
    label = f"La Presidenza per conto della società {team.get('name')}" if is_president else team.get("name")
    await audit(user, "transfer", transfer_id, "confermato", {}, f"{label} ha confermato il trasferimento")
    # Notifica le altre squadre coinvolte
    altre = [tid for tid in transfer["confirmations"] if tid != team_id]
    for altra_id in altre:
        users = await db.users.find({"team_id": altra_id}, {"id": 1, "_id": 0}).to_list(None)
        testo = "Trasferimento confermato da entrambe le parti, in attesa di convalida" if completo else f"{team.get('name')} ha confermato il trasferimento proposto"
        for u in users:
            await add_notification(u["id"], testo, f"/trasferimenti?id={transfer_id}")
    if completo and not is_president:
        presidente = await db.users.find_one({"role": "presidente"}, {"id": 1, "_id": 0})
        await add_notification(presidente["id"], "Trasferimento pronto per la convalida", f"/trasferimenti?id={transfer_id}")
    # Ritorno
    t2 = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    return t2

# Annulla un trasferimento non ancora convalidato.
@router.post("/transfers/{transfer_id}/cancel")
async def cancel_transfer(transfer_id: str, user=Depends(get_current_user)):
    # Controlli
    transfer = await db.transfers.find_one({"id": transfer_id})
    if not transfer:
        raise HTTPException(404, "Trasferimento non trovato")
    if transfer["status"] not in ("proposto", "confermato"):
        raise HTTPException(400, "Il trasferimento non può più essere annullato in questo stato")
    is_president = user["role"] == "presidente"
    if not is_president and user.get("team_id") not in transfer["confirmations"]:
        raise HTTPException(403, "Squadra non coinvolta in questo trasferimento")
    # Modifica
    update = {"status": "annullato", "updated_at": iso(now_utc())}
    if not is_president:
        confirmations = dict(transfer["confirmations"])
        confirmations[user["team_id"]] = False
        update["confirmations"] = confirmations
    await db.transfers.update_one({"id": transfer_id}, {"$set": update})
    # Storico modifiche
    label = "La Presidenza" if is_president else (await db.teams.find_one({"id": user.get("team_id")}, {"_id": 0, "name": 1})).get("name")
    await audit(user, "transfer", transfer_id, "annullato", {}, f"{label} ha annullato il trasferimento")
    # Notifica le squadre coinvolte
    for tid in transfer["confirmations"]:
        if is_president or tid != user.get("team_id"):
            users = await db.users.find({"team_id": tid}, {"id": 1, "_id": 0}).to_list(None)
            for u in users:
                await add_notification(u["id"], "Un trasferimento è stato annullato", f"/trasferimenti?id={transfer_id}")
    if not is_president and transfer["status"] == "confermato":
        presidente = await db.users.find_one({"role": "presidente"}, {"id": 1, "_id": 0})
        await add_notification(presidente["id"], "Trasferimento annullato prima della convalida", f"/trasferimenti?id={transfer_id}")
    # Ritorno
    t2 = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    return t2

# Annulla i trasferimenti relativi ad un giocatore non ancora convalidati
async def _cancel_pending_transfers_for_player(player_id: str, user: dict):
    transfers = await db.transfers.find(
        {
            "status": {"$in": ["proposto", "confermato"]},
            "movements.player_id": player_id,
        },
        {"id": 1, "_id": 0},
    ).to_list(None)
    for transfer in transfers:
        await cancel_transfer(transfer["id"], user)
    return [transfer["id"] for transfer in transfers]

async def _set_transfer_item_state(transfer_id: str, kind: str, item_id: str, expected_state: str, new_state: str, president: dict):
    field_by_kind = {"bonus_misurabile": "bonus", "clausola_libera": "clausole_libere"}
    field = field_by_kind.get(kind)
    if not field:
        raise HTTPException(404, "Tipo di elemento del trasferimento non valido")
    transfer = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    if not transfer:
        raise HTTPException(404, "Trasferimento non trovato")
    if transfer.get("status") not in ("convalidato", "eseguito"):
        raise HTTPException(400, "Puoi gestire bonus e clausole solo dopo la convalida del trasferimento")
    item = next((entry for entry in transfer.get(field, []) if entry.get("id") == item_id), None)
    if not item:
        raise HTTPException(404, "Elemento del trasferimento non trovato")
    if item.get("stato") != expected_state:
        raise HTTPException(400, f"L'elemento deve essere nello stato {expected_state}")

    await db.transfers.update_one(
        {"id": transfer_id, f"{field}.id": item_id},
        {"$set": {f"{field}.$.stato": new_state, "updated_at": iso(now_utc())}},
    )
    reminder_kind = kind
    await db.reminders.update_one(
        {"transfer_id": transfer_id, "entity_id": item_id, "kind": reminder_kind, "done": False},
        {"$set": {"done": True, "updated_at": iso(now_utc())}},
    )
    label = "il bonus" if field == "bonus" else "la clausola"
    action = f"{label}_{new_state}"
    verb = "attivato" if new_state == "attivata" else "annullato"
    movements = transfer.get("movements", [])
    movement_names = []
    for m in movements:
        player_id = m.get("player_id")
        player = await db.players.find_one({"id": player_id})
        name = player.get('name', player_id) if player else player_id
        movement_names.append(name)
    trans_desc = " · ".join(movement_names)
    await audit(
        president,
        "transfer",
        transfer_id,
        action,
        {"entity_id": item_id, "from": expected_state, "to": new_state},
        f"La Presidenza ha {verb} {label} del trasferimento {trans_desc}",
    )
    return await db.transfers.find_one({"id": transfer_id}, {"_id": 0})


@router.post("/transfers/{transfer_id}/items/{kind}/{item_id}/activate")
async def activate_transfer_item(transfer_id: str, kind: str, item_id: str, president=Depends(require_president)):
    return await _set_transfer_item_state(transfer_id, kind, item_id, "aperta", "attivata", president)


@router.post("/transfers/{transfer_id}/items/{kind}/{item_id}/deactivate")
async def deactivate_transfer_item(transfer_id: str, kind: str, item_id: str, president=Depends(require_president)):
    return await _set_transfer_item_state(transfer_id, kind, item_id, "aperta", "annullata", president)

