from fastapi import APIRouter, Depends, HTTPException

from database import db
from models import CommuniqueIn
from routers.notifications import add_notification
from security import get_current_user, optional_user
from utils import iso, new_id, now_utc

router = APIRouter()

# Qui no audit perché i comunicati non sono influenzanti sul mondo LAL: rimangono elemento di folklore

# ---------- Communiques (Bacheca) ----------
# Crea un comunicato con i seguenti attributi:
# team_id, title, body, pinned, id, team_name, author_id, author_name, created_at, updated_at
@router.post("/communiques")
async def create_communique(data: CommuniqueIn, user=Depends(get_current_user)):
    # Controlli
    is_president = user["role"] == "presidente"
    if is_president:
        if data.team_id is not None:
            raise HTTPException(403, "Il presidente può pubblicare solo comunicati della Presidenza")
    else:
        is_owner = user.get("team_id") is not None and user.get("team_id") == data.team_id
        if not is_owner:
            raise HTTPException(403, "Puoi pubblicare solo per la tua squadra")
        if data.pinned:
            raise HTTPException(403, "Non puoi mettere in evidenza un comunicato")    
    # Creazione
    doc = data.model_dump()
    if is_president:
        team_name = None
    else:
        team = await db.teams.find_one({"id": data.team_id}, {"_id": 0, "name": 1})
        if team:
            team_name = team.get("name")
        else:
            raise HTTPException(status_code=404, detail="Squadra non trovata")
    doc.update({"id": new_id(), "team_name": team_name, "author_id": user["id"], "author_name": user["name"],
                "created_at": iso(now_utc()), "updated_at": iso(now_utc())})
    await db.communiques.insert_one(doc)
    # Notifica a tutti gli altri utenti:
    users_not_me = await db.users.find({"id": {"$ne": user["id"]}}, {"id": 1, "_id": 0}).to_list(None)
    for u in users_not_me:
        if team_name:
            await add_notification(u["id"], f"Nuovo comunicato da parte della società {team_name}", f"/bacheca?id={doc.get('id')}")
        else:
            await add_notification(u["id"], "Nuovo comunicato da parte della Presidenza", f"/bacheca?id={doc.get('id')}")
    # Ritorno
    doc.pop("_id", None)
    return doc
    
# Modifica un comunicato, solo presidente e user della squadra: solo title, body e pinned possono essere modificati.
@router.patch("/communiques/{comm_id}")
async def patch_communique(comm_id: str, patch: dict, user=Depends(get_current_user)):
    # Controlli 
    comm = await db.communiques.find_one({"id": comm_id})
    if not comm:
        raise HTTPException(404, "Comunicato non trovato")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == comm["team_id"]
    if is_president:
        allowed = {"title", "body", "pinned"}
    elif is_owner:
        allowed = {"title", "body"}
    else:
        raise HTTPException(403, "Non autorizzato")
    filtered = {k: v for k, v in patch.items() if k in allowed}
    for f in {"title", "body"} & filtered.keys():
        if not isinstance(filtered[f], str) or not filtered[f]:
            raise HTTPException(status_code=400, detail=f"{filtered[f]} non valido")
    if "pinned" in filtered and not isinstance(filtered["pinned"], bool):
        raise HTTPException(status_code=400, detail=f"{filtered['pinned']} non valido")
    # Modifiche
    filtered["updated_at"] = iso(now_utc())
    await db.communiques.update_one({"id": comm_id}, {"$set": filtered})
    # Se è stato il presidente, notifica all'autore:
    if is_president:
        await add_notification(comm.get('author_id'), f"Il tuo comunicato {comm.get('title')} è stato modificato dalla Presidenza", f"/bacheca?id={comm_id}")
    # Ritorno
    c = await db.communiques.find_one({"id": comm_id}, {"_id": 0})
    return c

# Elimina un comunicato, solo presidente e user della squadra.
@router.delete("/communiques/{comm_id}")
async def delete_communique(comm_id: str, user=Depends(get_current_user)):
    # Controlli
    comm = await db.communiques.find_one({"id": comm_id})
    if not comm:
        raise HTTPException(404, "Comunicato non trovato")
    is_president = user["role"] == "presidente"
    is_owner = user.get("team_id") is not None and user.get("team_id") == comm["team_id"]
    if not is_president and not is_owner:
        raise HTTPException(403, "Non autorizzato")
    # Eliminazione
    await db.communiques.delete_one({"id": comm_id})
    # Se è stato il presidente, notifica all'autore:
    if is_president and comm.get('author_id') != user["id"]:
        await add_notification(comm.get('author_id'), f"Il tuo comunicato {comm.get('title')} è stato eliminato dalla Presidenza", "/bacheca")
    # Ritorno
    return {"ok": True}

# Ottiene i 100 comunicati più recenti
@router.get("/communiques")
async def list_communiques(limit: int = 100, user=Depends(optional_user)):
    coms = await db.communiques.find({}, {"_id": 0}).sort([
        ("pinned", -1),
        ("created_at", -1),
    ]).limit(limit).to_list(limit)
    return coms