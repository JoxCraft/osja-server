from __future__ import annotations
import asyncio
from typing import Any
import engine as eng

# ---------- Cleanup: stale lobbies löschen ----------
def cleanup_lobbies():
    # lösche Lobbys, die in fortgeschrittener Phase sind, aber nicht voll
    eng.lobbies[:] = [l for l in eng.lobbies if not (l.phase > 0 and len(l.clients) < 2)]

# ---------- Registry (robust, no dict by name) ----------
def _collect_attacks():
    attacks = []
    for _, obj in eng.__dict__.items():
        if isinstance(obj, eng.Attacke):
            attacks.append(obj)  # keep duplicates, e.g. two "Gedankenkontrolle"
    return attacks

ATTACKS = _collect_attacks()

# ---------- Lobby Helpers ----------
def get_lobby(code:str) -> eng.Lobby:
    for l in eng.lobbies:
        if l.id == code:
            return l
    raise RuntimeError(f"Lobby not found: {code!r}. Existing: {[lb.id for lb in eng.lobbies]}")

def create_lobby(code:str):
    cleanup_lobbies()
    if not any(l.id == code for l in eng.lobbies):
        eng.lobbies.append(eng.Lobby(code, clients=[]))

async def spieler_beitreten_py(code:str, name:str, client_obj:Any) -> bool:
    cleanup_lobbies()
    return await eng.spieler_beitreten(code, name, client_obj)

def _client_by_name(lobby:eng.Lobby, name:str) -> eng.Client:
    for c in lobby.clients:
        if c.spieler.name == name:
            return c
    raise RuntimeError(f"player not found: {name!r}. In lobby: {[cl.spieler.name for cl in lobby.clients]}")

# ---------- Pools ----------
def _attack_type_counts():
    # for diagnostics
    counts = {0:0, 1:0, 2:0}
    for a in ATTACKS:
        t = getattr(a, "type", None)
        if t in counts:
            counts[t] += 1
    return counts

def get_pool(lobby_code:str, phase:int, rangeleien:bool=False):
    """
    Screen 1: Attackenliste (nur Grund-Keywords).
    - Normale: type==0
    - Rangeleien: type==1
    """
    pool = []
    for a in ATTACKS:
        if (not rangeleien and a.type == 0) or (rangeleien and a.type == 1):
            pool.append({
                "name": a.name,
                "text": a.text,
                "keywords": [k.name for k in a.keywords],
            })
    pool.sort(key=lambda x: x["name"].lower())

    # DIAGNOSTIC: if empty, raise with counts so you see the real reason in console
    if not pool:
        counts = _attack_type_counts()
        raise RuntimeError(
            f"get_pool() returned empty. counts by type: {counts}. "
            f"rangeleien={rangeleien}. Did engine.Attacke declarations load?"
        )

    return pool

# ---------- Auswahl & Phasen ----------
_selected = {}
_paid = {}

def submit_attacks(lobby_code:str, player_name:str, picks:list[str], rangeleien:bool=False):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)

    if not rangeleien:
        c.spieler.stats.attacken.clear()
        for n in picks:
            # pick by first match name (may be multiple with same name; UI is name-based)
            matches = [a for a in ATTACKS if a.name == n]
            if not matches:
                raise RuntimeError(f"submit_attacks: unknown attack name {n!r}")
            c.spieler.stats.attacken.append(eng.AttackeBesitz(attacke=matches[0]))
        # Passive dem Gegner verraten
        for ab in c.spieler.stats.attacken:
            if eng.Passiv in ab.attacke.keywords:
                other = lobby.clients[(c.spieler.spieler_id - 1) % 2]
                if ab not in other.spieler.atk_known:
                    other.spieler.atk_known.append(ab)
        eng.apply_passives(c.spieler)
    else:
        for n in picks:
            matches = [a for a in ATTACKS if a.name == n]
            if not matches:
                raise RuntimeError(f"submit_attacks (rangeleien): unknown attack name {n!r}")
            c.spieler.stats.attacken.append(eng.AttackeBesitz(attacke=matches[0]))

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
    _paid[player_name] = max(0, int(amount))
    if len(lobby.clients)==2 and all(name in _paid for name in (lobby.clients[0].spieler.name, lobby.clients[1].spieler.name)):
        eng.leben_zahlen(
            lobby,
            lobby.clients[0], _paid[lobby.clients[0].spieler.name],
            lobby.clients[1], _paid[lobby.clients[1].spieler.name]
        )
        _paid.clear()
    return True

