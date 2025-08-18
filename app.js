// ======= KONFIG =======
// Trage hier deinen Ably-API-Key ein (format: "key:xxxxxxxxx").
// Tipp: Erstelle in Ably einen Key mit nur Publish/Subscribe auf dem Namespace "lobby:*".
const ABLY_KEY = "ABLY-API-KEY:3wcmYg.8GQUGA:WaFbpDvdQSDdntaxL6mBMg72Om8OcOybipf-Sbs5eRc"; // <— ERSETZEN

// ======= GLOBALER UI-STATE =======
let isHost = false;
let mySide = null; // "host" | "guest"
let lobbyId = null;
let channel = null; // Ably Channel
let ably = null;
let pyodide = null;
let currentState = null; // last published state from host

// UI Elemente
const $ = (id) => document.getElementById(id);
const screen = (n) => {
  ["screen0","screen1","screen2","screen3","screen4"].forEach((id,i)=>{
    $(id).classList.toggle("hidden", i!==n);
  });
};
const log0 = (t)=>{$("log0").textContent += t+"\n"};
const log3 = (t)=>{$("log3").textContent += t+"\n"};

// ======= PYODIDE BRIDGE =======
async function loadEngine() {
  if (pyodide) return;
  pyodide = await loadPyodide();
  // Lade engine.py (liegt im Projektroot)
  const engineCode = await (await fetch("./engine.py")).text();
  await pyodide.runPythonAsync(engineCode);

  // Bridge-Code: Python-Wrapper und JS<->Pyodide RPC-Hooks
  const bridge = `
from js import pyPrompt, rpcPromptRemote, notify_local, notify_remote
from pyodide.ffi import to_js

# helper
def GET_LOBBY(lid):
    for l in lobbies:
        if l.id == lid:
            return l
    return None

class LocalClient:
    def __init__(self, lid):
        self.lid = lid
    async def message(self, txt):
        notify_local(str(txt))
    async def win(self):
        notify_local("WIN")
    async def getatktarget(self):
        sel = await pyPrompt("getatktarget", self.lid)
        return map_atktarget(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getcharactertarget(self):
        sel = await pyPrompt("getcharactertarget", self.lid)
        return map_char(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getstacktarget(self):
        sel = await pyPrompt("getstacktarget", self.lid)
        return int(sel)

class RemoteClient:
    def __init__(self, lid):
        self.lid = lid
    async def message(self, txt):
        notify_remote("message", {"text": str(txt)})
    async def win(self):
        notify_remote("win", {})
    async def getatktarget(self):
        sel = await rpcPromptRemote("getatktarget", self.lid)
        return map_atktarget(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getcharactertarget(self):
        sel = await rpcPromptRemote("getcharactertarget", self.lid)
        return map_char(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getstacktarget(self):
        sel = await rpcPromptRemote("getstacktarget", self.lid)
        return int(sel)

# mapping helper
def client_side_index(lobby, client_obj):
    for i,c in enumerate(lobby.clients):
        if c.client is client_obj:
            return i
    return 0

def resolve_side(lobby, client_obj, who):
    idx = client_side_index(lobby, client_obj)
    if who == "self":
        return lobby.clients[idx].spieler
    else:
        return lobby.clients[(idx-1)%2].spieler

def map_char(lobby, sel, client_obj):
    # sel: {who:"self"|"enemy", kind:"player"|"monster", index:int}
    base = resolve_side(lobby, client_obj, sel.get("who","self"))
    if sel.get("kind") == "player":
        return base
    else:
        mons = base.monster
        i = int(sel.get("index", 0))
        if i < 0 or i >= len(mons):
            return base
        return mons[i]

def map_atktarget(lobby, sel, client_obj):
    # sel: {char:{...}, attack_index:int}
    ch = map_char(lobby, sel.get("char", {}), client_obj)
    ai = int(sel.get("attack_index", 0))
    atks = ch.stats.attacken
    if ai < 0 or ai >= len(atks):
        ai = 0
    return ch, atks[ai]

# public state (viewer: 0=host, 1=guest)

def get_public_state(lid, viewer):
    lobby = GET_LOBBY(lid)
    if not lobby:
        return {"phase": -1}
    def dump_char(spieler, is_enemy):
        own = {
            "name": spieler.name,
            "leben": spieler.stats.leben,
            "maxLeben": spieler.stats.maxLeben,
            "spott": spieler.stats.spott,
            "atk": [{"name": ab.attacke.name, "text": ab.attacke.text} for ab in spieler.stats.attacken] if not is_enemy else [],
            "atk_known": [{"name": ab.attacke.name, "text": ab.attacke.text} for ab in spieler.atk_known],
            "mon": []
        }
        for m in spieler.monster:
            own["mon"].append({
                "leben": m.stats.leben,
                "maxLeben": m.stats.maxLeben,
                "spott": m.stats.spott,
                "atk": [{"name": ab.attacke.name, "text": ab.attacke.text} for ab in m.stats.attacken] if not is_enemy else [],
            })
        return own
    p0 = lobby.clients[0].spieler
    p1 = lobby.clients[1].spieler if len(lobby.clients)>1 else None
    state = {
        "id": lobby.id,
        "phase": lobby.phase,
        "starting": lobby.starting,
        "priority": lobby.priority,
        "turntime": lobby.turntime,
        "winner": lobby.winner,
        "players": []
    }
    if p0:
        state["players"].append(dump_char(p0, is_enemy=(viewer==1)))
    if p1:
        state["players"].append(dump_char(p1, is_enemy=(viewer==0)))
    st = []
    for e in lobby.stack.attacken:
        st.append({"name": e.attacke.name, "owner": lobby.clients[e.owner.spieler_id].spieler.name, "aus": e.ausgeführt})
    state["stack"] = st
    return state

# Attacke-Katalog (aus allen globalen Attacke-Instanzen)
ALL_ATTACKEN = [v for v in globals().values() if isinstance(v, Attacke)]

def list_attacken_of_type(t):
    return [{"name": a.name, "text": a.text} for a in ALL_ATTACKEN if a.type == t]

# High-level wrappers
async def py_host_join(lid, name_local):
    ok = await spieler_beitreten(lid, name_local, LocalClient(lid))
    return ok

async def py_host_on_remote_join(lid, name_remote):
    ok = await spieler_beitreten(lid, name_remote, RemoteClient(lid))
    return ok

# Auswahl → Attacke-Objekte

def py_collect_choices(main_names, rangelei_names):
    sel_main = []
    sel_r = []
    for a in ALL_ATTACKEN:
        if a.name in main_names and a.type==0:
            sel_main.append(a)
        if a.name in rangelei_names and a.type==1:
            sel_r.append(a)
    return sel_main, sel_r

async def py_confirm_choices(lid, main_local, rgl_local, main_remote, rgl_remote):
    lobby = GET_LOBBY(lid)
    c1, c2 = lobby.clients[0], lobby.clients[1]
    m1, rg1 = py_collect_choices(main_local, rgl_local)
    m2, rg2 = py_collect_choices(main_remote, rgl_remote)
    atk_entschieden(lobby, c1, m1+rg1, c2, m2+rg2)
    return True

def py_set_stops(lid, who, sstart, send, sreact):
    lobby = GET_LOBBY(lid)
    idx = 0 if who=="host" else 1
    sp = lobby.clients[idx].spieler
    sp.stop_start = 1 if sstart else 0
    sp.stop_end = 1 if send else 0
    sp.stop_react = 1 if sreact else 0
    return True

async def py_set_pay(lid, who, pay):
    lobby = GET_LOBBY(lid)
    idx = 0 if who=="host" else 1
    lobby.clients[idx].spieler._pay = int(pay)
    return True

async def py_commit_pay_if_ready(lid):
    lobby = GET_LOBBY(lid)
    if len(lobby.clients)<2: return False
    c1, c2 = lobby.clients[0], lobby.clients[1]
    p1 = getattr(c1.spieler, "_pay", None)
    p2 = getattr(c2.spieler, "_pay", None)
    if p1 is None or p2 is None:
        return False
    leben_zahlen(lobby, c1, p1, c2, p2)
    return True

async def py_use_attack(lid, who, char_kind, mon_index, attack_index):
    lobby = GET_LOBBY(lid)
    idx = 0 if who=="host" else 1
    owner = lobby.clients[idx].spieler if char_kind=="player" else lobby.clients[idx].spieler.monster[int(mon_index)]
    ab = owner.stats.attacken[int(attack_index)]
    await attacke_gewählt(lobby, owner, ab)
    return True

async def py_passen(lid):
    lobby = GET_LOBBY(lid)
    passen(lobby)
    await attacken_ausführen(lobby)
    return True
`;
  await pyodide.runPythonAsync(bridge);
}

