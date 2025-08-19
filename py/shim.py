from __future__ import annotations
import asyncio
from typing import Any
import engine as eng

def _ensure_tmp(lobby: eng.Lobby):
    # pro Lobby ein Puffer:
    #   pid (int) -> {"base": [Attacke], "rgl": [Attacke] | None, "complete": bool}
    if not hasattr(lobby, "_tmp"):
        lobby._tmp = {}

def _player_id_by_name(lobby: eng.Lobby, player_name: str) -> int:
    for c in lobby.clients:
        if c.spieler.name == player_name:
            return c.spieler.spieler_id
    raise RuntimeError(f"player not found: {player_name!r}")
# --- Resolver relativ zur Besitzer-Perspektive (owner_id) ---
def _resolve_char_rel(lobby: eng.Lobby, owner_id: int, sel: dict):
    side = sel.get("side")
    kind = sel.get("kind")
    idx = int(sel.get("index", 0))

    if side == "me":
        sp = lobby.clients[owner_id].spieler
    else:
        sp = lobby.clients[(owner_id - 1) % 2].spieler

    if kind == "player":
        return sp
    try:
        return sp.monster[idx]
    except Exception:
        return sp

def _find_ab_by_id_in_stats(stats: eng.Stats, ab_id: int):
    for ab in stats.attacken:
        if id(ab) == ab_id:
            return ab
    return None

# --- Python-Proxy, der JS-Auswahl in echte Engine-Objekte wandelt ---
class PyClient:
    def __init__(self, lobby: eng.Lobby, owner_id: int, js_client):
        self.lobby = lobby
        self.owner_id = owner_id
        self.js = js_client

    async def message(self, text: str):
        return await self.js.message(text)

    async def win(self):
        return await self.js.win()

    async def getcharactertarget(self):
        sel = await self.js.getcharactertarget()   # JsProxy oder dict
        try:
            sel = sel.to_py()
        except Exception:
            pass
        if sel is None:
            sel = {}
        return _resolve_char_rel(self.lobby, self.owner_id, sel)

    async def getatktarget(self):
        sel = await self.js.getatktarget()         # JsProxy mit {"charPath":{...}, "ab_id":int}
        try:
            sel = sel.to_py()
        except Exception:
            pass
        if sel is None:
            sel = {}

        ch_path = sel.get("charPath", {}) or {}
        try:
            ch_path = ch_path.to_py()
        except Exception:
            pass

        ch = _resolve_char_rel(self.lobby, self.owner_id, ch_path)
        ab = _find_ab_by_id_in_stats(ch.stats, int(sel.get("ab_id", 0)))
        return ch, ab

    async def getstacktarget(self):
        idx = await self.js.getstacktarget()       # Zahl oder JsProxy
        try:
            idx = int(idx)
        except Exception:
            pass
        return idx




# --- benutze PyClient beim Beitritt ---
async def spieler_beitreten_py(lobby_code: str, spielername: str, js_client):
    create_lobby(lobby_code) if not any(l.id == lobby_code for l in eng.lobbies) else None
    # Engine-Join, danach JS-Client durch PyClient ersetzen
    ok = await eng.spieler_beitreten(lobby_code, spielername, js_client)
    if not ok:
        return False
    lobby = get_lobby(lobby_code)
    # finde den soeben eingetragenen Client und wrappe ihn
    for i, c in enumerate(lobby.clients):
        if c.spieler.name == spielername:
            lobby.clients[i].client = PyClient(lobby, c.spieler.spieler_id, js_client)
            break
    return True

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

def submit_attacks(lobby_code: str, player_name: str, picks: list[str], rangeleien: bool = False):
    lobby = get_lobby(lobby_code)
    pid = _player_id_by_name(lobby, player_name)  # 0 oder 1
    _ensure_tmp(lobby)

    # Namen -> Attacke-Objekte (gefiltert nach Phase)
    chosen: list[eng.Attacke] = []
    for n in picks:
        matches = [a for a in ATTACKS if a.name == n and ((not rangeleien and a.type == 0) or (rangeleien and a.type == 1))]
        if not matches:
            raise RuntimeError(f"submit_attacks: unknown or mismatched attack name {n!r}")
        chosen.append(matches[0])

    entry = lobby._tmp.get(pid, {"base": [], "rgl": None, "complete": False})

    if not rangeleien:
        # Erste Abgabe: normale Attacken merken
        entry["base"] = chosen
        entry["rgl"] = None
        # Falls "Immer vorbereitet" gewählt wurde, ist dieser Spieler noch NICHT fertig
        entry["complete"] = not any(a.name == "Immer vorbereitet" for a in chosen)
    else:
        # Zweite Abgabe (Rangeleien) nur erlaubt, wenn "Immer vorbereitet" in base ist
        if not entry["base"]:
            raise RuntimeError("Zuerst normale Attacken wählen, dann Rangeleien.")
        if not any(a.name == "Immer vorbereitet" for a in entry["base"]):
            raise RuntimeError("Rangeleien können nur gewählt werden, wenn 'Immer vorbereitet' unter den normalen Attacken gewählt wurde.")
        entry["rgl"] = chosen
        entry["complete"] = True

    lobby._tmp[pid] = entry

    # Wenn beide fertig sind → genau EINMAL an die Engine übergeben
    if len(lobby.clients) == 2 and all(lobby._tmp.get(cl.spieler.spieler_id, {}).get("complete", False) for cl in lobby.clients):
        p0 = lobby._tmp[0]
        p1 = lobby._tmp[1]
        atken0 = (p0["base"] or []) + (p0["rgl"] or [])
        atken1 = (p1["base"] or []) + (p1["rgl"] or [])
        eng.atk_entschieden(lobby, lobby.clients[0], atken0, lobby.clients[1], atken1)
        del lobby._tmp  # aufräumen
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

