from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import logging
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from database import db, client
from seed import seed_defaults

from routers import audit_log, auth, communiques, notifications, players, reminders, system, teams, monthly, dashboard, upload, season, transfers

app = FastAPI(title="LA Lega API")
app.mount("/data", StaticFiles(directory=ROOT_DIR.parent / "data"), name="data")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lalega")

# Monta ogni router di dominio sul router principale /api
api.include_router(auth.router)
api.include_router(teams.router)
api.include_router(players.router)
api.include_router(communiques.router)
api.include_router(reminders.router)
api.include_router(notifications.router)
api.include_router(audit_log.router)
api.include_router(system.router)
api.include_router(dashboard.router)
api.include_router(monthly.router)
api.include_router(upload.router)
api.include_router(season.router)
api.include_router(transfers.router)

# ---------- App wiring ----------
@api.get("/")
async def root():
    return {"app": "LA Lega", "status": "ok"}

@api.get("/health")
async def health():
    return {"ok": True}

# Monta il router FastAPI con tutte le rotte definite sopra.
app.include_router(api)

# Aggiunge il middleware CORS per consentire richieste da origini diverse (utile per lo sviluppo front-end).
cors_origins_env = os.environ.get("CORS_ORIGINS")
if not cors_origins_env:
    allowed_origins = ["http://localhost:3000"]
    logger.warning("CORS_ORIGINS non specificato nel .env: utilizzo i default locali.")
else:
    allowed_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Funzione che si esegue all'avvio del server.
@app.on_event("startup")
async def on_start():
    try:
        await db.users.create_index("email", unique=True)
        await db.users.create_index("id", unique=True)
        await db.teams.create_index("id", unique=True)
        await db.teams.create_index("name", unique=True)
        await db.players.create_index("id", unique=True)
        await db.players.create_index([("name", 1), ("birth_year", 1)], unique=True)
        await db.communiques.create_index("id", unique=True)
        await db.reminders.create_index("id", unique=True)
        await db.reminders.create_index(
            [("entity_id", 1), ("kind", 1)],
            unique=True,
            partialFilterExpression={
                "done": False,
                "entity": {"$exists": True, "$type": "string"},
            },
        )
        await db.season_settings.create_index("id", unique=True)
        await db.season_settings.create_index("season_start_year", unique=True)
        await db.season_settings.create_index(
            "current",
            unique=True,
            partialFilterExpression={"current": True},
        )
        await db.composizioni_rosa.create_index("id", unique=True)
        await db.composizioni_rosa.create_index(
            [("team_id", 1), ("mese", 1), ("scadenza", 1)],
            unique=True,
        )
    except Exception as e:
        logger.warning(f"Index setup: {e}")
    await seed_defaults()

    # vengono creati gli indici MongoDB — strutture dati che il database mantiene per velocizzare 
    # le ricerche su certi campi e, con unique=True, per impedire a livello di database che due 
    # documenti abbiano lo stesso valore in quel campo

# Funzione da eseguire solo alla chiusura del server.
@app.on_event("shutdown")
async def on_stop():
    client.close()