from __future__ import annotations

from typing import Any, Literal

Role = Literal["publisher", "viewer"]


def member_public(member: dict[str, Any]) -> dict[str, Any]:
    return {
        "clientId": member["client_id"],
        "name": member["name"],
        "role": member["role"],
        "bpm": member.get("bpm"),
        "contact": member.get("contact"),
        "online": bool(member.get("online", True)),
        "updatedAt": member.get("updated_at"),
        "db": member.get("db"),
        "soundUpdatedAt": member.get("sound_updated_at"),
    }


def error_message(message: str) -> dict[str, str]:
    return {"type": "error", "message": message}


def session_replaced_message() -> dict[str, str]:
    return {"type": "session_replaced", "message": "已在其他分頁連線"}


def hr_message(member: dict[str, Any], *, cleared: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "hr",
        "clientId": member["client_id"],
        "name": member["name"],
        "bpm": member.get("bpm"),
        "contact": member.get("contact"),
        "ts": member.get("updated_at"),
    }
    if cleared:
        payload["cleared"] = True
    return payload


def toy_message(
    owner: dict[str, Any],
    *,
    toy_id: str | None,
    level: int,
    ts: int,
    from_id: str,
    cleared: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "toy",
        "clientId": owner["client_id"],
        "name": owner["name"],
        "fromId": from_id,
        "toyId": toy_id,
        "level": level,
        "ts": ts,
    }
    if cleared:
        payload["cleared"] = True
    return payload


def toy_lease_message(
    *,
    owner_id: str,
    owner_name: str,
    controller_id: str | None,
    controller_name: str | None,
    expires_at: int | None,
    toys: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "type": "toy_lease",
        "ownerId": owner_id,
        "ownerName": owner_name,
        "controllerId": controller_id,
        "controllerName": controller_name,
        "expiresAt": expires_at,
        "toys": toys,
    }


def mic_message(member: dict[str, Any], *, cleared: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "mic",
        "clientId": member["client_id"],
        "name": member["name"],
        "db": member.get("db"),
        "ts": member.get("sound_updated_at"),
    }
    if cleared:
        payload["cleared"] = True
    return payload