def _find_ab_by_id(stats: eng.Stats, ab_id: int) -> eng.AttackeBesitz | None:
    for ab in stats.attacken:
        if id(ab) == ab_id:
            return ab
    return None

async def ui_play(lobby_code:str, player_name:str, char:dict, ab_id:int):
    lobby = get_lobby(lobby_code)
    c = _client_by_name(lobby, player_name)
    me_sp = c.spieler

    if lobby.priority != me_sp.spieler_id:
        return False

    # "me"/"opp" relativ zu diesem Spieler
    side = char.get("side")
    kind = char.get("kind")
    idx = int(char.get("index", 0))

    owner = me_sp if side == "me" else lobby.clients[(me_sp.spieler_id - 1) % 2].spieler
    if kind != "player":
        try:
            owner = owner.monster[idx]
        except Exception:
            return False

    # echtes AttackeBesitz per ab_id finden
    ab = _find_ab_by_id(owner.stats, int(ab_id))
    if ab is None:
        return False

    # WICHTIG: Engine soll Targets erfragen → attacke_gewählt!
    await eng.attacke_gewählt(lobby, owner, ab)
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

def _ser_attackebesitz_full(ab: eng.AttackeBesitz):
    return {
        "ab_id": id(ab),                           # 1:1 stabile ID
        "name": ab.attacke.name,
        "text": ab.attacke.text,
        "keywords": _ser_keywords(ab),
        "atype": int(getattr(ab.attacke, "type", 0)),
    }

def _ser_attacks_full(stats: eng.Stats):
    # KEINE Dedupe – jede AttackeBesitz einzeln
    return [_ser_attackebesitz_full(ab) for ab in stats.attacken]

def _ser_member(name: str, st: eng.Stats, is_player: bool):
    return {
        "name": name,
        "hp": st.leben,
        "max": st.maxLeben,
        "spott": bool(st.spott),
        "attacks": _ser_attacks_full(st),
    }

def _ser_player(sp: eng.Spieler):
    data = _ser_member(sp.name, sp.stats, True)
    data["monsters"] = [_ser_member(f"Monster {i+1}", m.stats, False) for i, m in enumerate(sp.monster)]
    data["known"] = [_ser_attackebesitz_full(ab) for ab in sp.atk_known]   # 1:1 known
    data["flags"] = { "start": bool(sp.stop_start), "end": bool(sp.stop_end), "react": bool(sp.stop_react) }
    return data

def _char_label(lobby: eng.Lobby, ch: eng.Spieler | eng.Monster | None) -> str:
    if ch is None:
        return "-"
    if isinstance(ch, eng.Spieler):
        return ch.name
    # Monster → Besitzer + Index ermitteln
    sp = lobby.clients[ch.spieler_id].spieler
    try:
        idx = next(i for i, m in enumerate(sp.monster) if m is ch)
    except StopIteration:
        idx = -1
    postfix = f"Monster {idx+1}" if idx >= 0 else "Monster"
    return f"{sp.name} – {postfix}"

def _stack_target_label(lobby: eng.Lobby, e: eng.AttackeEingesetzt):
    labels = []
    if e.t_1 is not None:
        labels.append(f"Ziel: {_char_label(lobby, e.t_1)}")
    if e.t_atk is not None:
        try:
            nm = e.t_atk.attacke.name
        except Exception:
            nm = "?"
        labels.append(f"Attacke: {nm}")
    if e.t_stk is not None:
        try:
            other = lobby.stack.attacken[e.t_stk]
            onm = other.attacke.name
            own = lobby.clients[other.owner.spieler_id].spieler.name
            labels.append(f"Stack: {onm} ({own})")
        except Exception:
            labels.append(f"Stack: #{e.t_stk}")
    if e.t_2 is not None:
        labels.append(f"Ziel 2: {_char_label(lobby, e.t_2)}")
    return labels

def lobby_snapshot(lobby: eng.Lobby):
    # Screen/Turn-Metadaten (app.js erwartet diese Felder)
    if lobby.phase == 0:
        scr = 1
    elif lobby.phase == 1:
        scr = 2
    elif lobby.phase == 2:
        scr = 3
    elif lobby.phase == 3:
        scr = 4
    else:
        scr = 1

    has_two = len(lobby.clients) == 2
    has_prio = (lobby.priority is not None) and has_two

    state = {
        "screen": scr,
        "turn": lobby.turntime // 5,
        "turntime": lobby.turntime,
        "reaction": bool(lobby.reaktion),
        "priority_name": (lobby.clients[lobby.priority].spieler.name if has_prio else "-"),
        "stack": [],
        "players": [],
    }

    # Stack-Items mit Namen der Ziele/Attacken/Stack-Referenzen
    for idx, e in enumerate(lobby.stack.attacken):
        owner_name = lobby.clients[e.owner.spieler_id].spieler.name if len(lobby.clients) > e.owner.spieler_id else "?"
        atype = int(getattr(e.attacke, "type", 0))
        state["stack"].append({
            "index": idx,
            "name": e.attacke.name,
            "owner": owner_name,
            "atype": atype,                     # app.js färbt: blau (2), sonst grün/rot per owner
            "targets": _stack_target_label(lobby, e),
        })

    # Players (voller Datensatz, wie app.js ihn rendert)
    for i in range(len(lobby.clients)):          # WICHTIG: clients ist eine Liste, kein dict
        sp = lobby.clients[i].spieler
        state["players"].append(_ser_player(sp))

    return state

