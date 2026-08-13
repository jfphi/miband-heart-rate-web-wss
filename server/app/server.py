from __future__ import annotations

import mimetypes
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .protocol import error_message, member_public
from .rooms import RoomFullError, RoomManager
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
    async def public_config() -> dict:
        """前端用的公開設定（來源：.env 的 MIBAND_*）。"""
        return get_public_config()

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
                            await rooms.broadcast(
                                old_room,
                                {
                                    "type": "roster",
                                    "action": "offline",
                                    "clientId": client_id,
                                    "updatedAt": _now_ms(),
                                },
                                exclude=client_id,
                            )
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
                        }
                    )
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
                    contact = bool(data.get("contact"))
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
                    await rooms.broadcast(
                        room,
                        {
                            "type": "hr",
                            "clientId": member.client_id,
                            "name": member.name,
                            "bpm": member.bpm,
                            "contact": member.contact,
                            "ts": member.updated_at,
                        },
                    )

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
                    await rooms.broadcast(
                        room,
                        {
                            "type": "roster",
                            "action": "offline",
                            "clientId": client_id,
                            "updatedAt": _now_ms(),
                        },
                    )

    @app.get("/")
    async def root_index() -> Response:
        target = _safe_public_file("index.html")
        if not target:
            raise HTTPException(status_code=404, detail="index.html not found")
        return FileResponse(target)

    @app.get("/{file_path:path}")
    async def static_file(file_path: str) -> Response:
        if file_path.startswith("api/") or file_path == "ws":
            raise HTTPException(status_code=404, detail="Not Found")
        target = _safe_public_file(file_path)
        if not target:
            raise HTTPException(status_code=404, detail="Not Found")
        media_type, _ = mimetypes.guess_type(str(target))
        return FileResponse(target, media_type=media_type)

    return app


app = create_app()