// ======= ABLY =======
async function setupAbly(id){
  ably = new Ably.Realtime.Promise({ key: ABLY_KEY });
  channel = ably.channels.get(`lobby:${id}`);
  // eingehende Nachrichten
  await channel.subscribe((msg)=>{
    const { name, data } = msg;
    if (name === "join" && isHost){
      // Gast möchte beitreten
      host_onRemoteJoin(data);
    }
    if (name === "state"){
      currentState = data; // viewer-spezifisch (host/guest wird vom Host gesetzt)
      renderState();
    }
    if (name === "notify"){
      if (data.type === "message"){ log3(data.text); }
      if (data.type === "win"){ showWinner(); }
    }
    // Gast → Host: Wünsche/Aktionen
    if (isHost && name === "request:choices"){ host_storeGuestChoices(data); }
    if (isHost && name === "request:pay"){ host_storeGuestPay(data); }
    if (isHost && name === "request:move"){ host_onGuestMove(data); }
    if (isHost && name === "request:pass"){ host_onGuestPass(); }

    // RPC: Host → Gast (Prompts)
    if (!isHost && name === "rpc:prompt"){ handleRpcPrompt(data); }
    if (isHost && name === "rpc:reply"){ resolveRpc(data); }
  });
}

// ======= JS-Funktionen, die Python aufruft =======
window.notify_local = (text)=>{ log3(text); };
window.notify_remote = (type, payload)=>{ channel.publish("notify", { type, ...payload }); };

