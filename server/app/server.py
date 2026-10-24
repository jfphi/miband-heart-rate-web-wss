from __future__ import annotations

import asyncio
import mimetypes
import re
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from .lovense import (
    COOKIE_MAX_AGE,
    COOKIE_NAME,
    LovenseTokenError,
    issue_session,
    lovense_settings,
)
from .protocol import error_message, hr_message, member_public, mic_message
from .rooms import Room, RoomFullError, RoomManager
from .settings import get_public_config

PUBLIC_DIR = Path(__file__).resolve().parents[2] / "public"
ROOM_RE = re.compile(r"^[A-Z0-9]{4,12}$")


def _now_ms() -> int:
    return int(time.time() * 1000)


def is_room_switch(
    room_code: str | None,
    client_id: str | None,
    new_room: str,
    new_client_id: str,
) -> bool:
    return bool(
        room_code
        and client_id
        and (room_code != new_room or client_id != new_client_id)
    )


def _rooms(websocket: WebSocket) -> RoomManager:
    return websocket.app.state.rooms


def _contact_from_payload(data: dict[str, Any]) -> bool | None:
    if "contact" not in data or data.get("contact") is None:
        return None
    return bool(data.get("contact"))


_lease_tasks: dict[str, asyncio.Task] = {}


def _cancel_lease_timer(room_code: str, owner_id: str) -> None:
    task = _lease_tasks.pop(f"{room_code}:{owner_id}", None)
    if task:
        task.cancel()


def _arm_lease_timer(rooms: RoomManager, room_code: str, owner_id: str, expires_at: int) -> None:
    key = f"{room_code}:{owner_id}"
    _cancel_lease_timer(room_code, owner_id)

    async def _fire() -> None:
        delay = max(0, (expires_at - time.time() * 1000) / 1000)
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        status, current = await rooms.expire_lease(room_code, owner_id, expires_at)
        if status == "ok" and current is not None:
            await _flush_toy_notices(rooms, current)
        _lease_tasks.pop(key, None)

    _lease_tasks[key] = asyncio.create_task(_fire())


async def _flush_toy_notices(rooms: RoomManager, room: Room | None) -> None:
    if room is None:
        return
    for notice in await rooms.drain_toy_notices(room.code):
        await rooms.broadcast(room, notice)


async def _broadcast_leave(
    rooms: RoomManager, room: Room, client_id: str
) -> None:
    member = room.members.get(client_id)
    if member is not None and member.role == "publisher":
        payload = member.to_dict()
        await rooms.broadcast(room, hr_message(payload, cleared=True))
        await rooms.broadcast(room, mic_message(payload, cleared=True))
    await rooms.broadcast(
        room,
        {
            "type": "roster",
            "action": "offline",
            "clientId": client_id,
            "updatedAt": _now_ms(),
        },
    )


def static_cache_headers(path: Path) -> dict[str, str]:
    suffix = path.suffix.lower()
    if suffix in {".html", ""}:
        return {"Cache-Control": "no-store"}
    if suffix in {".js", ".css"}:
        return {"Cache-Control": "no-cache"}
    return {}


def _safe_public_file(rel_path: str) -> Path | None:
    if not PUBLIC_DIR.is_dir():
        return None
    relative = rel_path.strip("/") or "index.html"
    target = (PUBLIC_DIR / relative).resolve()
    try:
        target.relative_to(PUBLIC_DIR.resolve())
    except ValueError:
        return None
    if target.is_file():
        return target
    return None


