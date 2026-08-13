from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from .protocol import member_public


OFFLINE_GRACE_SECONDS = 15
MAX_ROOM_MEMBERS = 40
HR_MIN_INTERVAL_MS = 400
TS_FUTURE_SLACK_MS = 2_000
TS_PAST_SLACK_MS = 10_000

HrStatus = Literal["ok", "drop", "forbidden", "missing"]


class RoomFullError(Exception):
    """Room already has MAX_ROOM_MEMBERS distinct clients."""


def clamp_hr_ts(ts: int | None, now_ms: int | None = None) -> int:
    now = int(time.time() * 1000) if now_ms is None else now_ms
    if ts is None:
        return now
    try:
        raw = int(ts)
    except (TypeError, ValueError):
        return now
    if raw > now + TS_FUTURE_SLACK_MS or raw < now - TS_PAST_SLACK_MS:
        return now
    return raw


async def _close_quiet(websocket: WebSocket) -> None:
    try:
        await websocket.close()
    except Exception:
        pass


@dataclass
class Member:
    client_id: str
    name: str
    role: str
    websocket: WebSocket
    bpm: int | None = None
    contact: bool = False
    online: bool = True
    updated_at: int | None = None
    last_hr_at: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id,
            "name": self.name,
            "role": self.role,
            "bpm": self.bpm,
            "contact": self.contact,
            "online": self.online,
            "updated_at": self.updated_at,
        }


@dataclass
class Room:
    code: str
    members: dict[str, Member] = field(default_factory=dict)


class RoomManager:
    def __init__(
        self,
        *,
        max_members: int = MAX_ROOM_MEMBERS,
        hr_min_interval_ms: int = HR_MIN_INTERVAL_MS,
    ) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self._cleanup_tasks: dict[str, asyncio.Task] = {}
        self._max_members = max_members
        self._hr_min_interval_ms = hr_min_interval_ms

    async def join(
        self,
        *,
        room_code: str,
        client_id: str,
        name: str,
        role: str,
        websocket: WebSocket,
    ) -> tuple[Room, Member, Member | None]:
        code = room_code.strip().upper()
        previous_ws: WebSocket | None = None
        async with self._lock:
            room = self._rooms.get(code)
            if room is None:
                room = Room(code=code)
                self._rooms[code] = room

            previous = room.members.get(client_id)
            if previous is None and len(room.members) >= self._max_members:
                raise RoomFullError(code)

            if previous and previous.websocket is not websocket:
                previous_ws = previous.websocket

            task_key = f"{code}:{client_id}"
            task = self._cleanup_tasks.pop(task_key, None)
            if task:
                task.cancel()

            member = Member(
                client_id=client_id,
                name=name[:32] or "匿名",
                role=role if role in {"publisher", "viewer"} else "viewer",
                websocket=websocket,
                bpm=previous.bpm if previous else None,
                contact=previous.contact if previous else False,
                online=True,
                updated_at=int(time.time() * 1000),
                last_hr_at=previous.last_hr_at if previous else None,
            )
            room.members[client_id] = member

        if previous_ws is not None:
            asyncio.create_task(_close_quiet(previous_ws))
        return room, member, previous

    async def leave(
        self,
        room_code: str,
        client_id: str,
        websocket: WebSocket | None = None,
    ) -> Room | None:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return None
            member = room.members.get(client_id)
            if not member:
                return room
            if websocket is not None and member.websocket is not websocket:
                return None
            member.online = False
            member.updated_at = int(time.time() * 1000)
            self._schedule_removal(code, client_id)
            return room

    def _schedule_removal(self, room_code: str, client_id: str) -> None:
        task_key = f"{room_code}:{client_id}"
        existing = self._cleanup_tasks.pop(task_key, None)
        if existing:
            existing.cancel()

        async def _remove() -> None:
            await asyncio.sleep(OFFLINE_GRACE_SECONDS)
            async with self._lock:
                room = self._rooms.get(room_code)
                if not room:
                    return
                member = room.members.get(client_id)
                if member and not member.online:
                    room.members.pop(client_id, None)
                if room and not room.members:
                    self._rooms.pop(room_code, None)
            self._cleanup_tasks.pop(task_key, None)

        self._cleanup_tasks[task_key] = asyncio.create_task(_remove())

    async def update_hr(
        self, room_code: str, client_id: str, bpm: int, contact: bool, ts: int | None
    ) -> tuple[HrStatus, Room | None, Member | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None, None
            member = room.members.get(client_id)
            if not member or member.role != "publisher":
                return "forbidden", room, None
            now = int(time.time() * 1000)
            if (
                member.last_hr_at is not None
                and now - member.last_hr_at < self._hr_min_interval_ms
            ):
                return "drop", room, None
            member.bpm = max(0, min(250, int(bpm)))
            member.contact = bool(contact)
            member.online = True
            member.updated_at = clamp_hr_ts(ts, now)
            member.last_hr_at = now
            return "ok", room, member

    async def broadcast(
        self, room: Room, message: dict[str, Any], exclude: str | None = None
    ) -> None:
        dead: list[tuple[str, WebSocket]] = []
        for member in list(room.members.values()):
            if exclude and member.client_id == exclude:
                continue
            if not member.online:
                continue
            try:
                await member.websocket.send_json(message)
            except Exception:
                dead.append((member.client_id, member.websocket))
        for client_id, websocket in dead:
            await self.leave(room.code, client_id, websocket=websocket)

    def roster_snapshot(self, room: Room) -> list[dict[str, Any]]:
        return [member_public(m.to_dict()) for m in room.members.values()]


rooms = RoomManager()
