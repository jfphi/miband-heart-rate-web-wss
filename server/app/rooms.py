from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from .protocol import member_public, session_replaced_message, toy_lease_message, toy_message


OFFLINE_GRACE_SECONDS = 15
MAX_ROOM_MEMBERS = 40
HR_MIN_INTERVAL_MS = 400
MIC_MIN_INTERVAL_MS = 50
TS_FUTURE_SLACK_MS = 2_000
TS_PAST_SLACK_MS = 10_000
MIC_DB_MIN = -100
MIC_DB_MAX = 0
TOY_LEVEL_MIN = 0
TOY_LEVEL_MAX = 20
TOY_MIN_INTERVAL_MS = 50
TOY_GRANT_MIN_SECONDS = 1
TOY_GRANT_MAX_SECONDS = 1800

HrStatus = Literal["ok", "drop", "forbidden", "missing", "stale"]


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


async def _notify_replaced_and_close(websocket: WebSocket) -> None:
    try:
        await websocket.send_json(session_replaced_message())
    except Exception:
        pass
    await _close_quiet(websocket)


@dataclass
class Member:
    client_id: str
    name: str
    role: str
    websocket: WebSocket
    bpm: int | None = None
    contact: bool | None = None
    online: bool = True
    updated_at: int | None = None
    last_hr_at: int | None = None
    db: int | None = None
    sound_updated_at: int | None = None
    last_mic_at: int | None = None
    last_toy_at: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id,
            "name": self.name,
            "role": self.role,
            "bpm": self.bpm,
            "contact": self.contact,
            "online": self.online,
            "updated_at": self.updated_at,
            "db": self.db,
            "sound_updated_at": self.sound_updated_at,
        }


@dataclass
class ToyLease:
    owner_id: str
    owner_name: str
    controller_id: str
    controller_name: str
    expires_at: int
    toys: list[dict[str, str]]


@dataclass
class Room:
    code: str
    members: dict[str, Member] = field(default_factory=dict)
    toy_owners: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    leases: dict[str, ToyLease] = field(default_factory=dict)
    toy_notices: list[dict[str, Any]] = field(default_factory=list)