def create_app(room_manager: RoomManager | None = None) -> FastAPI:
    app = FastAPI(title="MiBand Heart Rate Rooms", version="0.1.0")
    app.state.rooms = room_manager or RoomManager()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/config")
    async def public_config() -> JSONResponse:
        """前端用的公開設定（來源：.env 的 MIBAND_*）。"""
        return JSONResponse(
            get_public_config(),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/lovense/status")
    async def lovense_status() -> dict[str, bool]:
        return {"enabled": lovense_settings() is not None}

    @app.post("/api/lovense/session")
    async def lovense_session(request: Request) -> JSONResponse:
        if lovense_settings() is None:
            raise HTTPException(status_code=404, detail="Not Found")
        try:
            body, signed = issue_session(request.cookies.get(COOKIE_NAME))
        except LovenseTokenError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        response = JSONResponse(body, headers={"Cache-Control": "no-store"})
        response.set_cookie(
            COOKIE_NAME,
            signed,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
            path="/",
        )
        return response

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        rooms = _rooms(websocket)
        room_code: str | None = None
        client_id: str | None = None

        try:
            while True:
                data = await websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "join":
                    code = str(data.get("room", "")).strip().upper()
                    cid = str(data.get("clientId", "")).strip()
                    name = str(data.get("name", "匿名")).strip() or "匿名"
                    role = str(data.get("role", "viewer")).strip().lower()

                    if not ROOM_RE.match(code):
                        await websocket.send_json(error_message("無效的房間碼"))
                        continue
                    if not cid:
                        await websocket.send_json(error_message("缺少 clientId"))
                        continue
                    if role not in {"publisher", "viewer"}:
                        await websocket.send_json(error_message("無效的角色"))
                        continue

                    if is_room_switch(room_code, client_id, code, cid):
                        old_room = await rooms.leave(
                            room_code, client_id, websocket=websocket
                        )
                        if old_room:
                            await _broadcast_leave(rooms, old_room, client_id)
                            await _flush_toy_notices(rooms, old_room)
                        room_code = None
                        client_id = None

                    try:
                        room, member, _prev = await rooms.join(
                            room_code=code,
                            client_id=cid,
                            name=name,
                            role=role,
                            websocket=websocket,
                        )
                    except RoomFullError:
                        await websocket.send_json(error_message("房間人數已滿"))
                        continue
                    room_code = room.code
                    client_id = member.client_id

                    await websocket.send_json(
                        {
                            "type": "joined",
                            "room": room.code,
                            "clientId": member.client_id,
                            "members": rooms.roster_snapshot(room),
                            "toyLeases": await rooms.public_leases(room.code),
                        }
                    )
                    await _flush_toy_notices(rooms, room)
                    await rooms.broadcast(
                        room,
                        {
                            "type": "roster",
                            "action": "join",
                            "member": member_public(member.to_dict()),
                        },
                        exclude=member.client_id,
                    )

                elif msg_type == "hr":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    try:
                        bpm = int(data.get("bpm"))
                    except (TypeError, ValueError):
                        await websocket.send_json(error_message("無效的心率值"))
                        continue
                    contact = _contact_from_payload(data)
                    ts = data.get("ts")
                    try:
                        ts_int = int(ts) if ts is not None else None
                    except (TypeError, ValueError):
                        ts_int = None

                    status, room, member = await rooms.update_hr(
                        room_code,
                        client_id,
                        bpm,
                        contact,
                        ts_int,
                        websocket=websocket,
                    )
                    if status in {"drop", "stale"}:
                        continue
                    if status != "ok" or not room or not member:
                        await websocket.send_json(error_message("僅 publisher 可推送心率"))
                        continue
                    await rooms.broadcast(room, hr_message(member.to_dict()))

                elif msg_type == "hr_clear":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room, member = await rooms.clear_hr(
                        room_code, client_id, websocket=websocket
                    )
                    if status in {"drop", "stale"}:
                        continue
                    if status != "ok" or not room or not member:
                        await websocket.send_json(error_message("僅 publisher 可推送心率"))
                        continue
                    await rooms.broadcast(
                        room, hr_message(member.to_dict(), cleared=True)
                    )

                elif msg_type == "mic":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    try:
                        db = int(data.get("db"))
                    except (TypeError, ValueError):
                        await websocket.send_json(error_message("無效的音量值"))
                        continue
                    status, room, member = await rooms.update_mic(
                        room_code, client_id, db, websocket=websocket
                    )
                    if status in {"drop", "stale"}:
                        continue
                    if status != "ok" or not room or not member:
                        await websocket.send_json(error_message("僅 publisher 可推送音量"))
                        continue
                    await rooms.broadcast(room, mic_message(member.to_dict()))

                elif msg_type == "mic_clear":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room, member = await rooms.clear_mic(
                        room_code, client_id, websocket=websocket
                    )
                    if status in {"drop", "stale"}:
                        continue
                    if status != "ok" or not room or not member:
                        await websocket.send_json(error_message("僅 publisher 可推送音量"))
                        continue
                    await rooms.broadcast(
                        room, mic_message(member.to_dict(), cleared=True)
                    )

                elif msg_type == "toy_ready":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room = await rooms.set_toys(
                        room_code,
                        client_id,
                        data.get("toys"),
                        websocket=websocket,
                    )
                    if status != "ok" or room is None:
                        await websocket.send_json(error_message("無法登記玩具"))
                        continue
                    await _flush_toy_notices(rooms, room)

                elif msg_type == "toy_clear":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room = await rooms.clear_toys(
                        room_code, client_id, websocket=websocket
                    )
                    if status != "ok" or room is None:
                        await websocket.send_json(error_message("無法清除玩具"))
                        continue
                    _cancel_lease_timer(room.code, client_id)
                    await _flush_toy_notices(rooms, room)

                elif msg_type == "toy_grant":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room, expires_at = await rooms.grant_toy(
                        room_code,
                        client_id,
                        str(data.get("controllerId") or ""),
                        data.get("seconds"),
                        websocket=websocket,
                    )
                    if status == "missing":
                        await websocket.send_json(error_message("對方不在房間"))
                        continue
                    if status != "ok" or room is None or expires_at is None:
                        await websocket.send_json(error_message("無法交出玩具控制權"))
                        continue
                    _arm_lease_timer(rooms, room.code, client_id, expires_at)
                    await _flush_toy_notices(rooms, room)

                elif msg_type == "toy_revoke":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room = await rooms.revoke_toy(
                        room_code, client_id, websocket=websocket
                    )
                    if status != "ok" or room is None:
                        await websocket.send_json(error_message("無法收回玩具控制權"))
                        continue
                    _cancel_lease_timer(room.code, client_id)
                    await _flush_toy_notices(rooms, room)

                elif msg_type == "toy":
                    if not room_code or not client_id:
                        await websocket.send_json(error_message("請先加入房間"))
                        continue
                    status, room = await rooms.push_toy(
                        room_code,
                        client_id,
                        data.get("toyId"),
                        data.get("level"),
                        websocket=websocket,
                    )
                    if status in {"drop", "stale"}:
                        continue
                    if status != "ok" or room is None:
                        await websocket.send_json(error_message("目前不能控制玩具"))
                        continue
                    await _flush_toy_notices(rooms, room)

                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong", "ts": data.get("ts")})

                elif msg_type == "leave":
                    break
                else:
                    await websocket.send_json(error_message("未知的訊息類型"))

        except WebSocketDisconnect:
            pass
        except Exception as exc:
            try:
                await websocket.send_json(error_message(str(exc)))
            except Exception:
                pass
        finally:
            if room_code and client_id:
                room = await rooms.leave(room_code, client_id, websocket=websocket)
                if room:
                    _cancel_lease_timer(room.code, client_id)
                    await _broadcast_leave(rooms, room, client_id)
                    await _flush_toy_notices(rooms, room)

    @app.get("/")
    async def root_index() -> Response:
        target = _safe_public_file("index.html")
        if not target:
            raise HTTPException(status_code=404, detail="index.html not found")
        return FileResponse(target, headers=static_cache_headers(target))

    @app.get("/{file_path:path}")
    async def static_file(file_path: str) -> Response:
        if file_path.startswith("api/") or file_path == "ws":
            raise HTTPException(status_code=404, detail="Not Found")
        target = _safe_public_file(file_path)
        if not target:
            raise HTTPException(status_code=404, detail="Not Found")
        media_type, _ = mimetypes.guess_type(str(target))
        return FileResponse(
            target, media_type=media_type, headers=static_cache_headers(target)
        )

    return app


app = create_app()
