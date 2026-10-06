import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query

from security import get_current_user
from server import ROOT_DIR

router = APIRouter()

UPLOAD_LIMITS = {
    "team-logo": {"max_mb": 5, "content_types": {"image/png", "image/jpeg", "image/webp"}},
    "team-organigramma": {"max_mb": 10, "content_types": {"application/pdf"}},
    "player-image": {"max_mb": 5, "content_types": {"image/png", "image/jpeg", "image/webp"}},
}

@router.post("/uploads")
async def upload_file(
    category: str = Query(...),
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    limits = UPLOAD_LIMITS.get(category)
    if not limits:
        raise HTTPException(400, "Categoria di upload non valida")
    if file.content_type not in limits["content_types"]:
        raise HTTPException(400, "Tipo di file non consentito")
    contents = await file.read()
    if len(contents) > limits["max_mb"] * 1024 * 1024:
        raise HTTPException(400, f"File troppo grande (max {limits['max_mb']}MB)")
    ext = Path(file.filename).suffix
    new_name = f"{uuid.uuid4().hex}{ext}"
    dest = ROOT_DIR.parent / "data" / category / new_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(contents)
    return {"filename": f"{category}/{new_name}"}
   