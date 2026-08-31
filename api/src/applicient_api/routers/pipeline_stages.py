"""M5 follow-up — CRUD + reorder for the user-customizable pipeline
stage list. Thin wrappers over pipeline_stage_service.py, same shape
as routers/credentials.py."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import pipeline_stage_service, schemas
from applicient_api.deps import current_user_id, get_db

router = APIRouter(prefix="/pipeline-stages", tags=["pipeline-stages"])


@router.get("", response_model=list[schemas.PipelineStageOut])
def list_stages(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return pipeline_stage_service.list_stages(db, user_id=user_id)


@router.post("", response_model=schemas.PipelineStageOut, status_code=201)
def create_stage(
    body: schemas.PipelineStageCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    if not body.display_name.strip():
        raise HTTPException(422, "display_name is required")
    stage = pipeline_stage_service.create_stage(db, user_id=user_id, display_name=body.display_name)
    db.commit()
    return stage


@router.patch("/{stage_id}", response_model=schemas.PipelineStageOut)
def rename_stage(
    stage_id: uuid.UUID,
    body: schemas.PipelineStageRename,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    if not body.display_name.strip():
        raise HTTPException(422, "display_name is required")
    try:
        stage = pipeline_stage_service.rename_stage(
            db, user_id=user_id, stage_id=stage_id, display_name=body.display_name
        )
    except pipeline_stage_service.PipelineStageNotFoundError:
        raise HTTPException(404, "pipeline stage not found")
    db.commit()
    return stage


@router.delete("/{stage_id}", status_code=204)
def delete_stage(stage_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    try:
        pipeline_stage_service.delete_stage(db, user_id=user_id, stage_id=stage_id)
    except pipeline_stage_service.PipelineStageNotFoundError:
        raise HTTPException(404, "pipeline stage not found")
    except pipeline_stage_service.StageInUseError as exc:
        raise HTTPException(409, f"cannot delete '{exc.stage.display_name}' — {exc.in_use_count} application(s) currently use it")
    db.commit()


@router.post("/reorder", response_model=list[schemas.PipelineStageOut])
def reorder_stages(
    body: schemas.PipelineStageReorder, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    try:
        stages = pipeline_stage_service.reorder_stages(db, user_id=user_id, ordered_ids=body.stage_ids)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return stages
