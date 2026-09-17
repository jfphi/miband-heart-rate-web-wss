from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.protocol import member_public
from server.app.rooms import RoomManager


class DummyWS:
    def __init__(self, name: str) -> None:
        self.name = name
        self.closed = False
        self.sent: list[dict] = []

    async def close(self) -> None:
        self.closed = True

    async def send_json(self, message: dict) -> None:
        if self.closed:
            raise RuntimeError("closed")
        self.sent.append(message)


class MemberPublicTests(unittest.TestCase):
    def test_contact_none_passthrough(self) -> None:
        pub = member_public(
            {
                "client_id": "c1",
                "name": "N",
                "role": "publisher",
                "bpm": None,
                "contact": None,
                "online": True,
                "updated_at": 1,
                "db": None,
                "sound_updated_at": None,
            }
        )
        self.assertIsNone(pub["contact"])
        self.assertIsNone(pub["bpm"])
        self.assertIsNone(pub["db"])
        self.assertIsNone(pub["soundUpdatedAt"])

    def test_contact_true_false_passthrough(self) -> None:
        worn = member_public(
            {
                "client_id": "c1",
                "name": "N",
                "role": "publisher",
                "contact": True,
            }
        )
        off = member_public(
            {
                "client_id": "c1",
                "name": "N",
                "role": "publisher",
                "contact": False,
            }
        )
        self.assertIs(worn["contact"], True)
        self.assertIs(off["contact"], False)

    def test_missing_contact_is_none_not_false(self) -> None:
        pub = member_public(
            {
                "client_id": "c1",
                "name": "N",
                "role": "viewer",
            }
        )
        self.assertIsNone(pub["contact"])
        self.assertIsNone(pub["db"])
        self.assertIsNone(pub["soundUpdatedAt"])


class SensorManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_join_defaults_contact_none(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("p")
        room, member, _ = await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        self.assertIsNone(member.contact)
        self.assertIsNone(member.db)
        snap = mgr.roster_snapshot(room)
        self.assertEqual(len(snap), 1)
        self.assertIsNone(snap[0]["contact"])
        self.assertIsNone(snap[0]["db"])
        self.assertIsNone(snap[0]["soundUpdatedAt"])

    async def test_update_hr_stores_contact_none(self) -> None:
        mgr = RoomManager(hr_min_interval_ms=0)
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        status, _, member = await mgr.update_hr(
            "ROOM", "p1", 80, None, None, websocket=ws
        )
        self.assertEqual(status, "ok")
        assert member is not None
        self.assertIsNone(member.contact)
        status, _, member = await mgr.update_hr(
            "ROOM", "p1", 81, False, None, websocket=ws
        )
        self.assertEqual(status, "ok")
        assert member is not None
        self.assertIs(member.contact, False)

    async def test_clear_hr(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        await mgr.update_hr("ROOM", "p1", 90, True, None, websocket=ws)
        before = int(time.time() * 1000)
        status, _room, member = await mgr.clear_hr(
            "ROOM", "p1", websocket=ws
        )
        after = int(time.time() * 1000)
        self.assertEqual(status, "ok")
        assert member is not None
        self.assertIsNone(member.bpm)
        self.assertIsNone(member.contact)
        self.assertGreaterEqual(member.updated_at or 0, before)
        self.assertLessEqual(member.updated_at or 0, after + 2_000)

    async def test_viewer_cannot_clear_hr(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("v")
        await mgr.join(
            room_code="ROOM",
            client_id="v1",
            name="V",
            role="viewer",
            websocket=ws,
        )
        status, _room, member = await mgr.clear_hr(
            "ROOM", "v1", websocket=ws
        )
        self.assertEqual(status, "forbidden")
        self.assertIsNone(member)

    async def test_stale_old_socket_cannot_clear_hr(self) -> None:
        mgr = RoomManager()
        ws1 = DummyWS("old")
        ws2 = DummyWS("new")
        await mgr.join(
            room_code="ABCD",
            client_id="c1",
            name="A",
            role="publisher",
            websocket=ws1,
        )
        await mgr.update_hr("ABCD", "c1", 77, True, None, websocket=ws1)
        await mgr.join(
            room_code="ABCD",
            client_id="c1",
            name="A",
            role="publisher",
            websocket=ws2,
        )
        stale, _, member = await mgr.clear_hr("ABCD", "c1", websocket=ws1)
        self.assertEqual(stale, "stale")
        self.assertIsNone(member)
        self.assertEqual(mgr._rooms["ABCD"].members["c1"].bpm, 77)

    async def test_update_and_clear_mic(self) -> None:
        mgr = RoomManager(hr_min_interval_ms=0)
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        before = int(time.time() * 1000)
        status, _room, member = await mgr.update_mic(
            "ROOM", "p1", -42, websocket=ws
        )
        self.assertEqual(status, "ok")
        assert member is not None
        self.assertEqual(member.db, -42)
        self.assertIsNotNone(member.sound_updated_at)
        self.assertGreaterEqual(member.sound_updated_at or 0, before)

        high, _, member = await mgr.update_mic("ROOM", "p1", 20, websocket=ws)
        self.assertEqual(high, "ok")
        assert member is not None
        self.assertEqual(member.db, 0)

        low, _, member = await mgr.update_mic("ROOM", "p1", -250, websocket=ws)
        self.assertEqual(low, "ok")
        assert member is not None
        self.assertEqual(member.db, -100)

        cleared, _, member = await mgr.clear_mic("ROOM", "p1", websocket=ws)
        self.assertEqual(cleared, "ok")
        assert member is not None
        self.assertIsNone(member.db)
        self.assertIsNotNone(member.sound_updated_at)

    async def test_mic_rate_limit_drops(self) -> None:
        mgr = RoomManager(hr_min_interval_ms=10_000)
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        first, _, _ = await mgr.update_mic("ROOM", "p1", -10, websocket=ws)
        second, _, member = await mgr.update_mic("ROOM", "p1", -20, websocket=ws)
        self.assertEqual(first, "ok")
        self.assertEqual(second, "drop")
        self.assertIsNone(member)

    async def test_viewer_cannot_push_mic(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("v")
        await mgr.join(
            room_code="ROOM",
            client_id="v1",
            name="V",
            role="viewer",
            websocket=ws,
        )
        status, _room, member = await mgr.update_mic(
            "ROOM", "v1", -30, websocket=ws
        )
        self.assertEqual(status, "forbidden")
        self.assertIsNone(member)
        cleared, _, member = await mgr.clear_mic("ROOM", "v1", websocket=ws)
        self.assertEqual(cleared, "forbidden")
        self.assertIsNone(member)

    async def test_stale_old_socket_mic_and_hr(self) -> None:
        mgr = RoomManager()
        ws1 = DummyWS("old")
        ws2 = DummyWS("new")
        await mgr.join(
            room_code="ABCD",
            client_id="c1",
            name="A",
            role="publisher",
            websocket=ws1,
        )
        await mgr.join(
            room_code="ABCD",
            client_id="c1",
            name="A",
            role="publisher",
            websocket=ws2,
        )
        stale_hr, _, hr_member = await mgr.update_hr(
            "ABCD", "c1", 80, True, None, websocket=ws1
        )
        stale_mic, _, mic_member = await mgr.update_mic(
            "ABCD", "c1", -12, websocket=ws1
        )
        stale_clear, _, clear_member = await mgr.clear_mic(
            "ABCD", "c1", websocket=ws1
        )
        self.assertEqual(stale_hr, "stale")
        self.assertEqual(stale_mic, "stale")
        self.assertEqual(stale_clear, "stale")
        self.assertIsNone(hr_member)
        self.assertIsNone(mic_member)
        self.assertIsNone(clear_member)

        ok_hr, _, member = await mgr.update_hr(
            "ABCD", "c1", 81, True, None, websocket=ws2
        )
        ok_mic, _, member = await mgr.update_mic(
            "ABCD", "c1", -12, websocket=ws2
        )
        self.assertEqual(ok_hr, "ok")
        self.assertEqual(ok_mic, "ok")
        assert member is not None
        self.assertEqual(member.bpm, 81)
        self.assertEqual(member.db, -12)

    async def test_clear_hr_missing_room(self) -> None:
        mgr = RoomManager()
        status, room, member = await mgr.clear_hr("GONE", "x")
        self.assertEqual(status, "missing")
        self.assertIsNone(room)
        self.assertIsNone(member)


if __name__ == "__main__":
    unittest.main()