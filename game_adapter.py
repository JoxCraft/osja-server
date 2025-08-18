import os
import asyncio
from dataclasses import asdict
from typing import Any, Optional, Tuple

from ably import AblyRest
from ably.types.message import Message

# Channel-Namen
def chan_control(lobby_id: str, player_id: int) -> str:
    return f"osja:{lobby_id}:p{player_id}:control"   # Server -> Client
def chan_events(lobby_id: str, player_id: int) -> str:
    return f"osja:{lobby_id}:p{player_id}:events"    # Client -> Server (Antworten/UI-Events)
def chan_state(lobby_id: str) -> str:
    return f"osja:{lobby_id}:state"                  # Broadcast vom Server

class AblyBridge:
    def __init__(self):
        key = os.environ.get("ABLY_KEY")
        if not key:
            raise RuntimeError("ABLY_KEY not set")
        self.rest = AblyRest(key)

    def publish(self, channel: str, name: str, data: Any):
        self.rest.channels.get(channel).publish(name=name, data=data)

    async def wait_for(self, channel: str, name: str, timeout: float = 60.0) -> Message:
        """
        Poll-basierter Workaround mit REST (einfach). Für Produktion besser Ably Realtime im Server verwenden.
        """
        ch = self.rest.channels.get(channel)
        # Long-polling: wir holen die Historie offset-basiert
        start = ch.history().items
        last_id = start[0].id if start else None
        import time
        t0 = time.time()
        while time.time() - t0 < timeout:
            history = ch.history()
            items = list(history.items)
            items.reverse()  # neueste zuletzt
            seen = False if last_id else True
            for msg in items:
                if not seen:
                    if msg.id == last_id:
                        seen = True
                    continue
                if msg.name == name:
                    return msg
            if items:
                last_id = items[0].id
            await asyncio.sleep(0.5)
        raise TimeoutError(f"Timeout waiting on {channel}:{name}")

bridge = AblyBridge()

class ClientAdapter:
    """
    Adapter, der die Methoden anbietet, die dein Spielcode auf Client-Objekten aufruft.
    Er kommuniziert mit dem Frontend des jeweiligen Spielers via Ably.
    """
    def __init__(self, lobby_id: str, player_id: int):
        self.lobby_id = lobby_id
        self.player_id = player_id

    async def message(self, text: str):
        bridge.publish(chan_control(self.lobby_id, self.player_id), "message", {"text": text})

    async def getatktarget(self):
        # Server fordert den Client auf, ein Attacke-Target zu liefern
        bridge.publish(chan_control(self.lobby_id, self.player_id), "ask_atk_target", {})
        msg = await bridge.wait_for(chan_events(self.lobby_id, self.player_id), "atk_target")
        # erwartet: {"character_id": "...", "attack_index": 0}
        data = msg.data or {}
        return data.get("character_id"), data.get("attack_index")

    async def getcharactertarget(self):
        bridge.publish(chan_control(self.lobby_id, self.player_id), "ask_character_target", {})
        msg = await bridge.wait_for(chan_events(self.lobby_id, self.player_id), "character_target")
        # erwartet: {"character_id":"..."}
        return msg.data.get("character_id")

    async def getstacktarget(self):
        bridge.publish(chan_control(self.lobby_id, self.player_id), "ask_stack_target", {})
        msg = await bridge.wait_for(chan_events(self.lobby_id, self.player_id), "stack_target")
        # erwartet: {"stack_index": 0}
        return msg.data.get("stack_index")

    async def win(self):
        bridge.publish(chan_control(self.lobby_id, self.player_id), "win", {})

def broadcast_state(lobby_id: str, state: dict):
    bridge.publish(chan_state(lobby_id), "state", state)