// Lokal-Prompt (Host oder Gast für eigene Eingaben)
let promptResolver = null;
window.pyPrompt = (kind, lid)=>{
  return new Promise((resolve)=>{
    promptResolver = resolve;
    if (kind === "getstacktarget") renderPromptStack();
    if (kind === "getcharactertarget") renderPromptCharacter();
    if (kind === "getatktarget") renderPromptAtkTarget();
  });
};

// RPC zu Gast: Host fordert Eingabe an
let rpcCounter = 0;
const rpcWaiters = new Map();
window.rpcPromptRemote = (kind, lid)=>{
  return new Promise((resolve)=>{
    const id = `rpc_${Date.now()}_${++rpcCounter}`;
    rpcWaiters.set(id, resolve);
    channel.publish("rpc:prompt", { id, kind });
  });
};
function resolveRpc(payload){
  const fn = rpcWaiters.get(payload.id);
  if (fn){ fn(payload.result); rpcWaiters.delete(payload.id); }
}

function handleRpcPrompt({ id, kind }){
  // Gast zeigt Overlay und antwortet
  new Promise((resolve)=>{
    promptResolver = resolve;
    if (kind === "getstacktarget") renderPromptStack();
    if (kind === "getcharactertarget") renderPromptCharacter();
    if (kind === "getatktarget") renderPromptAtkTarget();
  }).then((result)=>{
    channel.publish("rpc:reply", { id, result });
  });
}

// ======= UI-Overlays für Prompts =======
const overlay = $("overlay");
const ovTitle = $("ovTitle");
const ovBody  = $("ovBody");
$("ovCancel").onclick = ()=>{ overlay.classList.add("hidden"); if (promptResolver) promptResolver(null) };

function renderPromptCharacter(){
  overlay.classList.remove("hidden");
  ovTitle.textContent = "Wähle Ziel-Charakter";
  ovBody.innerHTML = "";
  const make = (who, kind, label, chars)=>{
    const h = document.createElement("div");
    h.innerHTML = `<div class="small">${label}</div>`;
    ovBody.appendChild(h);
    chars.forEach((c, idx)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.textContent = `${kind==='player'?'Spieler':'Monster'} – HP ${c.leben}/${c.maxLeben}`;
      el.onclick = ()=>{
        overlay.classList.add("hidden");
        promptResolver({ who, kind, index: idx });
      };
      ovBody.appendChild(el);
    });
  };
  make("self","player","Eigene Seite", [ currentState.players[0] ]);
  currentState.players[0].mon.forEach((m, i)=>{});
  // Eigene Monster
  currentState.players[0].mon.forEach((m, i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.textContent = `Eigenes Monster ${i+1} – HP ${m.leben}/${m.maxLeben}`;
    el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who:"self", kind:"monster", index:i}); };
    ovBody.appendChild(el);
  });
  // Gegner Spieler
  const g = currentState.players[1];
  const elp = document.createElement("div");
  elp.className = "item";
  elp.textContent = `Gegner – HP ${g.leben}/${g.maxLeben}`;
  elp.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who:"enemy", kind:"player", index:0}); };
  ovBody.appendChild(elp);
  // Gegner Monster
  g.mon.forEach((m, i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.textContent = `Gegner Monster ${i+1} – HP ${m.leben}/${m.maxLeben}`;
    el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who:"enemy", kind:"monster", index:i}); };
    ovBody.appendChild(el);
  });
}

