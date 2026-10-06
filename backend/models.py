from typing import List, Dict, Optional, Literal
from pydantic import BaseModel, Field, EmailStr

# ---------- Models ----------
Role = Literal["presidente", "utente"]
PlayerTier = Literal["utilizzabile", "academy", "altrove"]
PlayerRole = Literal["P", "D", "C", "A"]
ReminderEntities = Literal["player", "team", "reminder", "season", "transfer"]
PossiblesStadiumWorks = Literal[-20_000, -10_000, -5_000, -2_000, -1_000, 0, 1_000, 2_000, 5_000, 10_000, 50_000, 100_000]
MovementTipo = Literal["definitivo", "prestito_secco", "prestito_diritto", "prestito_obbligo"]
PaymentTipo = Literal["now", "data"]

# -------------------------------
# Spostamento di un giocatore all'interno di un transfer
class MovementIn(BaseModel):
    player_id: str
    from_team_id: Optional[str] = None
    to_team_id: str
    tipo: MovementTipo
    purchase_price: int = Field(default=0, ge=0)
    cifra_riscatto: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    paying_team_id: Optional[str] = None   # solo prestiti: chi paga lo stipendio durante il prestito; default to_team_id
    loan_due_date: Optional[str] = None    # obbligatoria se tipo è un prestito

# Spostamento di denaro all'interno di un transfer
class PaymentIn(BaseModel):
    amount: float = Field(gt=0, allow_inf_nan=False)
    tipo: PaymentTipo
    due_date: Optional[str] = None
    paid_by_team_id: str
    paid_to_team_id: str

# Modello per le clausole libere
class ClausolaLiberaIn(BaseModel):
    testo: str
    due_date: Optional[str] = None

# Modello per i bonus di base
class BonusIn(BaseModel):
    player_id: str
    metrica: Literal["gol", "assist", "bonus", "presenze"]
    soglia: int = Field(gt=0)
    ambito: Literal["stagione", "totale"]
    maglia: Literal["fantasquadra", "generale"]
    amount: float = Field(gt=0, allow_inf_nan=False)
    paid_by_team_id: str
    paid_to_team_id: str

# Trasferimento tra due squadre (o da Svincolati verso una squadra)
class TransferIn(BaseModel):
    team_a_id: Optional[str] = None
    team_b_id: str
    movements: List[MovementIn] = Field(default_factory=list)
    payments: List[PaymentIn] = Field(default_factory=list)
    bonus: List[BonusIn] = Field(default_factory=list)
    clausole_libere: List[ClausolaLiberaIn] = Field(default_factory=list)

# Modifica in blocco dei numeri di maglia
class JerseyNumbersIn(BaseModel):
    numbers: Dict[str, Optional[int]]
    
# Lavori allo stadio
class StadiumWorkIn(BaseModel):
    stadium_work: PossiblesStadiumWorks

# Liste dei giocatori per le composizioni rosa
class ComposizioneRosaIn(BaseModel):
    prima_squadra: List[str] = Field(default_factory=list)
    primavera: List[str] = Field(default_factory=list)
    tribuna: List[str] = Field(default_factory=list)

# Scadenze per le composizioni rosa
class CompRoseScadenze(BaseModel):
    luglio: Optional[str] = None
    agosto: Optional[str] = None
    settembre: Optional[str] = None
    ottobre: Optional[str] = None
    novembre: Optional[str] = None
    dicembre: Optional[str] = None
    gennaio: Optional[str] = None
    febbraio: Optional[str] = None
    marzo: Optional[str] = None
    aprile: Optional[str] = None
    maggio: Optional[str] = None
    giugno: Optional[str] = None
    inizio_stagione: Optional[str] = None
    asta_estiva: Optional[str] = None
    asta_invernale: Optional[str] = None

# Impostazioni di sistema per la stagione corrente
class SeasonSettingsIn(BaseModel):
    season_start_year: int
    squadre_serie_a: List[str]
    date_composizione_rosa: CompRoseScadenze = Field(default_factory=CompRoseScadenze)

