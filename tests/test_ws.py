from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.rooms import rooms
from server.app.server import app, is_room_switch


class RoomSwitchHelperTests(unittest.TestCase):
    def test_first_join_is_not_switch(self) -> None:
        self.assertFalse(is_room_switch(None, None, "AAAA", "c1"))

    def test_same_membership_is_not_switch(self) -> None:
        self.assertFalse(is_room_switch("AAAA", "c1", "AAAA", "c1"))

    def test_different_room_is_switch(self) -> None:
        self.assertTrue(is_room_switch("AAAA", "c1", "BBBB", "c1"))

    def test_different_client_is_switch(self) -> None:
        self.assertTrue(is_room_switch("AAAA", "c1", "AAAA", "c2"))


class WsSwitchFullRoomTests(unittest.TestCase):
    def setUp(self) -> None:
        self._max = rooms._max_members
        rooms._max_members = 1
        rooms._rooms.clear()
        for task in list(rooms._cleanup_tasks.values()):
            task.cancel()
        rooms._cleanup_tasks.clear()

    def tearDown(self) -> None:
        rooms._max_members = self._max
        rooms._rooms.clear()
        for task in list(rooms._cleanup_tasks.values()):
            task.cancel()
        rooms._cleanup_tasks.clear()

    def test_switch_to_full_room_clears_local_membership(self) -> None:
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as filler:
                filler.send_json(
                    {
                        "type": "join",
                        "room": "FULL",
                        "clientId": "occ",
                        "name": "Occ",
                        "role": "viewer",
                    }
                )
                joined = filler.receive_json()
                self.assertEqual(joined["type"], "joined")

                with client.websocket_connect("/ws") as ws:
                    ws.send_json(
                        {
                            "type": "join",
                            "room": "HOME",
                            "clientId": "pub",
                            "name": "Pub",
                            "role": "publisher",
                        }
                    )
                    self.assertEqual(ws.receive_json()["type"], "joined")
                    ws.send_json(
                        {
                            "type": "join",
                            "room": "FULL",
                            "clientId": "pub",
                            "name": "Pub",
                            "role": "publisher",
                        }
                    )
                    err = ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertEqual(err["message"], "房間人數已滿")
                    ws.send_json({"type": "hr", "bpm": 72, "contact": True})
                    denied = ws.receive_json()
                    self.assertEqual(denied["type"], "error")
                    self.assertEqual(denied["message"], "請先加入房間")


if __name__ == "__main__":
    unittest.main()
