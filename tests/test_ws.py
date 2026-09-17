from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.httpx_compat import ensure_httpx_alias

ensure_httpx_alias()

from fastapi.testclient import TestClient

from server.app.rooms import RoomManager
from server.app.server import create_app, is_room_switch


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
        self.mgr = RoomManager(max_members=1)
        self.app = create_app(self.mgr)

    def tearDown(self) -> None:
        for task in list(self.mgr._cleanup_tasks.values()):
            task.cancel()
        self.mgr._cleanup_tasks.clear()
        self.mgr._rooms.clear()

    def test_switch_to_full_room_clears_local_membership(self) -> None:
        with TestClient(self.app) as client:
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


def _join(ws, *, room: str, client_id: str, name: str, role: str) -> dict:
    ws.send_json(
        {
            "type": "join",
            "room": room,
            "clientId": client_id,
            "name": name,
            "role": role,
        }
    )
    return ws.receive_json()


class WsSensorProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mgr = RoomManager()
        self.app = create_app(self.mgr)

    def tearDown(self) -> None:
        for task in list(self.mgr._cleanup_tasks.values()):
            task.cancel()
        self.mgr._cleanup_tasks.clear()
        self.mgr._rooms.clear()

    def test_unknown_type_still_errors(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "nope"})
                err = ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["message"], "未知的訊息類型")

    def test_hr_without_contact_broadcasts_none(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as pub, client.websocket_connect(
                "/ws"
            ) as viewer:
                self.assertEqual(
                    _join(
                        pub,
                        room="ROOM",
                        client_id="pub",
                        name="Pub",
                        role="publisher",
                    )["type"],
                    "joined",
                )
                self.assertEqual(
                    _join(
                        viewer,
                        room="ROOM",
                        client_id="view",
                        name="View",
                        role="viewer",
                    )["type"],
                    "joined",
                )
                self.assertEqual(pub.receive_json()["type"], "roster")
                pub.send_json({"type": "hr", "bpm": 70})
                msg = viewer.receive_json()
                self.assertEqual(msg["type"], "hr")
                self.assertEqual(msg["bpm"], 70)
                self.assertIsNone(msg["contact"])
                self.assertNotIn("cleared", msg)

    def test_hr_clear_broadcasts_cleared(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as pub, client.websocket_connect(
                "/ws"
            ) as viewer:
                _join(pub, room="ROOM", client_id="pub", name="Pub", role="publisher")
                _join(viewer, room="ROOM", client_id="view", name="View", role="viewer")
                pub.receive_json()
                pub.send_json({"type": "hr", "bpm": 80, "contact": True})
                self.assertEqual(viewer.receive_json()["bpm"], 80)
                pub.send_json({"type": "hr_clear"})
                cleared = viewer.receive_json()
                self.assertEqual(cleared["type"], "hr")
                self.assertEqual(cleared["clientId"], "pub")
                self.assertEqual(cleared["name"], "Pub")
                self.assertIsNone(cleared["bpm"])
                self.assertIsNone(cleared["contact"])
                self.assertTrue(cleared["cleared"])
                self.assertIsInstance(cleared["ts"], int)

    def test_mic_update_and_clear(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as pub, client.websocket_connect(
                "/ws"
            ) as viewer:
                _join(pub, room="ROOM", client_id="pub", name="Pub", role="publisher")
                _join(viewer, room="ROOM", client_id="view", name="View", role="viewer")
                pub.receive_json()
                pub.send_json({"type": "mic", "db": -36})
                level = viewer.receive_json()
                self.assertEqual(level["type"], "mic")
                self.assertEqual(level["clientId"], "pub")
                self.assertEqual(level["name"], "Pub")
                self.assertEqual(level["db"], -36)
                self.assertIsInstance(level["ts"], int)
                self.assertNotIn("cleared", level)
                pub.send_json({"type": "mic_clear"})
                cleared = viewer.receive_json()
                self.assertEqual(cleared["type"], "mic")
                self.assertIsNone(cleared["db"])
                self.assertTrue(cleared["cleared"])
                self.assertIsInstance(cleared["ts"], int)

    def test_viewer_cannot_push_mic(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as viewer:
                _join(
                    viewer,
                    room="ROOM",
                    client_id="view",
                    name="View",
                    role="viewer",
                )
                viewer.send_json({"type": "mic", "db": -20})
                err = viewer.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["message"], "僅 publisher 可推送音量")

    def test_session_replaced_payload(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as old:
                self.assertEqual(
                    _join(
                        old,
                        room="ROOM",
                        client_id="same",
                        name="A",
                        role="publisher",
                    )["type"],
                    "joined",
                )
                with client.websocket_connect("/ws") as new:
                    joined = _join(
                        new,
                        room="ROOM",
                        client_id="same",
                        name="A",
                        role="publisher",
                    )
                    self.assertEqual(joined["type"], "joined")
                    replaced = old.receive_json()
                    self.assertEqual(replaced["type"], "session_replaced")
                    self.assertEqual(replaced["message"], "已在其他分頁連線")

    def test_publisher_leave_broadcasts_clears_then_offline(self) -> None:
        with TestClient(self.app) as client:
            with client.websocket_connect("/ws") as viewer:
                with client.websocket_connect("/ws") as pub:
                    _join(
                        pub,
                        room="ROOM",
                        client_id="pub",
                        name="Pub",
                        role="publisher",
                    )
                    joined = _join(
                        viewer,
                        room="ROOM",
                        client_id="view",
                        name="View",
                        role="viewer",
                    )
                    self.assertEqual(joined["type"], "joined")
                    pub.receive_json()
                    pub.send_json({"type": "hr", "bpm": 91, "contact": True})
                    self.assertEqual(viewer.receive_json()["bpm"], 91)
                    pub.send_json({"type": "mic", "db": -18})
                    self.assertEqual(viewer.receive_json()["db"], -18)
                    pub.send_json({"type": "leave"})
                hr_cleared = viewer.receive_json()
                self.assertEqual(hr_cleared["type"], "hr")
                self.assertIsNone(hr_cleared["bpm"])
                self.assertIsNone(hr_cleared["contact"])
                self.assertTrue(hr_cleared["cleared"])
                mic_cleared = viewer.receive_json()
                self.assertEqual(mic_cleared["type"], "mic")
                self.assertIsNone(mic_cleared["db"])
                self.assertTrue(mic_cleared["cleared"])
                roster = viewer.receive_json()
                self.assertEqual(roster["type"], "roster")
                self.assertEqual(roster["action"], "offline")
                self.assertEqual(roster["clientId"], "pub")


if __name__ == "__main__":
    unittest.main()
