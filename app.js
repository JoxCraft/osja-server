// ======= KONFIG =======
const ABLY_KEY = "ABLY-API-KEY:3wcmYg.8GQUGA:WaFbpDvdQSDdntaxL6mBMg72Om8OcOybipf-Sbs5eRc"; // <— deinen Key eintragen

// ======= GLOBALER UI-STATE =======
let isHost = false;
let mySide = null;         // "host" | "guest"
let lobbyId = null;
let channel = null;
let ably = null;
let pyodide = null;
let currentState = null;

// UI helpers
const $ = (id) => document.getElementById(id);
const screen = (n) => ["screen0","screen1","screen2","screen3","screen4"]
  .forEach((id,i)=>$(id).classList.toggle("hidden", i!==n));
const log0 = (t)=>{$("log0").textContent += t+"\n"};
const log3 = (t)=>{$("log3").textContent += t+"\n"};

// ======= PYODIDE BRIDGE =======
async function loadEngine(){
  if (pyodide) return;
  pyodide = await loadPyodide();
  const engineCode = await (await fetch("./engine.py")).text();
  await pyodide.runPythonAsync(engineCode);

  const bridge = `
from js import pyPrompt, rpcPromptRemote, notify_local, notify_remote
from pyodide.ffi import to_js

def _maintain():
    try:
        global lobbies
        lobbies[:] = [lb for lb in lobbies if not (lb.phase > 0 and len(lb.clients) < 2)]
    except Exception:
        pass

def GET_LOBBY(lid):
    _maintain()
    for l in lobbies:
        if l.id == lid:
            return l
    return None

class LocalClient:
    def __init__(self, lid): self.lid = lid
    async def message(self, txt): notify_local(str(txt))
    async def win(self): notify_local("WIN")
    async def getatktarget(self): sel = await pyPrompt("getatktarget", self.lid); return map_atktarget(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getcharactertarget(self): sel = await pyPrompt("getcharactertarget", self.lid); return map_char(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getstacktarget(self): sel = await pyPrompt("getstacktarget", self.lid); return int(sel)

class RemoteClient:
    def __init__(self, lid): self.lid = lid
    async def message(self, txt): notify_remote("message", {"text": str(txt)})
    async def win(self): notify_remote("win", {})
    async def getatktarget(self): sel = await rpcPromptRemote("getatktarget", self.lid); return map_atktarget(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getcharactertarget(self): sel = await rpcPromptRemote("getcharactertarget", self.lid); return map_char(GET_LOBBY(self.lid), sel.to_py(), self)
    async def getstacktarget(self): sel = await rpcPromptRemote("getstacktarget", self.lid); return int(sel)

def client_side_index(lobby, client_obj):
    for i,c in enumerate(lobby.clients):
        if c.client is client_obj: return i
    return 0

def resolve_side(lobby, client_obj, who):
    idx = client_side_index(lobby, client_obj)
    return lobby.clients[idx].spieler if who=="self" else lobby.clients[(idx-1)%2].spieler

def map_char(lobby, sel, client_obj):
    base = resolve_side(lobby, client_obj, sel.get("who","self"))
    if sel.get("kind") == "player": return base
    mons = base.monster; i = int(sel.get("index", 0))
    return base if i<0 or i>=len(mons) else mons[i]

def map_atktarget(lobby, sel, client_obj):
    ch = map_char(lobby, sel.get("char", {}), client_obj)
    ai = int(sel.get("attack_index", 0))
    atks = ch.stats.attacken
    if ai<0 or ai>=len(atks): ai=0
    return ch, atks[ai]

def get_public_state(lid, viewer):
    _maintain()
    lobby = GET_LOBBY(lid)
    if not lobby: return {"phase": -1}
    def dump_char(sp, is_enemy):
        def dump_ab(ab, show=True):
            return {"name":ab.attacke.name, "text":(ab.attacke.text if show else ""), "keywords":[k.name for k in (ab.attacke.keywords or [])]+[k.name for k in (ab.x_keywords or [])]}
        out = {"name":sp.name, "leben":sp.stats.leben, "maxLeben":sp.stats.maxLeben, "spott":sp.stats.spott,
               "atk":[dump_ab(ab, True) for ab in sp.stats.attacken] if not is_enemy else [],
               "atk_known":[dump_ab(ab, True) for ab in sp.atk_known], "mon":[]}
        for m in sp.monster:
            out["mon"].append({"leben":m.stats.leben,"maxLeben":m.stats.maxLeben,"spott":m.stats.spott,
                               "atk":[dump_ab(ab, True) for ab in m.stats.attacken] if not is_enemy else []})
        return out
    p0 = lobby.clients[0].spieler
    p1 = lobby.clients[1].spieler if len(lobby.clients)>1 else None
    state = {"id":lobby.id,"phase":lobby.phase,"starting":lobby.starting,"priority":lobby.priority,
             "turntime":lobby.turntime,"winner":lobby.winner,"players":[]}
    if p0: state["players"].append(dump_char(p0, is_enemy=(viewer==1)))
    if p1: state["players"].append(dump_char(p1, is_enemy=(viewer==0)))
    state["stack"] = [{"name":e.attacke.name,"owner":lobby.clients[e.owner.spieler_id].spieler.name,"aus":e.ausgeführt} for e in lobby.stack.attacken]
    return state

ALL_ATTACKEN = [v for v in globals().values() if isinstance(v, Attacke)]
def list_attacken_of_type(t):
    return [{"name":a.name,"text":a.text,"keywords":[k.name for k in (a.keywords or [])]} for a in ALL_ATTACKEN if a.type==t]

async def py_host_join(lid, name_local):
    return await spieler_beitreten(lid, name_local, LocalClient(lid))

async def py_host_on_remote_join(lid, name_remote):
    return await spieler_beitreten(lid, name_remote, RemoteClient(lid))

def py_collect_choices(main_names, rangelei_names):
    sel_main, sel_r = [], []
    for a in ALL_ATTACKEN:
        if a.name in main_names and a.type==0: sel_main.append(a)
        if a.name in rangelei_names and a.type==1: sel_r.append(a)
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
    _maintain()
    lobby = GET_LOBBY(lid)
    if not lobby or len(lobby.clients)<2: return False
    c1, c2 = lobby.clients[0], lobby.clients[1]
    p1 = getattr(c1.spieler, "_pay", None)
    p2 = getattr(c2.spieler, "_pay", None)
    if p1 is None or p2 is None: return False
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
  await channel.subscribe((msg)=>{
    const { name, data } = msg;
    if (name === "join" && isHost){ host_onRemoteJoin(data); }
    if (name === "state"){ currentState = data; renderState(); }
    if (name === "notify"){
      if (data.type === "message") log3(data.text);
      if (data.type === "win") showWinner();
    }
    if (isHost && name === "request:choices") host_storeGuestChoices(data);
    if (isHost && name === "request:pay")     host_storeGuestPay(data);
    if (isHost && name === "request:move")    host_onGuestMove(data);
    if (isHost && name === "request:pass")    host_onGuestPass();

    if (!isHost && name === "rpc:prompt")     handleRpcPrompt(data);
    if (isHost && name === "rpc:reply")       resolveRpc(data);
  });
}

// ======= JS-Funktionen, die Python aufruft =======
window.notify_local  = (text)=>{ log3(text); };
window.notify_remote = (type, payload)=>{ channel.publish("notify", { type, ...payload }); };

// Lokal-Prompt
let promptResolver = null;
window.pyPrompt = (kind, lid)=>{
  return new Promise((resolve)=>{
    if (!currentState || !currentState.players || currentState.players.length < 2){
      resolve(null); return;
    }
    promptResolver = resolve;
    if (kind === "getstacktarget")     renderPromptStack();
    if (kind === "getcharactertarget") renderPromptCharacter();
    if (kind === "getatktarget")       renderPromptAtkTarget();
  });
};

// RPC Host→Gast
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

// Gast verarbeitet Prompt
function handleRpcPrompt({ id, kind }){
  if (!currentState || !currentState.players || currentState.players.length < 2){
    channel.publish("rpc:reply", { id, result: null }); return;
  }
  new Promise((resolve)=>{
    promptResolver = resolve;
    if (kind === "getstacktarget")     renderPromptStack();
    if (kind === "getcharactertarget") renderPromptCharacter();
    if (kind === "getatktarget")       renderPromptAtkTarget();
  }).then((result)=> channel.publish("rpc:reply", { id, result }));
}

// ======= UI-Overlays =======
const overlay = $("overlay");
const ovTitle = $("ovTitle");
const ovBody  = $("ovBody");
$("ovCancel").onclick = ()=>{ overlay.classList.add("hidden"); if (promptResolver) promptResolver(null); };

function renderPromptCharacter(){
  overlay.classList.remove("hidden");
  ovTitle.textContent = "Wähle Ziel-Charakter";
  ovBody.innerHTML = "";

  const noteIf = (cond, text)=>{
    if (cond){ const d=document.createElement("div"); d.className="small"; d.textContent=text; ovBody.appendChild(d); }
    return cond;
  };
  if (noteIf(!currentState || !currentState.players || currentState.players.length < 2, "Noch kein zweiter Spieler verbunden – Auswahl nicht möglich.")) return;

  const addList = (who, kind, label, chars)=>{
    const h = document.createElement("div");
    h.innerHTML = `<div class="small">${label}</div>`;
    ovBody.appendChild(h);
    chars.forEach((c, idx)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.textContent = `${kind==='player'?'Spieler':'Monster'} – HP ${c.leben}/${c.maxLeben}`;
      el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who, kind, index: idx }); };
      ovBody.appendChild(el);
    });
  };

  addList("self","player","Eigene Seite", [ currentState.players[0] ]);
  currentState.players[0].mon.forEach((m, i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.textContent = `Eigenes Monster ${i+1} – HP ${m.leben}/${m.maxLeben}`;
    el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who:"self", kind:"monster", index:i}); };
    ovBody.appendChild(el);
  });

  const g = currentState.players[1];
  if (!g){ const d=document.createElement("div"); d.className="small"; d.textContent="Kein Gegner verbunden."; ovBody.appendChild(d); return; }
  const elp = document.createElement("div");
  elp.className = "item";
  elp.textContent = `Gegner – HP ${g.leben}/${g.maxLeben}`;
  elp.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ who:"enemy", kind:"player", index:0}); };
  ovBody.appendChild(elp);
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
  if (!currentState || !currentState.players || currentState.players.length < 2){
    const t=document.createElement('div'); t.className='small'; t.textContent='Noch kein Spielzustand verfügbar.'; ovBody.appendChild(t); return;
  }
  const pill = (kw)=> kw && kw.length ? `<div class=small>${kw.map(k=>`<span class="pill">${k}</span>`).join(' ')}</div>` : "";
  const add = (who, kind, label, char, idx)=>{
    const head = document.createElement("div");
    head.innerHTML = `<div class="small">${label}</div>`;
    ovBody.appendChild(head);
    (char.atk||[]).forEach((a, ai)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<div><strong>${a.name}</strong></div>${pill(a.keywords)}<div class="small">${a.text}</div>`;
      el.onclick = ()=>{ overlay.classList.add("hidden"); promptResolver({ char:{ who, kind, index: idx }, attack_index: ai }); };
      ovBody.appendChild(el);
    });
    if (!(char.atk||[]).length){ const t=document.createElement('div'); t.className='small'; t.textContent='Keine sichtbaren Attacken.'; ovBody.appendChild(t); }
  };
  add("self","player","Eigener Spieler", currentState.players[0], 0);
  currentState.players[0].mon.forEach((m,i)=> add("self","monster",`Eigenes Monster ${i+1}`, m, i));
  const g = currentState.players[1]; if (!g){ const t=document.createElement('div'); t.className='small'; t.textContent='Kein Gegner verbunden.'; ovBody.appendChild(t); return; }
  add("enemy","player","Gegner Spieler", g, 0);
  g.mon.forEach((m,i)=> add("enemy","monster",`Gegner Monster ${i+1}`, m, i));
}

