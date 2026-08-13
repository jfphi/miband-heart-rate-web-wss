from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.rooms import RoomFullError, RoomManager, clamp_hr_ts


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


class ClampHrTsTests(unittest.TestCase):
    def test_none_uses_now(self) -> None:
        self.assertEqual(clamp_hr_ts(None, 1000), 1000)

    def test_clamps_future(self) -> None:
        self.assertEqual(clamp_hr_ts(50_000, 1000), 1000)

    def test_clamps_too_old(self) -> None:
        self.assertEqual(clamp_hr_ts(1, 20_000), 20_000)

    def test_keeps_near_now(self) -> None:
        self.assertEqual(clamp_hr_ts(1500, 1000), 1500)


class RoomManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_stale_leave_does_not_offline_new_socket(self) -> None:
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
        room, member, _prev = await mgr.join(
            room_code="ABCD",
            client_id="c1",
            name="A",
            role="publisher",
            websocket=ws2,
        )
        await asyncio.sleep(0)
        self.assertTrue(ws1.closed)
        self.assertIs(member.websocket, ws2)
        self.assertTrue(member.online)

        ignored = await mgr.leave("ABCD", "c1", websocket=ws1)
        self.assertIsNone(ignored)
        still = room.members["c1"]
        self.assertTrue(still.online)
        self.assertIs(still.websocket, ws2)

        gone = await mgr.leave("ABCD", "c1", websocket=ws2)
        self.assertIsNotNone(gone)
        self.assertFalse(room.members["c1"].online)

    async def test_update_hr_clamps_future_ts(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        far_future = 9_999_999_999_999
        status, _room, member = await mgr.update_hr("ROOM", "p1", 80, True, far_future)
        self.assertEqual(status, "ok")
        assert member is not None
        now = int(time.time() * 1000)
        self.assertLessEqual(member.updated_at or 0, now + 2_000)
        self.assertGreater(member.updated_at or 0, now - 5_000)

    async def test_update_hr_rate_limit_drops(self) -> None:
        mgr = RoomManager(hr_min_interval_ms=10_000)
        ws = DummyWS("p")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws,
        )
        first, _, _ = await mgr.update_hr("ROOM", "p1", 70, True, None)
        second, _, member = await mgr.update_hr("ROOM", "p1", 90, True, None)
        self.assertEqual(first, "ok")
        self.assertEqual(second, "drop")
        self.assertIsNone(member)

    async def test_viewer_cannot_push_hr(self) -> None:
        mgr = RoomManager()
        ws = DummyWS("v")
        await mgr.join(
            room_code="ROOM",
            client_id="v1",
            name="V",
            role="viewer",
            websocket=ws,
        )
        status, _room, member = await mgr.update_hr("ROOM", "v1", 70, True, None)
        self.assertEqual(status, "forbidden")
        self.assertIsNone(member)

    async def test_room_full_rejects_new_client_allows_reconnect(self) -> None:
        mgr = RoomManager(max_members=1)
        ws1 = DummyWS("a")
        ws2 = DummyWS("b")
        ws1b = DummyWS("a-re")
        await mgr.join(
            room_code="FULL",
            client_id="a",
            name="A",
            role="viewer",
            websocket=ws1,
        )
        with self.assertRaises(RoomFullError):
            await mgr.join(
                room_code="FULL",
                client_id="b",
                name="B",
                role="viewer",
                websocket=ws2,
            )
        room, member, _ = await mgr.join(
            room_code="FULL",
            client_id="a",
            name="A",
            role="viewer",
            websocket=ws1b,
        )
        self.assertEqual(member.client_id, "a")
        self.assertEqual(len(room.members), 1)

    async def test_broadcast_skips_offline_and_leave_uses_socket(self) -> None:
        mgr = RoomManager()
        pub = DummyWS("pub")
        viewer = DummyWS("view")
        await mgr.join(
            room_code="R1",
            client_id="p",
            name="P",
            role="publisher",
            websocket=pub,
        )
        room, _, _ = await mgr.join(
            room_code="R1",
            client_id="v",
            name="V",
            role="viewer",
            websocket=viewer,
        )
        await mgr.leave("R1", "v", websocket=viewer)
        await mgr.broadcast(room, {"type": "hr", "bpm": 1})
        self.assertEqual(len(pub.sent), 1)
        self.assertEqual(len(viewer.sent), 0)

    async def test_old_socket_hr_is_stale(self) -> None:
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
        stale, _, member = await mgr.update_hr(
            "ABCD", "c1", 80, True, None, websocket=ws1
        )
        self.assertEqual(stale, "stale")
        self.assertIsNone(member)
        ok, _, member = await mgr.update_hr(
            "ABCD", "c1", 81, True, None, websocket=ws2
        )
        self.assertEqual(ok, "ok")
        assert member is not None
        self.assertEqual(member.bpm, 81)

    async def test_reconnect_does_not_inherit_rate_limit(self) -> None:
        mgr = RoomManager(hr_min_interval_ms=10_000)
        ws1 = DummyWS("old")
        ws2 = DummyWS("new")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws1,
        )
        first, _, _ = await mgr.update_hr(
            "ROOM", "p1", 70, True, None, websocket=ws1
        )
        self.assertEqual(first, "ok")
        await mgr.join(
            room_code="ROOM",
            client_id="p1",
            name="P",
            role="publisher",
            websocket=ws2,
        )
        flushed, _, member = await mgr.update_hr(
            "ROOM", "p1", 70, True, None, websocket=ws2
        )
        self.assertEqual(flushed, "ok")
        assert member is not None
        self.assertEqual(member.bpm, 70)


if __name__ == "__main__":
    unittest.main()
