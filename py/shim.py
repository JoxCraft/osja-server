# py/shim.py
import asyncio, json
from typing import Any
import engine as eng

# ---- Hilfen ----

def _attack_registry():
    reg = {}
    for name, obj in eng.__dict__.items():
        if isinstance(obj, eng.Attacke):
            reg[obj.name] = obj
    return reg

ATTACK = _attack_registry()

def get_lobby(code:str) -> eng.Lobby:
    for l in eng.lobbies:
        if l.id == code:
            return l
    raise RuntimeError("Lobby not found")

def create_lobby(code:str):
    # Vorher aufräumen: unvollständige Lobbys mit phase>0 entfernen
    eng.lobbies[:] = [l for l in eng.lobbies if not (l.phase > 0 and len(l.clients) < 2)]
    if not any(l.id == code for l in eng.lobbies):
        eng.lobbies.append(eng.Lobby(code, clients=[]))

async def spieler_beitreten_py(code:str, name:str, client_obj:Any) -> bool:
    # Cleanup: unvollständige Lobbys mit phase>0 löschen
    eng.lobbies[:] = [l for l in eng.lobbies if not (l.phase > 0 and len(l.clients) < 2)]
    return await eng.spieler_beitreten(code, name, client_obj)

# ---- Pools ----

def get_pool(lobby_code:str, phase:int, rangeleien:bool=False):
    """
    Für Screen 1: gib Attacken zur Anzeige.
    - Normale: type==0
    - Rangeleien: type==1
    Nur Grund-Keywords.
    """
    pool = []
    for a in ATTACK.values():
        if (not rangeleien and a.type==0) or (rangeleien and a.type==1):
            pool.append({
                "name": a.name,
                "text": a.text,
                "keywords": [k.name for k in a.keywords]
            })
    pool.sort(key=lambda x: x["name"].lower())
    return pool

# ---- Auswahl & Phasen ----

_selected = {}
_paid = {}

def _client_by_name(lobby:eng.Lobby, name:str) -> eng.Client:
    for c in lobby.clients:
        if c.spieler.name == name:
            return c
    raise RuntimeError("player not found")

def submit_attacks(lobby_code:str, player_name:str, picks:list[str], rangeleien:bool=False):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if not rangeleien:
        c.spieler.stats.attacken.clear()
        for n in picks:
            if n not in ATTACK: return False
            c.spieler.stats.attacken.append(eng.AttackeBesitz(attacke=ATTACK[n]))
        # Passives offenlegen
        for ab in c.spieler.stats.attacken:
            if eng.Passiv in ab.attacke.keywords:
                other = lobby.clients[ (c.spieler.spieler_id - 1) % 2 ]
                if ab not in other.spieler.atk_known:
                    other.spieler.atk_known.append(ab)
        eng.apply_passives(c.spieler)
    else:
        c.spieler.stats.attacken.extend([eng.AttackeBesitz(attacke=ATTACK[n]) for n in picks])

    _selected[player_name] = True
    if len(lobby.clients)==2 and all(_selected.get(cl.spieler.name) for cl in lobby.clients):
        eng.atk_entschieden(
            lobby,
            lobby.clients[0], [ab.attacke for ab in lobby.clients[0].spieler.stats.attacken],
            lobby.clients[1], [ab.attacke for ab in lobby.clients[1].spieler.stats.attacken],
        )
        _selected.clear()
    return True

def set_flags(lobby_code:str, player_name:str, start:bool, end:bool, react:bool):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    c.spieler.stop_start = bool(start)
    c.spieler.stop_end = bool(end)
    c.spieler.stop_react = bool(react)
    return True

def submit_pay(lobby_code:str, player_name:str, amount:int):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    _paid[player_name] = amount
    if len(lobby.clients)==2 and all(name in _paid for name in (lobby.clients[0].spieler.name, lobby.clients[1].spieler.name)):
        eng.leben_zahlen(lobby, lobby.clients[0], _paid[lobby.clients[0].spieler.name], lobby.clients[1], _paid[lobby.clients[1].spieler.name])
        _paid.clear()
    return True

# ---- UI-Aktionen Kampf ----

def ui_pass(lobby_code:str, player_name:str):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if lobby.priority == c.spieler.spieler_id:
        eng.passen(lobby)
        return True
    return False

def _resolve_char(lobby:eng.Lobby, path:dict) -> eng.Spieler|eng.Monster:
    side = path["side"]
    kind = path["kind"]
    index = path["index"]
    me = lobby.clients[ lobby.starting ].spieler
    opp = lobby.clients[ (lobby.starting - 1) % 2 ].spieler
    owner = me if side=="me" else opp
    if kind == "player":
        return owner
    else:
        return owner.monster[index]

def ui_play(lobby_code:str, player_name:str, char:dict, attack_index:int):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if lobby.priority != c.spieler.spieler_id:
        return False
    target = _resolve_char(lobby, char)
    if target.spieler_id != c.spieler.spieler_id:
        return False
    try:
        ab = target.stats.attacken[attack_index]
    except Exception:
        return False
    asyncio.create_task(eng.attacke_gewählt(lobby, target, ab))
    return True

# ---- Snapshot ----

def _ser_attackebesitz(ab:eng.AttackeBesitz):
    return {
        "name": ab.attacke.name,
        "text": ab.attacke.text,
        "keywords": [k.name for k in ab.attacke.keywords]
    }

def _ser_member(name, s:eng.Stats, is_player=True):
    data = {
        "name": name,
        "hp": s.leben,
        "max": s.maxLeben,
        "spott": bool(s.spott),
        "attacks": [_ser_attackebesitz(ab) for ab in s.attacken]
    }
    return data

def lobby_snapshot(lobby_code:str):
    lobby = get_lobby(lobby_code)
    if lobby.phase == 0: scr = 1
    elif lobby.phase == 1: scr = 2
    elif lobby.phase == 2: scr = 3
    elif lobby.phase == 3: scr = 4
    else: scr = 1

    me = lobby.clients[lobby.starting].spieler if lobby.clients else None
    opp = lobby.clients[(lobby.starting - 1) % 2].spieler if len(lobby.clients)==2 else None

    state = {
        "screen": scr,
        "turn": lobby.turntime // 5,
        "turntime": lobby.turntime,
        "reaction": bool(lobby.reaktion),
        "priority_name": lobby.clients[lobby.priority].spieler.name if lobby.priority is not None else "-",
        "stack": [],
        "me": None,
        "opp": None,
        "opp_known": []
    }

    for e in lobby.stack.attacken:
        color = "blue" if e.attacke.type==2 else ("green" if (not e.owner.is_monster and e.owner.spieler_id==me.spieler_id) else "red")
        tgts = []
        if e.t_1 is not None: tgts.append("t1")
        if e.t_atk is not None: tgts.append("t_atk")
        if e.t_stk is not None: tgts.append(f"stack#{e.t_stk}")
        if e.t_2 is not None: tgts.append("t2")
        state["stack"].append({
            "name": e.attacke.name,
            "owner": lobby.clients[e.owner.spieler_id].spieler.name,
            "color": color,
            "targets": tgts
        })

    if me:
        state["me"] = _ser_member(me.name, me.stats, True)
        state["me"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i,m in enumerate(me.monster)]
    if opp:
        state["opp"] = _ser_member(opp.name, opp.stats, True)
        state["opp"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i,m in enumerate(opp.monster)]
        state["opp_known"] = [_ser_attackebesitz(ab) for ab in lobby.clients[me.spieler_id].spieler.atk_known] if me else []

    return state
