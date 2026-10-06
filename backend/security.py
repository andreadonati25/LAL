import os
from typing import Optional

import bcrypt
import jwt
from datetime import timedelta
from fastapi import HTTPException, Request, Response
from fastapi import Depends

from database import db
from utils import now_utc

JWT_ALGO = "HS256"
ACCESS_MIN = 60 * 24  # 1 day for convenience
REFRESH_DAYS = 30

# ---------- Password ----------
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_pw(pw: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), h.encode("utf-8"))
    except Exception:
        return False

# ---------- JWT ----------
def jwt_secret() -> str:
    return os.environ["JWT_SECRET"]

# I dati di accesso dell'utente vengono trasformati in una stringa firmata (JWT) con il JWT_SECRET.
# Non sono cifrati ma solo firmati.
def make_access(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "type": "access",
        "exp": now_utc() + timedelta(minutes=ACCESS_MIN),
    }
    return jwt.encode(payload, jwt_secret(), algorithm=JWT_ALGO)

def make_refresh(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "type": "refresh",
        "exp": now_utc() + timedelta(days=REFRESH_DAYS),
    }
    return jwt.encode(payload, jwt_secret(), algorithm=JWT_ALGO)

# I due token (access e refresh) vengono salvati come cookie HttpOnly nel browser.
# secure = False perché in sviluppo non usiamo HTTPS, ma in produzione va messo a True.
def set_auth_cookies(response: Response, access: str, refresh: str):
    response.set_cookie("access_token", access, httponly=True, secure=False,
                        samesite="lax", max_age=ACCESS_MIN * 60, path="/")
    response.set_cookie("refresh_token", refresh, httponly=True, secure=False,
                        samesite="lax", max_age=REFRESH_DAYS * 86400, path="/")

def clear_auth_cookies(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")

# Questa è una dependency function di FastAPI - una route può dipendere da una funzione che viene eseguita automaticamente prima.
# Questa dependency function ritorna l'utente corrente dal token di accesso o lancia un errore.
async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Non autenticato")
    try:
        payload = jwt.decode(token, jwt_secret(), algorithms=[JWT_ALGO])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Token non valido")
        user = await db.users.find_one({"id": payload["sub"]}, {"password_hash": 0})
        if not user:
            raise HTTPException(status_code=401, detail="Utente non trovato")
        user.pop("_id", None)
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token scaduto")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token non valido")

# Questa dependency function ritorna l'utente corrente dal token di accesso
# ma se non c'è un utente non ritorna l'errore.
async def optional_user(request: Request) -> Optional[dict]:
    """Ritorna l'utente se autenticato, None se anonimo — per endpoint pubblici."""
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        return None
    try:
        payload = jwt.decode(token, jwt_secret(), algorithms=[JWT_ALGO])
        if payload.get("type") != "access":
            return None
        user = await db.users.find_one({"id": payload["sub"]}, {"password_hash": 0})
        if user:
            user.pop("_id", None)
        return user
    except Exception:
        return None

# Questa dependency function richiede che l'utente sia il Presidente.
async def require_president(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "presidente":
        raise HTTPException(status_code=403, detail="Solo il Presidente può eseguire questa azione")
    return user