function renderPromptAtkTarget(){
  overlay.classList.remove("hidden");
  ovTitle.textContent = "Wähle Attacke eines Charakters";
  ovBody.innerHTML = "";
  // Eigene Seite
  const add = (who, kind, label, char, idx)=>{
    const head = document.createElement("div");
    head.innerHTML = `<div class="small">${label}</div>`;
    ovBody.appendChild(head);
    (char.atk||[]).forEach((a, ai)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<div><strong>${a.name}</strong></div><div class="small">${a.text}</div>`;
      el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ char:{ who, kind, index: idx }, attack_index: ai }); };
      ovBody.appendChild(el);
    });
  };
  add("self","player","Eigener Spieler", currentState.players[0], 0);
  currentState.players[0].mon.forEach((m,i)=> add("self","monster",`Eigenes Monster ${i+1}`, m, i));
  add("enemy","player","Gegner Spieler", currentState.players[1], 0);
  currentState.players[1].mon.forEach((m,i)=> add("enemy","monster",`Gegner Monster ${i+1}`, m, i));
}

function renderPromptStack(){
  overlay.classList.remove("hidden");
  ovTitle.textContent = "Wähle eine Attacke aus dem Stack";
  ovBody.innerHTML = "";
  currentState.stack.forEach((s, i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div><strong>[${i}] ${s.name}</strong> <span class="small">(${s.owner})</span></div>`;
    el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver(i); };
    ovBody.appendChild(el);
  });
}

// ======= RENDER STATE =======
function renderState(){
  if (!currentState) return;
  // Phase → Screens
  if (currentState.phase === 0) screen(1);
  if (currentState.phase === 1) screen(2);
  if (currentState.phase === 2) screen(3);
  if (currentState.phase === 3) screen(4);

  // Screen 2: Bezahlen
  if (currentState.players && currentState.players[0]){
    const me = currentState.players[0];
    const maxPay = Math.max(0, (me.leben||0) - 200);
    $("lifeInfo").textContent = `Dein Leben: ${me.leben}/${me.maxLeben} – Max. zahlbar: ${maxPay}`;
    $("payInput").max = maxPay;
  }

  // Screen 3: Kampf-Infos
  if (currentState.phase === 2){
    $("turnInfo").textContent = `Zug: ${Math.floor((currentState.turntime||0)/5)}`;
    const tt = (currentState.turntime||0)%5;
    $("timeInfo").textContent = `Zeitfenster: ${["Anfang A","Anfang B","Mitte","Ende B","Ende A"][tt]||"-"}`;
    const prIdx = currentState.priority ?? 0;
    $("prioInfo").textContent = `Priority: ${currentState.players[prIdx===0?0:1]?.name||"-"}`;

    // Stack
    const stack = $("stack");
    stack.innerHTML = "";
    (currentState.stack||[]).forEach((s)=>{
      const el = document.createElement("div");
      el.className = "item friend";
      if (s.owner === (currentState.players[0]?.name)) el.classList.add("friend"); else el.classList.add("enemy");
      el.innerHTML = `<div><strong>${s.name}</strong> <span class="small">(${s.owner})</span></div>`;
      stack.appendChild(el);
    });

    // Charaktere
    const myChars = $("myChars"); myChars.innerHTML = "";
    const oppChars = $("oppChars"); oppChars.innerHTML = "";

    const me = currentState.players[0];
    const opp = currentState.players[1];

    const addChar = (root, char, label)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<div><strong>${label}</strong></div><div class="small">HP ${char.leben}/${char.maxLeben}${char.spott?" • Spott":""}</div>`;
      el.onclick = ()=>{ selectCharacter(root===myChars?"self":"enemy", label.includes("Monster")?"monster":"player", label.includes("Monster")?parseInt(label.split(" ")[2])-1:0 ); };
      root.appendChild(el);
    };

    addChar(myChars, me, "Spieler");
    (me.mon||[]).forEach((m,i)=> addChar(myChars, m, `Monster ${i+1}`));
    addChar(oppChars, opp, "Gegner");
    (opp.mon||[]).forEach((m,i)=> addChar(oppChars, m, `Monster ${i+1}`));
  }
}

let selected = { who:"self", kind:"player", monIndex:0, atkIndex:0 };
function selectCharacter(who, kind, monIndex){
  selected.who = who; selected.kind = kind; selected.monIndex = monIndex||0; renderAttackList();
}
function renderAttackList(){
  const list = $("atkList"); list.innerHTML = "";
  const char = (selected.who==="self") ? (selected.kind==="player"? currentState.players[0] : currentState.players[0].mon[selected.monIndex])
                                       : (selected.kind==="player"? currentState.players[1] : currentState.players[1].mon[selected.monIndex]);
  const attacks = (selected.who==="self") ? (char.atk||[]) : (char.atk_known||[]);
  attacks.forEach((a,i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div><strong>${a.name}</strong></div><div class="small">${a.text}</div>`;
    el.onclick = ()=>{ document.querySelectorAll('#atkList .item').forEach(n=>n.classList.remove('sel')); el.classList.add('sel'); selected.atkIndex=i; };
    list.appendChild(el);
  });
}

