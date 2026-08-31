"""M5 F8.1/F8.2 — Gmail OAuth connect flow and connection CRUD.

`/gmail/connect` and `/gmail/callback` deliberately do NOT use
`Depends(current_user_id)`: Google's redirect back to `/gmail/callback`
is an unauthenticated browser navigation with no Authorization header
available, so the signed-in user is carried through the OAuth `state`
param instead (a short-lived JWT, same create_access_token/
decode_access_token auth.py already has, just a shorter TTL).
"""

import os
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from applicient_api import gmail_service, schemas
from applicient_api.auth import AuthError, create_access_token, decode_access_token
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.gmail import GmailConnection

router = APIRouter(prefix="/gmail", tags=["gmail"])

_STATE_TTL = timedelta(minutes=10)


@router.get("/connect")
def connect(user_id: uuid.UUID = Depends(current_user_id)):
    state = create_access_token(user_id, expires_delta=_STATE_TTL)
    try:
        url = gmail_service.build_authorize_url(state)
    except RuntimeError as exc:
        # GMAIL_CLIENT_ID/SECRET not configured — an operator-setup gap,
        # not something the signed-in user can fix, so surface it
        # plainly instead of a raw 500 traceback.
        raise HTTPException(503, f"Gmail integration is not configured: {exc}")
    return RedirectResponse(url)


@router.get("/callback")
async def callback(code: str, state: str, db: Session = Depends(get_db)):
    try:
        user_id = decode_access_token(state)
    except AuthError:
        raise HTTPException(400, "invalid or expired OAuth state")

    tokens = await gmail_service.exchange_code(code)
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Happens if the user has an existing grant and Google skipped
        # the consent screen despite prompt=consent (rare, but a stale
        # session cookie can do it) — nothing to store, ask them to
        # revoke access at myaccount.google.com and reconnect.
        raise HTTPException(
            400, "Google did not return a refresh token — revoke Applicient's access in your Google "
            "Account settings and try connecting again"
        )
    access_token = tokens["access_token"]
    google_email = await gmail_service.fetch_google_email(access_token)
    scopes = tokens.get("scope", "").split()

    conn = gmail_service.create_connection(
        db, user_id=user_id, google_email=google_email, refresh_token=refresh_token, scopes=scopes
    )
    await gmail_service.start_watch(db, conn)
    db.commit()

    frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:3000")
    return RedirectResponse(f"{frontend_url}/credentials?gmail=connected")


@router.get("/connections", response_model=list[schemas.GmailConnectionOut])
def list_connections(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(GmailConnection).filter_by(user_id=user_id).all()


@router.patch("/connections/{connection_id}", response_model=schemas.GmailConnectionOut)
def update_connection(
    connection_id: uuid.UUID,
    body: schemas.GmailConnectionUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    conn = db.query(GmailConnection).filter_by(id=connection_id, user_id=user_id).one_or_none()
    if conn is None:
        raise HTTPException(404, "connection not found")
    conn.scan_window_days = body.scan_window_days
    db.commit()
    db.refresh(conn)
    return conn


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    conn = db.query(GmailConnection).filter_by(id=connection_id, user_id=user_id).one_or_none()
    if conn is None:
        raise HTTPException(404, "connection not found")
    await gmail_service.disconnect(db, conn)
    db.commit()
