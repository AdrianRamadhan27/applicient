"""Phase 14 (v2 plan) — the new /console dashboard home's stats."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.dashboard_service import get_dashboard_summary
from applicient_api.deps import current_user_id, get_db

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=schemas.DashboardSummaryOut)
def get_dashboard_summary_route(db: Session = Depends(get_db), user_id=Depends(current_user_id)):
    return get_dashboard_summary(db, user_id=user_id)