function renderPromptStack(){
  overlay.classList.remove("hidden");
  ovTitle.textContent = "Wähle eine Attacke aus dem Stack";
  ovBody.innerHTML = "";
  if (!currentState || !currentState.stack || !currentState.stack.length){
    const t=document.createElement('div'); t.className='small'; t.textContent=(!currentState||!currentState.stack)?'Kein Stack verfügbar.':'Stack ist leer.'; ovBody.appendChild(t); return;
  }
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
  if (currentState.phase === 0) screen(1);
  if (currentState.phase === 1) screen(2);
  if (currentState.phase === 2) screen(3);
  if (currentState.phase === 3) screen(4);

  if (currentState.players && currentState.players[0]){
    const me = currentState.players[0];
    const maxPay = Math.max(0, (me.leben||0) - 200);
    $("lifeInfo").textContent = `Dein Leben: ${me.leben}/${me.maxLeben} – Max. zahlbar: ${maxPay}`;
    $("payInput").max = maxPay;
  }

  if (currentState.phase === 2){
    $("turnInfo").textContent = `Zug: ${Math.floor((currentState.turntime||0)/5)}`;
    const tt = (currentState.turntime||0)%5;
    $("timeInfo").textContent = `Zeitfenster: ${["Anfang A","Anfang B","Mitte","Ende B","Ende A"][tt]||"-"}`;
    const prIdx = currentState.priority ?? 0;
    $("prioInfo").textContent = `Priority: ${currentState.players[prIdx===0?0:1]?.name||"-"}`;

    const stack = $("stack");
    stack.innerHTML = "";
    (currentState.stack||[]).forEach((s)=>{
      const el = document.createElement("div");
      el.className = "item " + ((s.owner === (currentState.players[0]?.name)) ? "friend" : "enemy");
      el.innerHTML = `<div><strong>${s.name}</strong> <span class="small">(${s.owner})</span></div>`;
      stack.appendChild(el);
    });

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
    if (opp){ addChar(oppChars, opp, "Gegner"); (opp.mon||[]).forEach((m,i)=> addChar(oppChars, m, `Monster ${i+1}`)); }

    renderAttackList();
  }
}

