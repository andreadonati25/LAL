import calendar
import math
from datetime import datetime, timedelta, timezone, time
from typing import Optional
from zoneinfo import ZoneInfo
from fastapi import HTTPException

from database import db
from utils import iso, now_utc

ITALY = ZoneInfo("Europe/Rome")

MESE_NUMERO = {
    "luglio": 7, "agosto": 8, "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12,
    "gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6,
}

# 7: "luglio", 8: "agosto", ...
MESE_NOME_DA_NUMERO = {v: k for k, v in MESE_NUMERO.items()}

# Ritorna 24 ore da data.
def compute_24_hours(data: str, ore: int = 24) -> str:
    try:
        start = datetime.fromisoformat(data.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Non una data valida")
    return iso(start + timedelta(hours=ore))

# Calcola la scadenza del reminder alle 24:00 del giorno successivo alla fine del contratto.
def compute_contract_termination_due(data: str) -> str:
    try:
        parsed = datetime.fromisoformat(data.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Non una data valida")
    contract_date = parsed.astimezone(ITALY).date() if parsed.tzinfo else parsed.date()
    due_date = datetime.combine(contract_date + timedelta(days=2), time.min, tzinfo=ITALY)
    return iso(due_date.astimezone(timezone.utc))

# Ripartizione economica di uno svincolo.
def compute_release_amounts(transfermarkt_value: float, valore_base_ridotto: float):
    porzione_attuale = min(valore_base_ridotto, transfermarkt_value)
    eccesso = max(0.0, valore_base_ridotto - transfermarkt_value)
    return porzione_attuale, eccesso * 0.75, eccesso * 0.25

# Ritorna la porzione di contratto onorata fino ad oggi
def compute_years_in_team(contract_start: Optional[str]) -> Optional[float]:
    if not contract_start:
        return None
    try:
        start_dt = datetime.fromisoformat(contract_start.replace("Z", "+00:00"))
    except ValueError:
        return None
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=timezone.utc)
    now_dt = now_utc()
    days = (now_dt - start_dt).days
    if days < 0:
        # Contratto non ancora iniziato (data futura): nessuna porzione onorata.
        days = 0
    years_int = days // 365
    remainder = days % 365
    half_year_bonus = 0.5 if remainder >= 182 else 0.0
    one_month_after_start = add_months(start_dt, 1)
    extra_half = 0.0 if one_month_after_start >= now_dt else 0.5
    return years_int + half_year_bonus + extra_half

# Helper per il terzo termine della formula: replica DATA.MESE(data; mesi) di Excel.
def add_months(dt_utc: datetime, months: int) -> datetime:
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=ZoneInfo("UTC"))
    local_dt = dt_utc.astimezone(ITALY)
    month = local_dt.month - 1 + months
    year = local_dt.year + month // 12
    month = month % 12 + 1
    day = min(local_dt.day, calendar.monthrange(year, month)[1])
    new_local_dt = local_dt.replace(year=year, month=month, day=day)
    return new_local_dt.astimezone(ZoneInfo("UTC"))

# Restituisce il sottoinsieme di campi che uno svincolo deve resettare
def release_player_patch(serie_a: bool) -> dict:
    if serie_a:
        tier = "utilizzabile"
    else:
        tier = "altrove" 
    return {
        "tier": tier,
        "fanta_team_id": None,
        "current_team_id": None,
        "paying_team_id": None,
        "jersey_number": None,
        "renewal_count": 0,
        "purchase_price": 0,
        "contract_years": 0,
        "contract_start": None,
        "first_contract_start": None,
    }

# Calcola roster_value_current
async def compute_roster_value_current(team_id: str) -> float:
    total = 0.0
    async for pl in db.players.find({"fanta_team_id": team_id, "tier": {"$ne": "academy"}}, {"_id": 0, "transfermarkt_value": 1}):
        total += float(pl.get("transfermarkt_value") or 0)
    return total

# Calcola cartellino giocatore
def compute_cartellino(tm: float, fv: int) -> int:
    """Cartellino = media tra valore e fantavalore, arrotondata al M più vicino (0.5 → per eccesso)."""
    return int(math.floor((float(tm or 0) + int(fv or 1)) / 2 + 0.5))

# Calcola stipendio giocatore
def compute_effective_salary(salary_base: float, renewals: int) -> float:
    """Stipendio = base * (1 + 0.2 * rinnovi), 1 decimale."""
    return round(float(salary_base or 0) * (1 + 0.2 * int(renewals or 0)), 1)

# Calcola data fine contratto
def compute_contract_end(contract_years: int, contract_start: Optional[str]) -> Optional[str]:
    if not contract_start:
        return None
    years = int(contract_years or 0)
    if years < 0:
        years = 0
    try:
        start_dt = datetime.fromisoformat(contract_start.replace("Z", "+00:00"))
    except ValueError:
        return None
    target_year = start_dt.year + years
    try: 
        end_dt = start_dt.replace(year=target_year)
    except ValueError:
        last_day = calendar.monthrange(target_year, start_dt.month)[1]
        end_dt = start_dt.replace(year=target_year, day=min(start_dt.day, last_day))
    if "T" in contract_start:
        return end_dt.isoformat()
    return end_dt.date().isoformat()

# Data di default per un mese di date_composizione_rosa
def compute_default_mese_date(mese: str, season_start_year: int) -> str:
    numero = MESE_NUMERO[mese]
    anno = season_start_year if numero >= 7 else season_start_year + 1
    if numero == 1:
        dt = datetime(anno, numero, 2, tzinfo=ITALY).astimezone(timezone.utc)
    else:
        dt = datetime(anno, numero, 1, tzinfo=ITALY).astimezone(timezone.utc)
    return iso(dt)

# Ritorna il mese precedente in stringa
def compute_mese_prec(mese: str) -> str:
    num_prec = MESE_NUMERO[mese] - 1
    if num_prec == 0:
        num_prec = 12
    return MESE_NOME_DA_NUMERO[num_prec]

# Ritorna il mese succ in stringa
def compute_mese_succ(mese: str) -> str:
    num_prec = MESE_NUMERO[mese] + 1 
    if num_prec == 13:
        num_prec = 1
    return MESE_NOME_DA_NUMERO[num_prec]