# Classe di un giocatore.
class PlayerIn(BaseModel):
    name: str
    birth_year: int
    image: Optional[str] = None
    role: PlayerRole
    real_club: str = "Svincolato"
    salary: float = 0.0
    transfermarkt_value: float = 0.1
    fantavalore: int = 1
    cartellino: int = 1
    tier: PlayerTier = "utilizzabile"
    fanta_team_id: Optional[str] = None 
    current_team_id: Optional[str] = None 
    paying_team_id: Optional[str] = None 
    jersey_number: Optional[int] = None
    renewal_count: int = 0 
    effective_salary: float = 0.0
    purchase_price: int = 0
    contract_years: int = 0
    contract_start: Optional[str] = None
    contract_end: Optional[str] = None
    first_contract_start: Optional[str] = None
    
# Classe ausiliaria per variazione VS.
class VSVar(BaseModel):
    trofeo: float = 0
    rosa: float = 0
    stadio: float = 0
    capitano: float = 0

# Classe ausiliaria per Utili.
class Utili(BaseModel):
    trofeo: float = 0
    mercato: float = 0
    stadio: float = 0
    merchandising: float = 0
    broadcasting: float = 0

# Classe ausiliaria per spesa stipendi.
class spesa_stipendi(BaseModel):
    luglio: float = 0
    agosto: float = 0
    settembre: float = 0
    ottobre: float = 0
    novembre: float = 0
    dicembre: float = 0
    gennaio: float = 0
    febbraio: float = 0
    marzo: float = 0
    aprile: float = 0
    maggio: float = 0
    giugno: float = 0

# Classe ausiliaria per capienza stadio.
class capienza_stadio(BaseModel):
    luglio: int = 5000
    agosto: int = 5000
    settembre: int = 5000
    ottobre: int = 5000
    novembre: int = 5000
    dicembre: int = 5000
    gennaio: int = 5000
    febbraio: int = 5000
    marzo: int = 5000
    aprile: int = 5000
    maggio: int = 5000
    giugno: int = 5000

# Classe di una FantaSquadra.
class TeamIn(BaseModel):
    name: str
    manager_name: Optional[str] = None
    president_name: Optional[str] = None
    motto: Optional[str] = None
    organigramma: Optional[str] = None
    color_1: Optional[str] = "#6B21A8"
    color_2: Optional[str] = "#9333EA"
    color_3: Optional[str] = "#D4AF37"
    image: Optional[str] = None
    stadium_name: Optional[str] = None
    stadium_capacity: int = 5000
    vs: float = 1_000_000_000
    bdg_trasferimenti: float = 1_000_000_000
    bdg_stipendi: float = 150_000_000
    u_liberi: float = 50_000_000
    captain_id: Optional[str] = None
    vice_captain_id: Optional[str] = None
    vs_var: VSVar = Field(default_factory=VSVar)
    aspettativa_stagionale: int = 0
    roster_value_summer: float = 0
    roster_value_current: float = 0
    bdgt_dilazionato_30giu: float = 0
    utili: Utili = Field(default_factory=Utili)
    stadium_capacity_by_month: capienza_stadio = Field(default_factory=capienza_stadio)
    salary_spend_by_month: spesa_stipendi = Field(default_factory=spesa_stipendi)

# Reminder
class ReminderIn(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[str] = None 
    team_id: Optional[str] = None
    entity: Optional[ReminderEntities] = None
    entity_id: Optional[str] = None
    kind: Optional[str] = None
    stadium_work: PossiblesStadiumWorks = 0
    transfer_id: Optional[str] = None

# Comunicato
class CommuniqueIn(BaseModel):
    team_id: Optional[str] = None
    title: str
    body: str
    pinned: bool = False

# Per il cambio password
class ChangePasswordIn(BaseModel):
    old_password: str = Field(min_length=6)
    new_password: str = Field(min_length=6)

# Per il login.
class LoginIn(BaseModel):
    email: EmailStr
    password: str
    
# Per registrazione utente
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    name: str
    team_id: Optional[str] = None