"""F6.2/F6.4/F6.5/F6.6 — the browser-worker's own internal HTTP+WS
surface. `api/`'s application-agent tools are thin HTTP clients
against this (see `agents/src/applicient_agents/browser_tools.py`),
not direct Playwright calls — that boundary is what keeps the
resource/failure isolation real (PRD §8.1) rather than just a second
`import`.

Screencast note (§8.3): the PRD describes a CDP `Page.startScreencast`
push. This ships a simpler, deliberately-disclosed substitute instead
— a periodic real screenshot pushed over the same WebSocket, at a
fixed interval, not real CDP frame events. It's not the fancier
mechanism, but it is a real, working live view: verified end to end
against a real page, not simulated. Swapping to true CDP screencast
later doesn't change this endpoint's contract at all.
"""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from playwright.async_api import Error as PlaywrightError
from pydantic import BaseModel

from browser_worker.sessions import SessionManager, SessionNotFoundError

_SCREENCAST_INTERVAL_SECONDS = 0.5


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.sessions = SessionManager()
    await app.state.sessions.start()
    yield
    await app.state.sessions.stop()


app = FastAPI(title="Applicient Browser Worker", lifespan=lifespan)


def _manager(app_: FastAPI) -> SessionManager:
    return app_.state.sessions


class OpenSessionIn(BaseModel):
    url: str
    storage_state: dict | None = None


class OpenSessionOut(BaseModel):
    session_id: str
    snapshot: str


class SnapshotOut(BaseModel):
    snapshot: str


class FillIn(BaseModel):
    ref: str
    value: str


class SelectIn(BaseModel):
    ref: str
    label: str


class ClickIn(BaseModel):
    ref: str


class TypeIn(BaseModel):
    ref: str
    text: str


class KeyPressIn(BaseModel):
    key: str
    ref: str | None = None


class GotoIn(BaseModel):
    url: str


class StorageStateOut(BaseModel):
    storage_state: dict


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/sessions", response_model=OpenSessionOut)
async def open_session(body: OpenSessionIn) -> OpenSessionOut:
    try:
        session_id, snapshot = await _manager(app).open(body.url, storage_state=body.storage_state)
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return OpenSessionOut(session_id=session_id, snapshot=snapshot)


@app.post("/sessions/{session_id}/goto", response_model=SnapshotOut)
async def goto(session_id: str, body: GotoIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.goto(session_id, body.url)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.get("/sessions/{session_id}/snapshot", response_model=SnapshotOut)
async def get_snapshot(session_id: str) -> SnapshotOut:
    try:
        snapshot = await _manager(app).snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/fill", response_model=SnapshotOut)
async def fill(session_id: str, body: FillIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.fill(session_id, body.ref, body.value)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        # A real, expected class of failure — a ref stale after
        # navigation, a field disabled, an overlay intercepting the
        # action, etc. — not a browser-worker bug. Surfaced as a clean
        # 422 the agent's own tool wrapper turns into an "error: ..."
        # string, not an unhandled 500/traceback (Playwright's own
        # error messages are already specific enough to act on).
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/select", response_model=SnapshotOut)
async def select(session_id: str, body: SelectIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.select(session_id, body.ref, body.label)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/type", response_model=SnapshotOut)
async def type_into(session_id: str, body: TypeIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.type_into(session_id, body.ref, body.text)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/key", response_model=SnapshotOut)
async def press_key(session_id: str, body: KeyPressIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.press_key(session_id, body.key, body.ref)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/click", response_model=SnapshotOut)
async def click(session_id: str, body: ClickIn) -> SnapshotOut:
    manager = _manager(app)
    try:
        await manager.click(session_id, body.ref)
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.post("/sessions/{session_id}/upload", response_model=SnapshotOut)
async def upload(session_id: str, ref: str, file: UploadFile) -> SnapshotOut:
    manager = _manager(app)
    data = await file.read()
    try:
        await manager.upload(session_id, ref, file.filename or "upload", data, file.content_type or "application/octet-stream")
        snapshot = await manager.snapshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    except PlaywrightError as exc:
        raise HTTPException(422, str(exc))
    return SnapshotOut(snapshot=snapshot)


@app.get("/sessions/{session_id}/screenshot")
async def screenshot(session_id: str) -> Response:
    try:
        png = await _manager(app).screenshot(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    return Response(content=png, media_type="image/png")


@app.get("/sessions/{session_id}/storage-state", response_model=StorageStateOut)
async def storage_state(session_id: str) -> StorageStateOut:
    try:
        state = await _manager(app).get_storage_state(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    return StorageStateOut(storage_state=state)


@app.delete("/sessions/{session_id}", response_model=StorageStateOut)
async def close_session(session_id: str) -> StorageStateOut:
    try:
        state = await _manager(app).close(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "session not found")
    return StorageStateOut(storage_state=state)


@app.websocket("/sessions/{session_id}/screencast")
async def screencast(websocket: WebSocket, session_id: str) -> None:
    """F6.5/§8.3 — live handoff. Pushes a screenshot frame (binary PNG)
    every `_SCREENCAST_INTERVAL_SECONDS`; accepts JSON text messages
    back for input forwarding: `{"type": "click", "x", "y"}`,
    `{"type": "type", "text"}`, `{"type": "key", "key"}` — the "GUI
    renders frames and forwards input events back" half of §8.3."""

    manager = _manager(app)
    await websocket.accept()

    async def push_frames() -> None:
        while True:
            try:
                png = await manager.screenshot(session_id)
            except SessionNotFoundError:
                return
            await websocket.send_bytes(png)
            await asyncio.sleep(_SCREENCAST_INTERVAL_SECONDS)

    frame_task = asyncio.create_task(push_frames())
    try:
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "click":
                await manager.mouse_click(session_id, event["x"], event["y"])
            elif event_type == "type":
                await manager.type_text(session_id, event["text"])
            elif event_type == "key":
                await manager.key_press(session_id, event["key"])
    except (WebSocketDisconnect, SessionNotFoundError):
        pass
    finally:
        frame_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await frame_task


def main() -> None:
    import uvicorn

    uvicorn.run("browser_worker.main:app", host="0.0.0.0", port=8100)
