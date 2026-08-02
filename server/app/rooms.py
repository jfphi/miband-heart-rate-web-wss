from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .protocol import member_public


OFFLINE_GRACE_SECONDS = 15


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
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self._cleanup_tasks: dict[str, asyncio.Task] = {}

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
        async with self._lock:
            room = self._rooms.get(code)
            if room is None:
                room = Room(code=code)
                self._rooms[code] = room

            previous = room.members.get(client_id)
            if previous and previous.websocket is not websocket:
                try:
                    await previous.websocket.close()
                except Exception:
                    pass

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
            )
            room.members[client_id] = member
            return room, member, previous

    async def leave(self, room_code: str, client_id: str) -> Room | None:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return None
            member = room.members.get(client_id)
            if not member:
                return room
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
    ) -> tuple[Room | None, Member | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return None, None
            member = room.members.get(client_id)
            if not member or member.role != "publisher":
                return room, None
            member.bpm = max(0, min(250, int(bpm)))
            member.contact = bool(contact)
            member.online = True
            member.updated_at = int(ts or time.time() * 1000)
            return room, member

    async def broadcast(
        self, room: Room, message: dict[str, Any], exclude: str | None = None
    ) -> None:
        dead: list[str] = []
        for member in list(room.members.values()):
            if exclude and member.client_id == exclude:
                continue
            try:
                await member.websocket.send_json(message)
            except Exception:
                dead.append(member.client_id)
        for client_id in dead:
            await self.leave(room.code, client_id)

    def roster_snapshot(self, room: Room) -> list[dict[str, Any]]:
        return [member_public(m.to_dict()) for m in room.members.values()]


rooms = RoomManager()