function showWinner(){
  $("winner").textContent = `Sieger: ${currentState?.winner || "—"}`;
  screen(4);
}

// ======= HOST-LOGIK =======
let hostChoices = { local:{main:[],rgl:[]}, guest:{main:[],rgl:[]} };
async function host_onRemoteJoin(data){
  await pyodide.runPythonAsync(`await py_host_on_remote_join('${lobbyId}', '${(data.name||'Gast').replace(/'/g,"\\'")}')`);
  // Sende initiale Auswahl-Listen an beide Seiten
  await publishStateFromHost();
  screen(1);
}
function host_storeGuestChoices(data){ hostChoices.guest = { main:data.main||[], rgl:data.rgl||[] }; tryConfirmChoices(); }
function host_storeGuestPay(data){ host_setPay("guest", data.pay||0); }
async function host_onGuestMove(data){ await pyodide.runPythonAsync(`await py_use_attack('${lobbyId}','guest','${data.kind}','${data.monIndex||0}','${data.atkIndex}')`); await publishStateFromHost(); }
async function host_onGuestPass(){ await pyodide.runPythonAsync(`await py_passen('${lobbyId}')`); await publishStateFromHost(); }

async function tryConfirmChoices(){
  const okLocal = hostChoices.local.main.length>0; const okGuest = hostChoices.guest.main.length>0;
  if (!okLocal || !okGuest) return;
  await pyodide.runPythonAsync(`await py_confirm_choices('${lobbyId}', ${JSON.stringify(hostChoices.local.main)}, ${JSON.stringify(hostChoices.local.rgl)}, ${JSON.stringify(hostChoices.guest.main)}, ${JSON.stringify(hostChoices.guest.rgl)})`);
  await publishStateFromHost();
}
async function host_setPay(who, pay){
  await pyodide.runPythonAsync(`await py_set_pay('${lobbyId}','${who==='guest'?'guest':'host'}', ${parseInt(pay)||0})`);
  const done = await pyodide.runPythonAsync(`await py_commit_pay_if_ready('${lobbyId}')`);
  if (done){ await publishStateFromHost(); }
}

async function publishStateFromHost(){
  const viewerHost = await pyodide.runPythonAsync(`get_public_state('${lobbyId}', 0)`);
  const viewerGuest = await pyodide.runPythonAsync(`get_public_state('${lobbyId}', 1)`);
  // An Host lokal rendern & an beide Seiten senden
  currentState = viewerHost.toJs(); renderState();
  await channel.publish("state", viewerGuest.toJs()); // an Gast
  // Und Host-Ansicht auch als state schicken (praktisch falls zweites Tab als Host offen)
  await channel.publish("state", viewerHost.toJs());
}

// ======= SCREEN 0: Host/Join =======
$("btnHost").onclick = async ()=>{
  lobbyId = $("inLobby").value.trim(); if (!lobbyId) return;
  mySide = "host"; isHost = true; log0("Starte Host...");
  await setupAbly(lobbyId);
  await loadEngine();
  // Host beitritt (lokaler Spieler A)
  const name = $("inName").value.trim()||"Host";
  await pyodide.runPythonAsync(`await py_host_join('${lobbyId}', '${name.replace(/'/g,"\\'")}')`);
  // Warte auf Gast → Screen 1, sobald join kommt
  log0("Bereit. Gast kann jetzt mit der gleichen Lobby-ID joinen.");
};

