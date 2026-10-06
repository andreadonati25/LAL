import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from database import db

# Dizionario di traduzione per i campi (puoi ampliarlo come preferisci)
FIELD_LABELS = {
    "team_id": "FantaSquadra",
    "name": "nome",
    "role": "ruolo",
    "birth_year": "anno di nascita", 
    "image": "immagine", 
    "real_club": "squadra reale",
    "salary": "stipendio",
    "transfermarkt_value": "valore",
    "jersey_number": "numero di maglia",
    "title": "titolo", 
    "description": "descrizione",
    "due_date": "scadenza",
    "tier": "",
    "manager_name": "allenatore",
    "president_name": "presidente", 
    "color_1": "colore principale",
    "color_2": "colore secondario",
    "color_3": "colore terziario",
    "stadium_name": "nome stadio",
    "stadium_capacity": "capacità stadio",
    "vs": "valore società",
    "bdg_trasferimenti": "budget trasferimenti",
    "bdg_stipendi": "budget stipendi",
    "u_liberi": "utili liberi",
    "vs_var": "variazione di valore società",
    "aspettativa_stagionale": "aspettativa stagionale",
    "roster_value_summer": "valore rosa post asta estiva",
    "bdgt_dilazionato_30giu": "introiti al 30/06", 
    "stadium_capacity_by_month": "capacità stadio mensile", 
    "salary_spend_by_month": "spesa stipendi mensile"
}

# ---------- Utilities ----------
# ---------- Date/Time ----------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def iso(dt: datetime) -> str:
    return dt.isoformat()

def format_scadenza(scadenza_str: str) -> str:
  # Converte la stringa ISO in datetime e sposta il fuso orario su Roma
  if not scadenza_str:
    return "ancora non determinata"
  dt_utc = datetime.fromisoformat(scadenza_str)
  dt_italia = dt_utc.astimezone(ZoneInfo("Europe/Rome"))

  # Restituisce la data formattata come GG/MM/AAAA HH:MM
  return dt_italia.strftime("%d/%m/%Y %H:%M")

# ---------- Id ----------
def new_id() -> str:
    return str(uuid.uuid4())

# ---------- Audit ----------
# Sistema di storico dei cambiamenti.
async def audit(user: dict, entity: str, entity_id: str, action: str, changes: dict = None, extra: str = ""):
    team = await db.teams.find_one({"id": user.get("team_id")}, {"_id": 0, "name": 1})
    team_name = team.get("name") if team else None
    await db.audit_log.insert_one({
        "id": new_id(),
        "at": iso(now_utc()),
        "user_id": user.get("id"), # Chi ha fatto una modifica
        "user_name": user.get("name"), # Chi ha fatto una modifica
        "user_team": team_name, # Chi ha fatto una modifica (se Presidente è null)
        "user_role": user.get("role"), # Chi ha fatto una modifica
        "entity": entity, # Cosa ha modificato (team, player, user, offer, HoF, reminders)
        "entity_id": entity_id, # Quale ha modificato
        "action": action, # Tipo di modifica (created, updated, deleted, assigned, accepted, password_changed, tranfer_executed, upload, released, renewed, signed_first_contract)
        "changes": changes or {}, # Descrizione del cambiamento
        "extra": extra,
    })

def format_diff_message(diff: dict) -> str:
    keys = list(diff.keys())
    if not keys:
        return False
    translated_fields = [FIELD_LABELS.get(k, k) for k in keys if FIELD_LABELS.get(k, k)]
    if not translated_fields:
        return False
    if len(translated_fields) == 1:
        fields_str = translated_fields[0]
    elif len(translated_fields) == 2:
        fields_str = f"{translated_fields[0]} e {translated_fields[1]}"
    else:
        fields_str = f"{', '.join(translated_fields[:-1])} e {translated_fields[-1]}"
        
    return fields_str

# True se v è un numero e non un booleano
def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)