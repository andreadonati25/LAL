from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import TypeAdapter, EmailStr, ValidationError

from database import db
from models import ChangePasswordIn, LoginIn, RegisterIn
from security import (
    clear_auth_cookies,
    get_current_user,
    hash_pw,
    make_access,
    make_refresh,
    require_president,
    set_auth_cookies,
    verify_pw,
)
from utils import audit, iso, new_id, now_utc, format_diff_message

router = APIRouter()
email_adapter = TypeAdapter(EmailStr)

# ---------- Auth Routes ----------
# Crea un utente, solo il presidente può farlo, con i seguenti attributi:
# id, email, password_hash, name, role, team_id, created_at, updated_at
@router.post("/auth/register")
async def register_user(data: RegisterIn, president=Depends(require_president)):
    # Controlli
    email = data.email.lower().strip()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email già registrata")
    if data.team_id:
        team = await db.teams.find_one({"id": data.team_id})
        if not team:
            raise HTTPException(404, "Squadra non trovata") 
    # Creazione
    user_doc = {
        "id": new_id(),
        "email": email,
        "password_hash": hash_pw(data.password),
        "name": data.name,
        "role": "utente",
        "team_id": data.team_id,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc())
    }
    await db.users.insert_one(user_doc)
    # Storico modifiche
    await audit(president, "user", user_doc["id"], "created", {"email": user_doc["email"], "name": user_doc["name"]}, f"Il presidente ha creato l'utente {user_doc['name']}")
    # Ritorno
    user_doc.pop("password_hash", None)
    user_doc.pop("_id", None)
    return user_doc

# Modifica un utente (non il presidente), il presidente può modificare tutti gli utenti nei campi: email, name, team_id.
# Un utente può modificare solo sè stesso nei campi: email, name.
@router.patch("/users/{user_id}")
async def patch_user(user_id: str, patch: dict, user=Depends(get_current_user)):
    # Controlli
    target = await db.users.find_one({"id": user_id}, {"password_hash": 0, "_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User non trovato")
    if target.get("role") == "presidente":
        raise HTTPException(status_code=400, detail="Il presidente non può essere modificato")
    is_president = user["role"] == "presidente"
    is_himself = user.get("id") == user_id
    if is_president:
        allowed = {"email", "name", "team_id"}
    elif is_himself:
        allowed = {"email", "name"}
    else:
        raise HTTPException(status_code=403, detail="Non puoi modificare un altro utente")
    filtered = {k: v for k, v in patch.items() if k in allowed}
    if "email" in filtered:
        filtered["email"] = filtered["email"].lower().strip()
        try:
            email_adapter.validate_python(filtered["email"])
        except ValidationError:
            raise HTTPException(status_code=400, detail="Email non valida")
        if await db.users.find_one({"email": filtered["email"], "id": {"$ne": user_id}}):
            raise HTTPException(status_code=400, detail="Email già registrata")
    if "name" in filtered:
        if not isinstance(filtered["name"], str) or not filtered["name"]:
            raise HTTPException(status_code=400, detail="Nome non valido")
    if "team_id" in filtered and filtered["team_id"] is not None:
        if not isinstance(filtered["team_id"], str):
            raise HTTPException(status_code=400, detail="team_id deve essere una stringa")
        if not await db.teams.find_one({"id": filtered["team_id"]}):
                raise HTTPException(status_code=404, detail="FantaSquadra non trovata")
    if not filtered:
        return target
    # Modifica
    filtered["updated_at"] = iso(now_utc())
    await db.users.update_one({"id": user_id}, {"$set": filtered})
    # Storico modifiche
    u = await db.users.find_one({"id": user_id}, {"password_hash": 0, "_id": 0})
    diff = {k: {"from": target.get(k), "to": u.get(k)} for k in filtered if k != "updated_at" and target.get(k) != u.get(k)}
    diff_str = format_diff_message(diff)
    if diff_str != False:
        if is_president:
            await audit(user, "user", user_id, "updated", diff, f"Il presidente ha modificato i dati {diff_str} di {u.get('name')}")
        else:
            await audit(user, "user", user_id, "updated", diff, f"{u.get('name')} ha modificato i propri dati {diff_str}")
    # Ritorno
    return u

# Cambio password
@router.post("/auth/change-password")
async def change_password(data: ChangePasswordIn, user=Depends(get_current_user)):
    # Controlli
    full = await db.users.find_one({"id": user["id"]})
    if not full:
        raise HTTPException(404, "Utente non trovato")
    is_president = user["role"] == "presidente"
    if is_president:
        raise HTTPException(status_code=400, detail="Il presidente non può essere modificato")
    if not verify_pw(data.old_password, full["password_hash"]):
        raise HTTPException(400, "Password corrente non corretta")
    # Modifica
    await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": hash_pw(data.new_password), "updated_at": iso(now_utc())}})
    # Storico modifiche.
    await audit(user, "user", user["id"], "password_changed", {}, f"{user.get('name')} ha modificato la propria password")
    return {"ok": True}

# Elimina un utente, solo il presidente può farlo.
@router.delete("/users/{user_id}")
async def delete_user(user_id: str, president=Depends(require_president)):
    # Controlli
    user = await db.users.find_one({"id": user_id}, {"password_hash": 0, "_id": 0})
    if not user:
        raise HTTPException(404, "Utente non trovato")
    if user.get("role") == "presidente":
        raise HTTPException(status_code=400, detail="Il presidente non può essere eliminato")
    # Eliminazione
    await db.users.delete_one({"id": user_id})
    # Storico modifiche
    await audit(president, "user", user_id, "deleted", {}, f"Il presidente ha eliminato l'utente {user.get('name')}")
    # Ritorno
    return {"ok": True}

# Login
@router.post("/auth/login")
async def login(data: LoginIn, response: Response):
    email = data.email.lower().strip()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenziali non valide")
    access = make_access(user["id"], user["email"], user["role"])
    refresh = make_refresh(user["id"])
    set_auth_cookies(response, access, refresh)
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user["role"], "team_id": user.get("team_id"),
    }

# Logout
@router.post("/auth/logout")
async def logout(response: Response, user=Depends(get_current_user)):
    clear_auth_cookies(response)
    return {"ok": True}

# Informazioni sull'utente corrente.
@router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user["role"], "team_id": user.get("team_id"),
    }

## Ottieni utenti. Solo il presidente può fare questa operazione.
@router.get("/users")
async def list_users(president=Depends(require_president)):
    users = await db.users.find({}, {"password_hash": 0, "_id": 0}).sort('name', 1).to_list(None)
    return users

