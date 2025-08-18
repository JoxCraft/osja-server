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

async def submit_pay(lobby_code:str, player_name:str, amount:int):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    _paid[player_name] = max(0, int(amount))
    if len(lobby.clients) == 2 and all(n in _paid for n in (lobby.clients[0].spieler.name, lobby.clients[1].spieler.name)):
        await eng.leben_zahlen(
            lobby,
            lobby.clients[0], _paid[lobby.clients[0].spieler.name],
            lobby.clients[1], _paid[lobby.clients[1].spieler.name]
        )
        _paid.clear()
    return True


# ---------- UI-Aktionen Kampf ----------
async def ui_pass(lobby_code: str, player_name: str):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if lobby.priority == c.spieler.spieler_id:
        await eng.passen(lobby)  # <<< WICHTIG: await
        return True
    return False


def _resolve_char(lobby: eng.Lobby, desc: dict):
    side = desc.get("side")
    kind = desc.get("kind")
    idx = int(desc.get("index", 0))
    if side == "me":
        sp = lobby.clients[0].spieler  # UI mappt später nach Namen; hier reicht Index
    elif side == "opp":
        sp = lobby.clients[1].spieler if len(lobby.clients) > 1 else lobby.clients[0].spieler
    else:
        sp = lobby.clients[0].spieler
    if kind == "player":
        return sp
    else:
        try:
            return sp.monster[idx]
        except Exception:
            return sp

def _resolve_attackebesitz(lobby: eng.Lobby, path: dict, attack_index: int):
    ch = _resolve_char(lobby, path)
    try:
        return ch.stats.attacken[attack_index]
    except Exception:
        return None

async def ui_play(lobby_code:str, player_name:str, char:dict, attack_index:int):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    if lobby.priority != c.spieler.spieler_id:
        return False

    owner = _resolve_char(lobby, char)
    if owner.spieler_id != c.spieler.spieler_id:
        return False

    try:
        ab = owner.stats.attacken[attack_index]
    except Exception:
        return False

    # Targets aus Attacke ableiten
    t1 = t_atk = None
    t_stk = None
    t2 = None
    tg = ab.attacke.targets if hasattr(ab.attacke, "targets") else [0,0,0,0]
    t_1_req, t_atk_req, t_stk_req, t_2_req = tg

    # Falls Ziele benötigt sind: via JS auswählen lassen und hier in Python-Objekte mappen
    if t_1_req:
        sel = await lobby.clients[owner.spieler_id].client.getcharactertarget()
        t1 = _resolve_char(lobby, dict(sel))
    if t_atk_req:
        sel = await lobby.clients[owner.spieler_id].client.getatktarget()
        chdesc = dict(sel.get("charPath", {}))
        ai = int(sel.get("attackIndex", 0))
        t_atk = _resolve_attackebesitz(lobby, chdesc, ai)
    if t_stk_req:
        idx = await lobby.clients[owner.spieler_id].client.getstacktarget()
        try:
            t_stk = int(idx)
        except Exception:
            t_stk = None
    if t_2_req:
        sel = await lobby.clients[owner.spieler_id].client.getcharactertarget()
        t2 = _resolve_char(lobby, dict(sel))

    # Attacke wirklich einsetzen
    await eng.attacke_einsetzen(lobby, owner, ab, t1, t_atk, t_stk, t2)

    # Danach Stack evtl. ausführen / State ändert sich in eng.passen() – hier nur True zurück
    return True


# ---------- Snapshot ----------
def _ser_keywords(ab: eng.AttackeBesitz):
    seen = set()
    out = []
    for k in list(ab.attacke.keywords) + list(ab.x_keywords):
        nm = getattr(k, "name", str(k))
        if nm not in seen:
            seen.add(nm)
            out.append(nm)
    return out

def _ser_attackebesitz(ab: eng.AttackeBesitz):
    return {
        "name": ab.attacke.name,
        "text": ab.attacke.text,
        "keywords": _ser_keywords(ab)
    }

def _ser_attacks(stats: eng.Stats):
    out, seen_ids = [], set()
    for ab in stats.attacken:
      # Dedupe per Objekt-ID (nicht per Name, da es echte Duplikate mit gleichem Namen gibt)
      if id(ab) in seen_ids: 
          continue
      seen_ids.add(id(ab))
      out.append(_ser_attackebesitz(ab))
    return out

def _ser_member(name: str, st: eng.Stats, is_player: bool):
    return {
        "name": name,
        "hp": st.leben,
        "max": st.maxLeben,
        "spott": bool(st.spott),
        "attacks": _ser_attacks(st)  # <<< wichtig
    }

def _ser_player(sp: eng.Spieler):
    data = _ser_member(sp.name, sp.stats, True)
    data["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(sp.monster)]
    data["known"] = [_ser_attackebesitz(ab) for ab in sp.atk_known]
    data["flags"] = { "start": bool(sp.stop_start), "end": bool(sp.stop_end), "react": bool(sp.stop_react) }
    return data

def lobby_snapshot(lobby_code: str):
    cleanup_lobbies()
    lobby = get_lobby(lobby_code)

    if lobby.phase == 0: scr = 1
    elif lobby.phase == 1: scr = 2
    elif lobby.phase == 2: scr = 3
    elif lobby.phase == 3: scr = 4
    else: scr = 1

    has_two = len(lobby.clients) == 2
    has_prio = (lobby.priority is not None) and has_two

    state = {
        "screen": scr,
        "turn": lobby.turntime // 5,
        "turntime": lobby.turntime,
        "reaction": bool(lobby.reaktion),
        "priority_name": (lobby.clients[lobby.priority].spieler.name if has_prio else "-"),
        "stack": [],
        "players": []
    }

    # Stack
    for e in lobby.stack.attacken:
        owner_name = lobby.clients[e.owner.spieler_id].spieler.name if len(lobby.clients) > e.owner.spieler_id else "?"
        color = "blue" if e.attacke.type == 2 else "green"
        tgts = []
        if e.t_1 is not None: tgts.append("t1")
        if e.t_atk is not None: tgts.append("t_atk")
        if e.t_stk is not None: tgts.append(f"stack#{e.t_stk}")
        if e.t_2 is not None: tgts.append("t2")
        state["stack"].append({
            "name": e.attacke.name,
            "owner": owner_name,
            "color": color,
            "targets": tgts
        })

    for i in range(len(lobby.clients)):
        state["players"].append(_ser_player(lobby.clients[i].spieler))

    return state
