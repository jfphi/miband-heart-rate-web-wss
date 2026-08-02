from __future__ import annotations

from typing import Any, Literal

Role = Literal["publisher", "viewer"]


def member_public(member: dict[str, Any]) -> dict[str, Any]:
    return {
        "clientId": member["client_id"],
        "name": member["name"],
        "role": member["role"],
        "bpm": member.get("bpm"),
        "contact": bool(member.get("contact")),
        "online": bool(member.get("online", True)),
        "updatedAt": member.get("updated_at"),
    }


def error_message(message: str) -> dict[str, str]:
    return {"type": "error", "message": message}
