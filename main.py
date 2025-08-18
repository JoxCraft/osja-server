import os
import asyncio
from typing import Dict, Any, List
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from ably import AblyRest

import game_engine as g
from game_adapter import ClientAdapter, broadcast_state

load_dotenv()

app = FastAPI(title="OsJa Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # für Prod enger fassen (z. B. https://joxcraft.github.io)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------- ABLY TOKEN (Frontend holt Token; Key bleibt geheim) ----------
@app.get("/auth")
def ably_token():
    key = os.environ.get("ABLY_KEY")
    if not key:
        raise HTTPException(500, "ABLY_KEY not configured")
    rest = AblyRest(key)
    token = rest.auth.request_token()
    return JSONResponse(token)

# ---------- Hilfen ----------
def get_lobby(lobby_id: str) -> g.Lobby:
    for lobby in g.lobbies:
        if lobby.id == lobby_id:
            return lobby
    raise HTTPException(404, "Lobby not found")

def ensure_client(lobby: g.Lobby, player: int) -> g.Client:
    try:
        return lobby.clients[player]
    except Exception:
        raise HTTPException(400, "Player not in lobby")

def attack_catalog() -> List[g.Attacke]:
    # Alle Attacke-Instanzen aus game_engine, außer Events (type=2)
    return [
        obj for obj in vars(g).values()
        if isinstance(obj, g.Attacke) and obj.type in (0, 1)
    ]

def map_attacks_by_name(names: List[str]) -> List[g.Attacke]:
    name2atk = {a.name: a for a in attack_catalog()}
    unknown = [n for n in names if n not in name2atk]
    if unknown:
        raise HTTPException(400, f"Unknown attack(s): {', '.join(unknown)}")
    return [name2atk[n] for n in names]

def opponent_idx(idx: int) -> int:
    return (idx + 1) % 2

def id_for_player(player_idx: int) -> str:
    return f"p{player_idx}"

def id_for_mon(player_idx: int, i: int) -> str:
    return f"p{player_idx}-m{i}"

def export_state(lobby: g.Lobby, me_id: int) -> dict:
    # Stack
    stack = []
    for a in lobby.stack.attacken:
        owner_name = lobby.clients[a.owner.spieler_id].spieler.name
        stack.append({
            "name": a.attacke.name,
            "owner": owner_name
        })

    # Friends (ich + meine Monster)
    me = lobby.clients[me_id].spieler
    friends = [{
        "id": id_for_player(me_id),
        "name": me.name,
        "hp": me.stats.leben,
        "max": me.stats.maxLeben
    }]
    for i, mon in enumerate(me.monster):
        friends.append({
            "id": id_for_mon(me_id, i),
            "name": f"Monster {i+1}",
            "hp": mon.stats.leben,
            "max": mon.stats.maxLeben
        })

    # Foes (Gegner + seine Monster)
    opp_id = opponent_idx(me_id)
    opp = lobby.clients[opp_id].spieler
    foes = [{
        "id": id_for_player(opp_id),
        "name": opp.name,
        "hp": opp.stats.leben,
        "max": opp.stats.maxLeben
    }]
    for i, mon in enumerate(opp.monster):
        foes.append({
            "id": id_for_mon(opp_id, i),
            "name": f"Monster {i+1}",
            "hp": mon.stats.leben,
            "max": mon.stats.maxLeben
        })

    # Meine Attacken (Index = meine Reihenfolge)
    self_attacks = [{"name": ab.attacke.name, "text": ab.attacke.text} for ab in me.stats.attacken]

    # Bekannte Gegner-Attacken (nur Namen/Text)
    opp_known = []
    for ab in opp.stats.attacken:
        if ab in me.atk_known:
            opp_known.append({"name": ab.attacke.name, "text": ab.attacke.text})
    # Falls in deinem Code atk_known Attacke statt Besitz enthält:
    if not opp_known and getattr(me, "atk_known", None):
        for atk in me.atk_known:
            # Robustheit: AttackeBesitz oder Attacke
            try:
                opp_known.append({"name": atk.attacke.name, "text": atk.attacke.text})
            except Exception:
                opp_known.append({"name": atk.name, "text": atk.text})

    phase_name = {0:"Anfang", 1:"Anfang(2)", 2:"Mitte", 3:"Ende(2)", 4:"Ende"}[lobby.turntime % 5] if lobby.phase==2 else "-"
    return {
        "turn": lobby.turntime // 5,
        "phase": phase_name,
        "priorityName": lobby.clients[lobby.priority].spieler.name if lobby.priority is not None else "-",
        "stack": stack,
        "friends": friends,
        "foes": foes,
        "self_attacks": self_attacks,
        "opp_known_attacks": opp_known
    }

def broadcast_both(lobby: g.Lobby):
    # Für beide Spieler den State senden (leicht unterschiedlich wäre auch möglich)
    for pid in [0,1]:
        try:
            broadcast_state(lobby.id, export_state(lobby, pid))
        except Exception:
            pass

# --- In-Memory Puffer für Auswahl/LebenZahlen ---
_pending_attacks: Dict[str, Dict[int, List[str]]] = {}
_pending_pay: Dict[str, Dict[int, int]] = {}

# ---------- Lobby ----------
@app.post("/lobby/create")
def create_lobby(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    if not lobby_id:
        raise HTTPException(400, "lobby_id required")
    # existiert schon?
    for l in g.lobbies:
        if l.id == lobby_id:
            return {"ok": True}
    lobby = g.Lobby(id=lobby_id, clients=[], phase=0)
    g.lobbies.append(lobby)
    return {"ok": True}

@app.post("/lobby/join")
async def join_lobby(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    name = payload.get("name")
    player = payload.get("player")
    if lobby_id is None or name is None or player is None:
        raise HTTPException(400, "lobby_id, name, player required")
    # existierende Lobby holen oder neu anlegen
    try:
        lobby = get_lobby(lobby_id)
    except HTTPException:
        g.lobbies.append(g.Lobby(id=lobby_id, clients=[], phase=0))
        lobby = get_lobby(lobby_id)

    # Reine Sicherheits-Deckelung: max 2 Spieler
    if len(lobby.clients) >= 2 and player >= 2:
        raise HTTPException(400, "Lobby full")

    # Ably-Client
    client = ClientAdapter(lobby_id, player)
    ok = await g.spieler_beitreten(lobby_id, name, client)
    if not ok:
        raise HTTPException(400, "Join failed")
    # Anfangsstate pushen
    broadcast_both(lobby)
    return {"ok": True}

# --------- Katalog für Screen 1 ----------
@app.get("/catalog")
def catalog():
    items = []
    for a in attack_catalog():
        items.append({
            "name": a.name,
            "text": a.text,
            "type": a.type  # 0 = normal, 1 = Rangelei
        })
    return {"attacks": items}

# --------- Attackenwahl (Screen 1) ----------
@app.post("/choose_attacks")
def choose_attacks(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    player = payload.get("player")
    names: List[str] = payload.get("attacks", [])
    if not lobby_id or player is None:
        raise HTTPException(400, "lobby_id, player required")
    lobby = get_lobby(lobby_id)
    if len(names) == 0:
        raise HTTPException(400, "Please select at least 1 attack")

    # Limit prüfen (vereinfachte Regel: max 4; wenn Verführerisches Angebot dabei: max 6)
    limit = 6 if "Verführerisches Angebot" in names else 4
    if len(names) > limit:
        raise HTTPException(400, f"Too many attacks selected (max {limit})")

    # Nur normale (type=0) in dieser Phase zulassen (wie von dir beschrieben)
    atks = map_attacks_by_name(names)
    if any(a.type == 1 for a in atks):
        raise HTTPException(400, "Rangeleien werden später gewählt (Immer vorbereitet)")

    _pending_attacks.setdefault(lobby_id, {})
    _pending_attacks[lobby_id][player] = names

    # Wenn beide Spieler gewählt haben -> engine.atk_entschieden
    if len(_pending_attacks[lobby_id]) == 2:
        c0 = ensure_client(lobby, 0)
        c1 = ensure_client(lobby, 1)
        a0 = map_attacks_by_name(_pending_attacks[lobby_id][0])
        a1 = map_attacks_by_name(_pending_attacks[lobby_id][1])
        g.atk_entschieden(lobby, c0, a0, c1, a1)
        broadcast_both(lobby)

    return {"ok": True}

# --------- Leben zahlen (Screen 2) ----------
@app.post("/pay")
async def pay(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    player = payload.get("player")
    pay_amount = int(payload.get("pay", 0))
    stop_start = bool(payload.get("stop_start", False))
    stop_end = bool(payload.get("stop_end", False))
    stop_react = bool(payload.get("stop_react", False))

    lobby = get_lobby(lobby_id)
    cli = ensure_client(lobby, player)

    # Flags setzen
    cli.spieler.stop_start = stop_start
    cli.spieler.stop_end = stop_end
    cli.spieler.stop_react = stop_react

    _pending_pay.setdefault(lobby_id, {})
    _pending_pay[lobby_id][player] = pay_amount

    # Wenn beide Spieler gezahlt haben -> engine.leben_zahlen
    if len(_pending_pay[lobby_id]) == 2:
        c0 = ensure_client(lobby, 0)
        c1 = ensure_client(lobby, 1)
        g.leben_zahlen(lobby, c0, _pending_pay[lobby_id][0], c1, _pending_pay[lobby_id][1])
        broadcast_both(lobby)

    return {"ok": True}

# --------- Priority-Flags laufend (Screen 3 Checkboxes) ----------
@app.post("/flags")
def flags(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    player = payload.get("player")
    stop_start = bool(payload.get("stop_start", False))
    stop_end = bool(payload.get("stop_end", False))
    stop_react = bool(payload.get("stop_react", False))
    lobby = get_lobby(lobby_id)
    cli = ensure_client(lobby, player)
    cli.spieler.stop_start = stop_start
    cli.spieler.stop_end = stop_end
    cli.spieler.stop_react = stop_react
    broadcast_both(lobby)
    return {"ok": True}

# --------- Attacke einsetzen (Screen 3 Button) ----------
@app.post("/use_attack")
async def use_attack(payload: Dict[str, Any]):
    lobby_id = payload.get("lobby_id")
    player = payload.get("player")
    # Für die erste Version nutzen wir **immer den Spieler selbst** als Owner/Charakter.
    # (Monster-Ziel/Owner kannst du später erweitern, wenn du IDs im Frontend mitlieferst)
    attack_index = payload.get("attack_index")
    if attack_index is None:
        raise HTTPException(400, "attack_index required")

    lobby = get_lobby(lobby_id)
    cli = ensure_client(lobby, player)
    owner = cli.spieler

    try:
        attacke_besitz = owner.stats.attacken[int(attack_index)]
    except Exception:
        raise HTTPException(400, "Invalid attack index")

    # Engine übernimmt Target-Abfragen via Ably Prompts
    await g.attacke_gewählt(lobby, owner, attacke_besitz)

    # Nach Ausführung neuen State broadcasten
    broadcast_both(lobby)
    return {"ok": True}

# --- optionaler manueller State-Push (Debug) ---
@app.get("/state")
def state(lobby_id: str, player: int = 0):
    lobby = get_lobby(lobby_id)
    return export_state(lobby, player)
