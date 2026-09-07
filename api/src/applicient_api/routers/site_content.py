"""Landing-page CMS (Adrian, direct: "a whole CMS where i can control
what shows up in the landing page... changing like images and whatnot
shouldnt be through commits") — see models/site_content.py's own
docstring for the two-table split. Public read (the landing page has
no auth), admin write.

Images are served back through this API rather than a public MinIO
bucket URL, same "the app is the one thing with an internet-facing
port" shape put_object's own docstring already established for
CV/interview-audio files — no separate public bucket ACL to get wrong."""

from __future__ import annotations

import uuid
from asyncio import to_thread

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_admin_user, get_db
from applicient_api.models.site_content import SiteMediaAsset, SiteSettings
from applicient_api.object_storage import delete_prefix, get_object, put_object

# Fixed, code-defined vocabulary — was one entry per web/src/app/page.tsx
# section still shown as a screenshot. Empty now that every landing-page
# section (hero, job search, CV verifier, auto-apply, pipeline tracking,
# interview practice) is an interactive mock instead — the upload/reset
# admin routes below are kept (rather than deleted outright) in case a
# future section ever goes back to a screenshot, but with no valid slot
# name they simply 404 for now. Any pre-existing SiteMediaAsset rows for
# the old slot names are harmless orphans, no longer reachable here.
SITE_MEDIA_SLOTS: list[str] = []

_MAX_IMAGE_BYTES = 5 * 1024 * 1024

router = APIRouter(tags=["site-content"])
admin_router = APIRouter(prefix="/admin/site-content", tags=["site-content", "admin"])


def _get_settings(db: Session) -> SiteSettings | None:
    return db.query(SiteSettings).first()


def _get_or_create_settings(db: Session) -> SiteSettings:
    settings = _get_settings(db)
    if settings is None:
        settings = SiteSettings()
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def _media_map(db: Session) -> dict[str, str | None]:
    assets = {a.slot: a for a in db.query(SiteMediaAsset).filter(SiteMediaAsset.object_key.isnot(None)).all()}
    return {slot: (f"/site-content/media/{slot}/image" if slot in assets else None) for slot in SITE_MEDIA_SLOTS}


@router.get("/site-content", response_model=schemas.SiteContentOut)
def get_site_content(db: Session = Depends(get_db)):
    settings = _get_settings(db)
    return schemas.SiteContentOut(demo_video_url=settings.demo_video_url if settings else None, media=_media_map(db))


@router.get("/site-content/media/{slot}/image")
def get_site_media_image(slot: str, db: Session = Depends(get_db)):
    asset = db.query(SiteMediaAsset).filter_by(slot=slot).one_or_none()
    if asset is None or asset.object_key is None:
        raise HTTPException(404, "no override uploaded for this slot — the landing page falls back to its bundled default")
    data = get_object(asset.object_key)
    return Response(content=data, media_type=asset.content_type or "image/png")


@admin_router.get("", response_model=schemas.SiteContentOut)
def admin_get_site_content(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    settings = _get_settings(db)
    return schemas.SiteContentOut(demo_video_url=settings.demo_video_url if settings else None, media=_media_map(db))


@admin_router.patch("/video", response_model=schemas.SiteContentOut)
def admin_update_video(
    body: schemas.SiteSettingsUpdate, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)
):
    settings = _get_or_create_settings(db)
    url = (body.demo_video_url or "").strip()
    settings.demo_video_url = url or None
    db.commit()
    return schemas.SiteContentOut(demo_video_url=settings.demo_video_url, media=_media_map(db))


@admin_router.post("/media/{slot}", response_model=schemas.SiteContentOut)
async def admin_upload_media(
    slot: str, file: UploadFile, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)
):
    if slot not in SITE_MEDIA_SLOTS:
        raise HTTPException(404, f"unknown slot: {slot!r}")
    content = await file.read()
    if len(content) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "image is too large; the limit is 5 MB")
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(422, "only image files are accepted for a screenshot slot")

    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "png"
    object_key = f"site-media/{slot}/{uuid.uuid4()}.{ext}"
    await to_thread(put_object, object_key, content, file.content_type or "image/png")

    asset = db.query(SiteMediaAsset).filter_by(slot=slot).one_or_none()
    old_key = asset.object_key if asset else None
    if asset is None:
        asset = SiteMediaAsset(slot=slot)
        db.add(asset)
    asset.object_key = object_key
    asset.content_type = file.content_type or "image/png"
    db.commit()

    # Best-effort cleanup of the file this one just replaced — never
    # worth failing the upload (which already succeeded and is already
    # live) over an orphaned object sitting in MinIO.
    if old_key:
        try:
            await to_thread(delete_prefix, old_key)
        except Exception:
            pass

    settings = _get_settings(db)
    return schemas.SiteContentOut(demo_video_url=settings.demo_video_url if settings else None, media=_media_map(db))


@admin_router.delete("/media/{slot}", response_model=schemas.SiteContentOut)
async def admin_reset_media(
    slot: str, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)
):
    """Reverts a slot back to the bundled default asset — not a hard
    delete of the row (kept around so re-uploading the same slot later
    is just an update, not a fresh insert)."""

    if slot not in SITE_MEDIA_SLOTS:
        raise HTTPException(404, f"unknown slot: {slot!r}")
    asset = db.query(SiteMediaAsset).filter_by(slot=slot).one_or_none()
    if asset is not None and asset.object_key is not None:
        old_key = asset.object_key
        asset.object_key = None
        asset.content_type = None
        db.commit()
        try:
            await to_thread(delete_prefix, old_key)
        except Exception:
            pass
    settings = _get_settings(db)
    return schemas.SiteContentOut(demo_video_url=settings.demo_video_url if settings else None, media=_media_map(db))