# ---------- UI-Aktionen Kampf ----------
def ui_pass(lobby_code:str, player_name:str):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if lobby.priority == c.spieler.spieler_id:
        eng.passen(lobby)
        return True
    return False

def _resolve_char(lobby:eng.Lobby, path:dict) -> eng.Spieler|eng.Monster:
    side = path["side"]  # "me" oder "opp"
    kind = path["kind"]  # "player" oder "monster"
    index = path["index"]
    me = lobby.clients[lobby.starting].spieler
    opp = lobby.clients[(lobby.starting - 1) % 2].spieler
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

# ---------- Snapshot ----------
def _ser_attackebesitz(ab:eng.AttackeBesitz):
    return {
        "name": ab.attacke.name,
        "text": ab.attacke.text,
        "keywords": [k.name for k in ab.attacke.keywords]
    }

def _ser_member(name, s:eng.Stats, is_player=True):
    return {
        "name": name,
        "hp": s.leben,
        "max": s.maxLeben,
        "spott": bool(s.spott),
        "attacks": [_ser_attackebesitz(ab) for ab in s.attacken]
    }

def lobby_snapshot(lobby_code:str):
    cleanup_lobbies()
    lobby = get_lobby(lobby_code)

    # Screen selection by phase
    if lobby.phase == 0:
        scr = 1  # attack selection
    elif lobby.phase == 1:
        scr = 2  # pay life
    elif lobby.phase == 2:
        scr = 3  # combat
    elif lobby.phase == 3:
        scr = 4  # end
    else:
        scr = 1

    # Safe guards: starting/priority can be None before payment
    has_two = len(lobby.clients) == 2
    has_start = lobby.starting is not None and has_two
    has_prio = lobby.priority is not None and has_two

    state = {
        "screen": scr,
        "turn": lobby.turntime // 5,
        "turntime": lobby.turntime,
        "reaction": bool(lobby.reaktion),
        "priority_name": (lobby.clients[lobby.priority].spieler.name if has_prio else "-"),
        "stack": [],
        "me": None,
        "opp": None,
        "opp_known": []
    }

    # Stack view (safe even early)
    if has_two and lobby.starting is not None:
        me_player = lobby.clients[lobby.starting].spieler
    else:
        me_player = lobby.clients[0].spieler if lobby.clients else None

    for e in lobby.stack.attacken:
        # color needs me_player to compare sides; fallback if missing
        if me_player is not None:
            color = "blue" if e.attacke.type == 2 else (
                "green" if (not e.owner.is_monster and e.owner.spieler_id == me_player.spieler_id) else "red"
            )
        else:
            color = "blue" if e.attacke.type == 2 else "green"
        tgts = []
        if e.t_1 is not None: tgts.append("t1")
        if e.t_atk is not None: tgts.append("t_atk")
        if e.t_stk is not None: tgts.append(f"stack#{e.t_stk}")
        if e.t_2 is not None: tgts.append("t2")
        owner_name = lobby.clients[e.owner.spieler_id].spieler.name if len(lobby.clients) > e.owner.spieler_id else "?"
        state["stack"].append({
            "name": e.attacke.name,
            "owner": owner_name,
            "color": color,
            "targets": tgts
        })

    # Me / Opp only once starting is defined (after payment)
    if has_start:
        me = lobby.clients[lobby.starting].spieler
        opp = lobby.clients[(lobby.starting - 1) % 2].spieler
        state["me"] = _ser_member(me.name, me.stats, True)
        state["me"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(me.monster)]
        state["opp"] = _ser_member(opp.name, opp.stats, True)
        state["opp"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(opp.monster)]
        state["opp_known"] = [_ser_attackebesitz(ab) for ab in lobby.clients[me.spieler_id].spieler.atk_known]
    else:
        # early phases: still show both players minimally if present
        if len(lobby.clients) >= 1:
            p0 = lobby.clients[0].spieler
            state["me"] = _ser_member(p0.name, p0.stats, True)
            state["me"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(p0.monster)]
        if len(lobby.clients) >= 2:
            p1 = lobby.clients[1].spieler
            state["opp"] = _ser_member(p1.name, p1.stats, True)
            state["opp"]["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(p1.monster)]
        # opp_known unknown before starting side; leave empty

    return state