$("btnJoin").onclick = async ()=>{
  lobbyId = $("inLobby").value.trim(); if (!lobbyId) return;
  mySide = "guest"; isHost = false; log0("Trete bei...");
  await setupAbly(lobbyId);
  await loadEngine(); // Nur für UI/Prompts nötig – Engine läuft beim Host
  // dem Host unseren Namen schicken
  const name = $("inName").value.trim()||"Gast";
  await channel.publish("join", { name });
  screen(1); // Warte auf Host-Listen / State
};

// ======= SCREEN 1: Attacken wählen =======
const listMain = $("listMain");
const listRgl  = $("listRgl");
let atkMain = []; let atkRgl = [];
let selMain = new Set(); let selRgl = new Set();

async function loadAttackLists(){
  const main = await pyodide.runPythonAsync("list_attacken_of_type(0)");
  const rgl  = await pyodide.runPythonAsync("list_attacken_of_type(1)");
  atkMain = main.toJs(); atkRgl = rgl.toJs();
  renderAtkLists();
}
function renderAtkLists(){
  listMain.innerHTML = ""; listRgl.innerHTML="";
  const add = (root, arr, selSet)=>{
    arr.forEach((a)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<div><strong>${a.name}</strong></div><div class=small>${a.text}</div>`;
      el.onclick = ()=>{ if (selSet.has(a.name)) selSet.delete(a.name); else selSet.add(a.name); el.classList.toggle("sel"); updateChoicePill(); };
      root.appendChild(el);
    });
  };
  add(listMain, atkMain, selMain); add(listRgl, atkRgl, selRgl);
}
function hasVeroffer(selSet){ return [...selSet].includes("Verführerisches Angebot"); }
function hasImmer(selSet){ return [...selSet].includes("Immer vorbereitet"); }
function updateChoicePill(){
  const max = hasVeroffer(selMain) ? 6 : 4;
  $("maxAtk").textContent = String(max);
  $("pillChoice").textContent = `${selMain.size} Haupt / ${selRgl.size} Rangelei`;
}

$("btnConfirmAtk").onclick = async ()=>{
  const max = hasVeroffer(selMain) ? 6 : 4;
  if (selMain.size === 0 || selMain.size > max){ alert(`Bitte zwischen 1 und ${max} Haupt-Attacken wählen.`); return; }
  if (hasImmer(selMain) && selRgl.size !== 3){ alert("Bei \"Immer vorbereitet\" genau 3 Rangeleien auswählen."); return; }
  if (isHost){
    hostChoices.local = { main:[...selMain], rgl:[...selRgl] };
    tryConfirmChoices();
  } else {
    await channel.publish("request:choices", { main:[...selMain], rgl:[...selRgl] });
  }
  // Warte auf Host-State → automatisch Screen-Wechsel
};

// ======= SCREEN 2: Leben zahlen =======
$("btnPay").onclick = async ()=>{
  const pay = parseInt($("payInput").value||0);
  if (isHost) await host_setPay("host", pay); else await channel.publish("request:pay", { pay });
};

// ======= SCREEN 3: Kampf =======
$("cbStart").onchange = $("cbEnd").onchange = $("cbReact").onchange = async ()=>{
  await pyodide.runPythonAsync(`py_set_stops('${lobbyId}','${isHost?"host":"guest"}', ${$("cbStart").checked?1:0}, ${$("cbEnd").checked?1:0}, ${$("cbReact").checked?1:0})`);
  if (isHost) await publishStateFromHost();
};

$("btnPass").onclick = async ()=>{
  if (isHost){ await pyodide.runPythonAsync(`await py_passen('${lobbyId}')`); await publishStateFromHost(); }
  else { await channel.publish("request:pass", {}); }
};

$("btnUse").onclick = async ()=>{
  if (selected.who !== "self"){ alert("Du kannst nur eigene Attacken wählen."); return; }
  if (isHost){
    await pyodide.runPythonAsync(`await py_use_attack('${lobbyId}','host','${selected.kind}','${selected.monIndex||0}','${selected.atkIndex||0}')`);
    await publishStateFromHost();
  } else {
    await channel.publish("request:move", { kind:selected.kind, monIndex:selected.monIndex||0, atkIndex:selected.atkIndex||0 });
  }
};

// ======= START =======
(async function init(){
  await loadEngine();
  await loadAttackLists();
  screen(0);
})();
