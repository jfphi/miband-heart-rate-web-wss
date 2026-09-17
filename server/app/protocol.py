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