class RoomManager:
    def __init__(
        self,
        *,
        max_members: int = MAX_ROOM_MEMBERS,
        hr_min_interval_ms: int = HR_MIN_INTERVAL_MS,
        mic_min_interval_ms: int = MIC_MIN_INTERVAL_MS,
    ) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self._cleanup_tasks: dict[str, asyncio.Task] = {}
        self._max_members = max_members
        self._hr_min_interval_ms = hr_min_interval_ms
        self._mic_min_interval_ms = mic_min_interval_ms
        self._toy_min_interval_ms = TOY_MIN_INTERVAL_MS

    def _live_publisher(
        self,
        room_code: str,
        client_id: str,
        websocket: WebSocket | None,
    ) -> tuple[HrStatus, Room | None, Member | None]:
        code = room_code.strip().upper()
        room = self._rooms.get(code)
        if not room:
            return "missing", None, None
        member = room.members.get(client_id)
        if not member or member.role != "publisher":
            return "forbidden", room, None
        if websocket is not None and member.websocket is not websocket:
            return "stale", room, None
        return "ok", room, member

    def _throttled(self, last_at: int | None, now: int, interval_ms: int) -> bool:
        return last_at is not None and now - last_at < interval_ms

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
                contact=previous.contact if previous else None,
                db=previous.db if previous else None,
                sound_updated_at=previous.sound_updated_at if previous else None,
                online=True,
                updated_at=int(time.time() * 1000),
                last_hr_at=None,
                last_mic_at=None,
            )
            room.members[client_id] = member

        if previous_ws is not None:
            await _notify_replaced_and_close(previous_ws)
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
            now = int(time.time() * 1000)
            member.online = False
            member.updated_at = now
            if member.role == "publisher":
                member.bpm = None
                member.contact = None
                member.db = None
                member.sound_updated_at = now
            self._release_toy_for(room, client_id, now)
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
        self,
        room_code: str,
        client_id: str,
        bpm: int,
        contact: bool | None,
        ts: int | None,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None, Member | None]:
        async with self._lock:
            status, room, member = self._live_publisher(
                room_code, client_id, websocket
            )
            if status != "ok" or room is None or member is None:
                return status, room, None
            now = int(time.time() * 1000)
            if self._throttled(member.last_hr_at, now, self._hr_min_interval_ms):
                return "drop", room, None
            member.bpm = max(0, min(250, int(bpm)))
            member.contact = None if contact is None else bool(contact)
            member.online = True
            member.updated_at = now
            member.last_hr_at = now
            return "ok", room, member

    async def clear_hr(
        self,
        room_code: str,
        client_id: str,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None, Member | None]:
        async with self._lock:
            status, room, member = self._live_publisher(
                room_code, client_id, websocket
            )
            if status != "ok" or room is None or member is None:
                return status, room, None
            now = int(time.time() * 1000)
            member.bpm = None
            member.contact = None
            member.updated_at = now
            return "ok", room, member

    async def update_mic(
        self,
        room_code: str,
        client_id: str,
        db: int,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None, Member | None]:
        async with self._lock:
            status, room, member = self._live_publisher(
                room_code, client_id, websocket
            )
            if status != "ok" or room is None or member is None:
                return status, room, None
            now = int(time.time() * 1000)
            if self._throttled(member.last_mic_at, now, self._mic_min_interval_ms):
                return "drop", room, None
            member.db = max(MIC_DB_MIN, min(MIC_DB_MAX, int(db)))
            member.sound_updated_at = now
            member.last_mic_at = now
            member.online = True
            return "ok", room, member

    async def clear_mic(
        self,
        room_code: str,
        client_id: str,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None, Member | None]:
        async with self._lock:
            status, room, member = self._live_publisher(
                room_code, client_id, websocket
            )
            if status != "ok" or room is None or member is None:
                return status, room, None
            now = int(time.time() * 1000)
            member.db = None
            member.sound_updated_at = now
            return "ok", room, member

    def _normalize_toys(self, raw: Any) -> list[dict[str, str]]:
        if not isinstance(raw, list):
            return []
        toys: list[dict[str, str]] = []
        for item in raw[:8]:
            if not isinstance(item, dict):
                continue
            toy_id = str(item.get("id") or "").strip()[:64]
            if not toy_id:
                continue
            name = str(item.get("name") or "Toy").strip()[:32] or "Toy"
            toys.append({"id": toy_id, "name": name})
        return toys

    def _lease_message(self, room: Room, owner_id: str) -> dict[str, Any]:
        owner = room.members.get(owner_id)
        toys = room.toy_owners.get(owner_id, [])
        lease = room.leases.get(owner_id)
        now = int(time.time() * 1000)
        active = lease is not None and lease.expires_at > now
        return toy_lease_message(
            owner_id=owner_id,
            owner_name=(owner.name if owner else (lease.owner_name if lease else "匿名")),
            controller_id=lease.controller_id if active else None,
            controller_name=lease.controller_name if active else None,
            expires_at=lease.expires_at if active else None,
            toys=toys,
        )

    def _stop_messages(self, room: Room, owner_id: str, now: int) -> list[dict[str, Any]]:
        owner = room.members.get(owner_id)
        lease = room.leases.get(owner_id)
        name = owner.name if owner else (lease.owner_name if lease else "匿名")
        toys = room.toy_owners.get(owner_id) or (lease.toys if lease else [])
        payload = {"client_id": owner_id, "name": name}
        ids: list[str | None] = [toy["id"] for toy in toys] or [None]
        return [
            toy_message(payload, toy_id=toy_id, level=0, ts=now, from_id=owner_id, cleared=True)
            for toy_id in ids
        ]

    def _release_toy_for(self, room: Room, client_id: str, now: int) -> None:
        if client_id in room.toy_owners:
            room.toy_notices.extend(self._stop_messages(room, client_id, now))
            room.leases.pop(client_id, None)
            room.toy_owners.pop(client_id, None)
            room.toy_notices.append(self._lease_message(room, client_id))
        for owner_id, lease in list(room.leases.items()):
            if lease.controller_id != client_id or owner_id == client_id:
                continue
            room.toy_notices.extend(self._stop_messages(room, owner_id, now))
            room.leases.pop(owner_id, None)
            room.toy_notices.append(self._lease_message(room, owner_id))

    def _active_lease(self, room: Room, owner_id: str, now: int) -> ToyLease | None:
        lease = room.leases.get(owner_id)
        if lease is None:
            return None
        if lease.expires_at <= now:
            room.leases.pop(owner_id, None)
            room.toy_notices.extend(self._stop_messages(room, owner_id, now))
            room.toy_notices.append(self._lease_message(room, owner_id))
            return None
        return lease

    async def public_leases(self, room_code: str) -> list[dict[str, Any]]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return []
            return self.lease_snapshot(room)

    def lease_snapshot(self, room: Room) -> list[dict[str, Any]]:
        now = int(time.time() * 1000)
        for owner_id in list(room.leases):
            self._active_lease(room, owner_id, now)
        owner_ids = list(dict.fromkeys([*room.toy_owners.keys(), *room.leases.keys()]))
        return [self._lease_message(room, owner_id) for owner_id in owner_ids]

    async def drain_toy_notices(self, room_code: str) -> list[dict[str, Any]]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return []
            notices = list(room.toy_notices)
            room.toy_notices.clear()
            return notices

    async def set_toys(
        self,
        room_code: str,
        client_id: str,
        toys: Any,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None
            member = room.members.get(client_id)
            if not member or (websocket is not None and member.websocket is not websocket):
                return "forbidden", room
            room.toy_owners[client_id] = self._normalize_toys(toys)
            lease = room.leases.get(client_id)
            if lease:
                lease.toys = list(room.toy_owners[client_id])
                lease.owner_name = member.name
            room.toy_notices.append(self._lease_message(room, client_id))
            return "ok", room

    async def clear_toys(
        self,
        room_code: str,
        client_id: str,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None
            member = room.members.get(client_id)
            if not member or (websocket is not None and member.websocket is not websocket):
                return "forbidden", room
            now = int(time.time() * 1000)
            self._release_toy_for(room, client_id, now)
            return "ok", room

    async def grant_toy(
        self,
        room_code: str,
        owner_id: str,
        controller_id: str,
        seconds: int,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None, int | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None, None
            owner = room.members.get(owner_id)
            if (
                not owner
                or owner_id not in room.toy_owners
                or (websocket is not None and owner.websocket is not websocket)
            ):
                return "forbidden", room, None
            try:
                span = int(seconds)
            except (TypeError, ValueError):
                return "forbidden", room, None
            if span < TOY_GRANT_MIN_SECONDS or span > TOY_GRANT_MAX_SECONDS:
                return "forbidden", room, None
            controller = room.members.get(str(controller_id or "").strip())
            if not controller or not controller.online:
                return "missing", room, None
            now = int(time.time() * 1000)
            expires_at = now + span * 1000
            room.leases[owner_id] = ToyLease(
                owner_id=owner_id,
                owner_name=owner.name,
                controller_id=controller.client_id,
                controller_name=controller.name,
                expires_at=expires_at,
                toys=list(room.toy_owners.get(owner_id, [])),
            )
            room.toy_notices.append(self._lease_message(room, owner_id))
            return "ok", room, expires_at

    async def revoke_toy(
        self,
        room_code: str,
        owner_id: str,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None
            owner = room.members.get(owner_id)
            if (
                not owner
                or owner_id not in room.toy_owners
                or (websocket is not None and owner.websocket is not websocket)
            ):
                return "forbidden", room
            now = int(time.time() * 1000)
            if owner_id in room.leases:
                room.toy_notices.extend(self._stop_messages(room, owner_id, now))
                room.leases.pop(owner_id, None)
            room.toy_notices.append(self._lease_message(room, owner_id))
            return "ok", room

    async def expire_lease(
        self,
        room_code: str,
        owner_id: str,
        expected_expires_at: int,
    ) -> tuple[HrStatus, Room | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None
            lease = room.leases.get(owner_id)
            if lease is None or lease.expires_at != expected_expires_at:
                return "drop", room
            now = int(time.time() * 1000)
            if lease.expires_at > now:
                return "drop", room
            room.toy_notices.extend(self._stop_messages(room, owner_id, now))
            room.leases.pop(owner_id, None)
            room.toy_notices.append(self._lease_message(room, owner_id))
            return "ok", room

    async def push_toy(
        self,
        room_code: str,
        client_id: str,
        toy_id: str | None,
        level: int,
        *,
        websocket: WebSocket | None = None,
    ) -> tuple[HrStatus, Room | None]:
        code = room_code.strip().upper()
        async with self._lock:
            room = self._rooms.get(code)
            if not room:
                return "missing", None
            sender = room.members.get(client_id)
            if not sender or (websocket is not None and sender.websocket is not websocket):
                return "forbidden", room
            now = int(time.time() * 1000)
            owner_id = self._toy_owner_for_sender(room, client_id, now)
            if owner_id is None:
                return "forbidden", room
            try:
                clamped = max(TOY_LEVEL_MIN, min(TOY_LEVEL_MAX, int(level)))
            except (TypeError, ValueError):
                return "forbidden", room
            clean_id = str(toy_id).strip()[:64] if toy_id else None
            if clean_id == "":
                clean_id = None
            known = {toy["id"] for toy in room.toy_owners.get(owner_id, [])}
            if clean_id and known and clean_id not in known:
                return "forbidden", room
            if self._throttled(sender.last_toy_at, now, self._toy_min_interval_ms):
                return "drop", room
            owner = room.members.get(owner_id)
            sender.last_toy_at = now
            room.toy_notices.append(
                toy_message(
                    {"client_id": owner_id, "name": owner.name if owner else "匿名"},
                    toy_id=clean_id,
                    level=clamped,
                    ts=now,
                    from_id=client_id,
                )
            )
            return "ok", room

    def _toy_owner_for_sender(self, room: Room, client_id: str, now: int) -> str | None:
        for owner_id in list(room.leases):
            lease = self._active_lease(room, owner_id, now)
            if lease and lease.controller_id == client_id:
                return owner_id
        if client_id not in room.toy_owners:
            return None
        lease = self._active_lease(room, client_id, now)
        if lease and lease.controller_id != client_id:
            return None
        return client_id

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