let selected = { who:"self", kind:"player", monIndex:0, atkIndex:0 };
function selectCharacter(who, kind, monIndex){
  selected = { who, kind, monIndex: monIndex||0, atkIndex: 0 };
  renderAttackList();
}
function renderAttackList(){
  const list = $("atkList"); list.innerHTML = "";
  if (!currentState || !currentState.players || !currentState.players.length) return;
  const char = (selected.who==="self")
    ? (selected.kind==="player" ? currentState.players[0] : currentState.players[0].mon[selected.monIndex])
    : (selected.kind==="player" ? currentState.players[1] : currentState.players[1].mon[selected.monIndex]);
  const attacks = (selected.who==="self") ? (char.atk||[]) : (char.atk_known||[]);
  const pill = (kw)=> kw && kw.length ? `<div class=small>${kw.map(k=>`<span class="pill">${k}</span>`).join(' ')}</div>` : "";
  (attacks||[]).forEach((a,i)=>{
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div><strong>${a.name}</strong></div>${pill(a.keywords)}<div class="small">${a.text}</div>`;
    el.onclick = ()=>{ document.querySelectorAll('#atkList .item').forEach(n=>n.classList.remove('sel')); el.classList.add('sel'); selected.atkIndex=i; };
    list.appendChild(el);
  });
}

function showWinner(){ $("winner").textContent = `Sieger: ${currentState?.winner || "—"}`; screen(4); }

// ======= HOST-LOGIK =======
let hostChoices = { local:{main:[],rgl:[]}, guest:{main:[],rgl:[]} };

async function host_onRemoteJoin(data){
  await pyodide.runPythonAsync(`await py_host_on_remote_join('${lobbyId}', '${(data.name||'Gast').replace(/'/g,"\\'")}')`);
  await publishStateFromHost();
  screen(1);
}
function host_storeGuestChoices(data){ hostChoices.guest = { main:data.main||[], rgl:data.rgl||[] }; tryConfirmChoices(); }
function host_storeGuestPay(data){ host_setPay("guest", data.pay||0); }
async function host_onGuestMove(data){
  await pyodide.runPythonAsync(`await py_use_attack('${lobbyId}','guest','${data.kind}','${data.monIndex||0}','${data.atkIndex}')`);
  await publishStateFromHost();
}
async function host_onGuestPass(){ await pyodide.runPythonAsync(`await py_passen('${lobbyId}')`); await publishStateFromHost(); }

async function tryConfirmChoices(){
  const okLocal = hostChoices.local.main.length>0;
  const okGuest = hostChoices.guest.main.length>0;
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
  const viewerHost  = await pyodide.runPythonAsync(`get_public_state('${lobbyId}', 0)`);
  const viewerGuest = await pyodide.runPythonAsync(`get_public_state('${lobbyId}', 1)`);
  currentState = viewerHost.toJs(); renderState();
  await channel.publish("state", viewerGuest.toJs());
  await channel.publish("state", viewerHost.toJs());
}

// ======= SCREEN 0 =======
$("btnHost").onclick = async ()=>{
  lobbyId = $("inLobby").value.trim(); if (!lobbyId) return;
  mySide = "host"; isHost = true; log0("Starte Host...");
  await setupAbly(lobbyId);
  await loadEngine();
  const name = $("inName").value.trim()||"Host";
  await pyodide.runPythonAsync(`await py_host_join('${lobbyId}', '${name.replace(/'/g,"\\'")}')`);
  await publishStateFromHost();
  log0("Bereit. Gast kann jetzt joinen.");
};

$("btnJoin").onclick = async ()=>{
  lobbyId = $("inLobby").value.trim(); if (!lobbyId) return;
  mySide = "guest"; isHost = false; log0("Trete bei...");
  await setupAbly(lobbyId);
  await loadEngine(); // UI/Prompts lokal
  const name = $("inName").value.trim()||"Gast";
  await channel.publish("join", { name });
  screen(1);
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
  const pill = (kw)=> kw && kw.length ? `<div class=small>${kw.map(k=>`<span class="pill">${k}</span>`).join(' ')}</div>` : "";
  const add = (root, arr, selSet)=>{
    arr.forEach((a)=>{
      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<div><strong>${a.name}</strong></div>${pill(a.keywords)}<div class=small>${a.text}</div>`;
      el.onclick = ()=>{
        if (selSet.has(a.name)) selSet.delete(a.name); else selSet.add(a.name);
        el.classList.toggle("sel"); updateChoicePill();
      };
      root.appendChild(el);
    });
  };
  add(listMain, atkMain, selMain);
  add(listRgl, atkRgl, selRgl);
}
function hasVeroffer(){ return [...selMain].includes("Verführerisches Angebot"); }
function hasImmer(){ return [...selMain].includes("Immer vorbereitet"); }
function updateChoicePill(){
  const max = hasVeroffer() ? 6 : 4;
  $("maxAtk").textContent = String(max);
  $("pillChoice").textContent = `${selMain.size} Haupt / ${selRgl.size} Rangelei`;
}

$("btnConfirmAtk").onclick = async ()=>{
  const max = hasVeroffer() ? 6 : 4;
  if (selMain.size === 0 || selMain.size > max){ alert(`Bitte zwischen 1 und ${max} Haupt-Attacken wählen.`); return; }
  if (hasImmer() && selRgl.size !== 3){ alert('Bei "Immer vorbereitet" genau 3 Rangeleien auswählen.'); return; }
  if (isHost){
    hostChoices.local = { main:[...selMain], rgl:[...selRgl] };
    tryConfirmChoices();
  } else {
    await channel.publish("request:choices", { main:[...selMain], rgl:[...selRgl] });
  }
};

// ======= SCREEN 2: Leben zahlen =======
$("btnPay").onclick = async ()=>{
  const pay = parseInt($("payInput").value||0);
  if (isHost) await host_setPay("host", pay);
  else await channel.publish("request:pay", { pay });
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
