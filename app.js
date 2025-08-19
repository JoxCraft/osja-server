// app.js
// ==============================
// Konfiguration
// ==============================
const ABLY_API_KEY = "3wcmYg.8GQUGA:WaFbpDvdQSDdntaxL6mBMg72Om8OcOybipf-Sbs5eRc";   // <— trage deinen Ably-Key ein
const PY_ENGINE_PATH = "/py/engine.py";
const PY_SHIM_PATH   = "/py/shim.py";

// ==============================
// Globals
// ==============================
let realtime, channel, presence, clientId, hostId = null;
let pyodide, pyReady = false, isHost = false, lobbyCreated = false;
let screen = 0;
let lastState = null;

const ui = {
  screens: [...document.querySelectorAll('.screen')],
  messages: document.getElementById('messages-log'),
  // Screen 0
  name: document.getElementById('name-input'),
  lobby: document.getElementById('lobby-input'),
  joinBtn: document.getElementById('join-btn'),
  // Screen 1
  pool: document.getElementById('attacks-pool'),
  pickedCount: document.getElementById('picked-count'),
  pickedMax: document.getElementById('picked-max'),
  pickedList: document.getElementById('picked-list'),
  confirmPicks: document.getElementById('confirm-picks-btn'),
  // Screen 2
  cbStart: document.getElementById('cb-start'),
  cbEnd: document.getElementById('cb-end'),
  cbReact: document.getElementById('cb-react'),
  payInput: document.getElementById('pay-input'),
  payConfirm: document.getElementById('pay-confirm-btn'),
  oppKnown: document.getElementById('opponent-known'),
  // Screen 3
  turnNum: document.getElementById('turn-num'),
  turnPhase: document.getElementById('turn-phase'),
  priorityName: document.getElementById('priority-name'),
  cbStart3: document.getElementById('cb-start-3'),
  cbEnd3: document.getElementById('cb-end-3'),
  cbReact3: document.getElementById('cb-react-3'),
  stackView: document.getElementById('stack-view'),
  friends: document.getElementById('friends'),
  enemies: document.getElementById('enemies'),
  rightTitle: document.getElementById('rightcol-title'),
  charAttacks: document.getElementById('char-attacks'),
  passBtn: document.getElementById('pass-btn'),
  playBtn: document.getElementById('play-btn'),
  // Screen 4
  winner: document.getElementById('winner-text')
};

// Error Logging
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason || e);
  if (e && e.reason && e.reason.message) console.error(e.reason.message);
});
window.addEventListener("error", (e) => {
  console.error("Window error:", e.error || e);
});

// ==============================
// Helpers
// ==============================
function log(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  ui.messages.appendChild(el);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}
function showScreen(n) {
  screen = n;
  ui.screens.forEach((s, i) => s.classList.toggle('hidden', i !== n));
}
function phaseLabel(turntime, reaction) {
  const map = ["Anfang1", "Anfang2", "Mitte", "Ende2", "Ende1"];
  const idx = ((turntime % 5) + 5) % 5;
  return map[idx] + (reaction ? " (Reaktion)" : "");
}
function broadcast(type, data) {
  return channel.publish(type, data);
}

// JSON-safe Python call – unterstützt sync & async Python-Funktionen
async function pyCallJSON(name, args = {}) {
  try {
    globalThis._pyArgsJSON = JSON.stringify(args);
    const s = await pyodide.runPythonAsync(`
import json, inspect, asyncio
from js import _pyArgsJSON
_args = json.loads(_pyArgsJSON)

async def __runner():
    _res = ${name}(**_args)
    if inspect.isawaitable(_res):
        _res = await _res
    return _res

__out = await __runner()
json.dumps(__out)
    `);
    return JSON.parse(s);
  } catch (err) {
    console.error("Python call failed:", name, err);
    if (err && err.message) console.error("Python error message:", err.message);
    throw err;
  }
}

// ==============================
// Ably init + Lobby join
// ==============================
async function initAbly(lobbyCode, name) {
  clientId = name + "-" + Math.random().toString(36).slice(2, 7);
  realtime = new Ably.Realtime.Promise({ key: ABLY_API_KEY, clientId });
  await new Promise((res) => realtime.connection.once('connected', res));
  channel = realtime.channels.get("osja:" + lobbyCode);
  presence = channel.presence;
  await presence.enter({ name, isHost: false });

  const members = await presence.get();
  if (members.length === 1) {
    isHost = true;
    hostId = clientId;
    await presence.update({ name, isHost: true });
    await channel.publish("host-set", { hostId: clientId });
  } else {
    const host = members.find(m => m.data?.isHost);
    if (host) hostId = host.clientId;
  }

  channel.subscribe("host-set", (msg) => {
    hostId = msg.data.hostId;
    isHost = (hostId === clientId);
  });

  // Pool-Rendering (vom Host oder spezifisch per RPC geliefert)
  channel.subscribe("pool", (msg) => {
    try {
      renderPool(msg.data.pool || []);
      resetSelections();
      if (msg.data.rangeleien) {
        pickedMax = 3;
        ui.pickedMax.textContent = "3";
        log("Wähle 3 Rangeleien.");
      } else {
        pickedMax = 4;
        ui.pickedMax.textContent = "4";
      }
    } catch (e) {
      console.error("pool render error", e);
    }
  });

  // State-Updates
  channel.subscribe("state", (msg) => {
    if (!isHost || msg.data.force) renderState(msg.data);
  });

  // RPC Handling (für Nicht-Host Eingaben + Host führt Python aus)
  channel.subscribe("rpc", async (msg) => {
    const { to, op, data, reqId } = msg.data || {};
    if (to !== clientId) return;
    try {
      const res = await handleRpc(op, data);
      await channel.publish("rpc-resp", { reqId, res });
    } catch (e) {
      console.error("rpc handler error", e);
      await channel.publish("rpc-resp", { reqId, res: null });
    }
  });

  // Clients können Host bitten, den Pool neu zu senden
  channel.subscribe("pool-req", async () => {
    if (isHost && pyReady) {
      try {
        const pool = await Host.call("get_pool", { lobby_code: lobbyCode, phase: 1, rangeleien: false });
        await broadcast("pool", { pool, rangeleien: false });
      } catch (e) {
        console.error("pool-req host error", e);
      }
    }
  });

  channel.subscribe("msg", (m) => log(m.data.text));

  // Host: Lobby erstellen, sobald 2. Spieler da
  if (isHost) {
    presence.subscribe('enter', async () => {
      const m = await presence.get();
      if (m.length >= 2 && !lobbyCreated) {
        const other = m.find(x => x.clientId !== clientId);
        await ensureHostReadyAndCreate(lobbyCode, name, other?.data?.name || "Gegner", other.clientId);
      }
    });
    if (members.length >= 2 && !lobbyCreated) {
      const other = members.find(x => x.clientId !== clientId);
      await ensureHostReadyAndCreate(lobbyCode, name, other?.data?.name || "Gegner", other.clientId);
    }
  }
}

// ==============================
// Pyodide laden + Engine importieren
// ==============================
async function loadPyodideAndEngine() {
  try {
    pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.24.1/full/" });
    const engine = await fetch(PY_ENGINE_PATH).then(r => r.text());
    const shim = await fetch(PY_SHIM_PATH).then(r => r.text());
    pyodide.FS.mkdirTree("/py");
    pyodide.FS.writeFile("/py/engine.py", engine);
    pyodide.FS.writeFile("/py/shim.py", shim);
    await pyodide.runPythonAsync(`
import sys
sys.path.append("/py")
from shim import *
    `);
    pyReady = true;
  } catch (err) {
    console.error("Pyodide import error:", err);
    if (err && err.message) console.error(err.message);
    throw err;
  }
}

// ==============================
// Host bridge
// ==============================
const Host = {
  mkLocalClient() {
    return {
      // NUR lokal loggen (kein Broadcast)
      message: async (text) => { log(text); },
      getcharactertarget: async () => selectCharacterTarget(),
      getatktarget: async () => selectAttackTarget(),
      getstacktarget: async () => selectStackTarget(),
      win: async () => { await broadcast("state", await Host.snapshot()); }
    };
  },
  mkRemoteClient(remoteId) {
    return {
      // Per RPC NUR an den Remote-Client schicken
      message: async (text) => {
        // einseitige Nachricht an remoteId
        await channel.publish("rpc", { to: remoteId, op: "notify", data: { text }, reqId: null });
      },
      getcharactertarget: async () => Host.rpcAsk(remoteId, "getchar"),
      getatktarget: async () => Host.rpcAsk(remoteId, "getatk"),
      getstacktarget: async () => Host.rpcAsk(remoteId, "getstack"),
      win: async () => { await broadcast("state", await Host.snapshot()); }
    };
  },
  async rpcAsk(to, op, data = {}) {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to, op, data, reqId });
    return new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.data.reqId === reqId) {
          channel.unsubscribe("rpc-resp", handler);
          resolve(msg.data.res);
        }
      };
      channel.subscribe("rpc-resp", handler);
    });
  },
  async createLobby(lobbyCode, meName, otherName, otherId) {
    const localClient = this.mkLocalClient();
    const remoteClient = this.mkRemoteClient(otherId);
    try {
      globalThis.localClient = localClient;
      globalThis.remoteClient = remoteClient;
      globalThis.lobbyCode = lobbyCode;
      globalThis.meName = meName;
      globalThis.otherName = otherName;

      await pyodide.runPythonAsync(`
from js import localClient as lc, remoteClient as rc, lobbyCode, meName, otherName
create_lobby(lobbyCode)
ok1 = await spieler_beitreten_py(lobbyCode, meName, lc)
ok2 = await spieler_beitreten_py(lobbyCode, otherName, rc)
assert ok1 and ok2, "spieler_beitreten_py returned False"
      `);
    } catch (err) {
      console.error("createLobby runPythonAsync error:", err);
      if (err && err.message) console.error(err.message);
      throw err;
    }
  },
  async snapshot() {
    try {
      globalThis._snapLobbyCode = ui.lobby.value.trim();
      const s = await pyodide.runPythonAsync(`
import json
from js import _snapLobbyCode
json.dumps(lobby_snapshot(_snapLobbyCode))
      `);
      return JSON.parse(s);
    } catch (err) {
      console.error("snapshot error", err);
      if (err && err.message) console.error(err.message);
      throw err;
    }
  },
  async call(name, args = {}) {
    return pyCallJSON(name, args);
  }
};

// ==============================
// UI State/Selection
// ==============================
let localName = "", lobbyCodeVal = "", opponentName = "Gegner";
let picked = new Set();
let pickedMax = 4;
let desireRangeleien = false;
let selectedChar = null;       // { side:'me'|'opp', kind:'player'|'monster', index:int }
let selectedAttackId = null;   // ab_id (string/number)

function resetSelections() {
  selectedChar = null;
  selectedAttackId = null;
  picked.clear();
  desireRangeleien = false;
  pickedMax = 4;
  ui.pickedMax.textContent = pickedMax;
  ui.pickedCount.textContent = "0";
  ui.pickedList.innerHTML = "";
}

function renderState(state) {
  lastState = state;
  showScreen(state.screen);

  if (state.screen >= 3 || state.screen === 2) {
    ui.turnNum.textContent = state.turn;
    ui.turnPhase.textContent = phaseLabel(state.turntime, state.reaction);
    ui.priorityName.textContent = state.priority_name || "-";
  }

  // Stack
  if (state.stack) {
  ui.stackView.innerHTML = state.stack.map(it => {
    const colorClass = (it.atype === 2) ? "blue" : (it.owner === localName ? "green" : "red");
    return `
      <div class="item ${colorClass}" data-stack-index="${it.index}">
        <div><strong>${it.name}</strong> (${it.owner})</div>
        ${it.targets.map(t => `<div class="small">• ${t}</div>`).join("")}
      </div>
    `;
  }).join("");
}


  // Spieler nach Namen mappen
  let my = null, opp = null;
  if (Array.isArray(state.players)) {
    my = state.players.find(p => p.name === localName) || state.players[0] || null;
    opp = state.players.find(p => p.name !== (my && my.name)) || null;
  }

  // Teams rendern
  function memberHtml(m, side, kind, index){
    const life = `${m.hp}/${m.max}`;
    return `<div class="member" data-side="${side}" data-kind="${kind}" data-index="${index}">
      <div><strong>${m.name}</strong> <span class="small">(${life})${m.spott ? " · Spott" : ""}</span></div>
    </div>`;
  }
  ui.friends.innerHTML = "";
  ui.enemies.innerHTML = "";
  if (my) {
    ui.friends.innerHTML = memberHtml(my, "me", "player", 0)
      + (my.monsters || []).map((mm,i)=>memberHtml(mm,"me","monster",i)).join("");
  }
  if (opp) {
    ui.enemies.innerHTML = memberHtml(opp, "opp", "player", 0)
      + (opp.monsters || []).map((mm,i)=>memberHtml(mm,"opp","monster",i)).join("");
  }

  // Rechte Spalte
  ui.charAttacks.innerHTML = "";
  ui.rightTitle.textContent = "Attacken";
  const fmtAtk = (a, i = null) => `
    <div class="atk"${i !== null ? ` data-attack-index="${i}"` : ""} data-abid="${a.ab_id}">
      <div><strong>${a.name}</strong> <span class="small">[${a.atype === 1 ? "Rangelei" : a.atype === 2 ? "Event" : "Normal"}]</span></div>
      <div class="small">${(a.keywords || []).join(", ")}</div>
      <div class="small">${a.text}</div>
    </div>
  `;

  if (selectedChar && selectedChar.side === "opp") {
    ui.rightTitle.textContent = "Bekannte gegnerische Attacken";
    const known = (my && my.known) ? my.known : [];
    ui.charAttacks.innerHTML = known.map(a => fmtAtk(a)).join("");
  } else if (selectedChar && selectedChar.side === "me" && my) {
    const list = (selectedChar.kind === "player")
      ? (my.attacks || [])
      : ((my.monsters?.[selectedChar.index]?.attacks) || []);
    ui.charAttacks.innerHTML = list.map((a,i)=>fmtAtk(a,i)).join("");
  }

  // Screen 2: bekannte Gegner-Attacken
  if (state.screen === 2) {
    const known = (my && Array.isArray(my.known)) ? my.known : [];
    ui.oppKnown.innerHTML = known.map(a => `
      <div class="atk">
        <div><strong>${a.name}</strong></div>
        <div class="small">${(a.keywords || []).join(", ")}</div>
        <div class="small">${a.text}</div>
      </div>
    `).join("");
  } else {
    ui.oppKnown.innerHTML = "";
  }

  // Flags (Screen 2 & 3) spiegeln
  if (my && my.flags) {
    if (ui.cbStart)  ui.cbStart.checked  = !!my.flags.start;
    if (ui.cbEnd)    ui.cbEnd.checked    = !!my.flags.end;
    if (ui.cbReact)  ui.cbReact.checked  = !!my.flags.react;

    if (ui.cbStart3) ui.cbStart3.checked = !!my.flags.start;
    if (ui.cbEnd3)   ui.cbEnd3.checked   = !!my.flags.end;
    if (ui.cbReact3) ui.cbReact3.checked = !!my.flags.react;
  }

  // Buttons en/disablen
  if (state.screen >= 3 && state.priority_name) {
    const iHavePriority = (state.priority_name === localName);
    ui.passBtn.disabled = !iHavePriority;
    ui.playBtn.disabled = !iHavePriority;
  }

  // Screen 2: max zahlbar
  if (state.screen === 2 && my) {
    const max = Math.max(0, (my.hp ?? 500) - 200);
    ui.payInput.max = String(max);
  }
}

function renderPool(attacks) {
  ui.pool.innerHTML = attacks.map(a=>`
    <div class="atk" data-name="${a.name}">
      <div><strong>${a.name}</strong></div>
      <div class="small">${(a.keywords || []).join(", ")}</div>
      <div class="small">${a.text}</div>
    </div>
  `).join("");
  ui.pool.querySelectorAll('.atk').forEach(el=>{
    el.addEventListener('click', ()=>{
      const name = el.dataset.name;
      if (picked.has(name)) {
        picked.delete(name);
        el.classList.remove('selected');
      } else {
        const isVA = (name === "Verführerisches Angebot");
        let cap = pickedMax;
        if (picked.has("Verführerisches Angebot") || isVA) cap = 6;
        if (picked.size >= cap && !isVA) return;
        picked.add(name);
        el.classList.add('selected');
      }
      ui.pickedCount.textContent = picked.size;
      ui.pickedList.innerHTML = [...picked].map(n=>`<div class="atk"><strong>${n}</strong></div>`).join("");
    });
  });
}

// ==============================
// Screen 0 – Join
// ==============================
ui.joinBtn.addEventListener('click', async () => {
  const name = ui.name.value.trim();
  const lobby = ui.lobby.value.trim();
  if (!name || !lobby) { log("Bitte Name und Lobbycode ausfüllen."); return; }
  localName = name; lobbyCodeVal = lobby;

  await initAbly(lobbyCodeVal, localName);
  showScreen(1);
  broadcast("msg", { text: `${localName} ist beigetreten.` });

  if (!isHost) {
    await broadcast("pool-req", {});
  }
});

// ==============================
// RPC helper (client -> host)
// ==============================
async function rpcAskHost(op, data = {}) {
  return new Promise(async (resolve) => {
    const reqId = Math.random().toString(36).slice(2);
    const handler = (msg) => {
      if (msg.data.reqId === reqId) {
        channel.unsubscribe("rpc-resp", handler);
        resolve(msg.data.res);
      }
    };
    channel.subscribe("rpc-resp", handler);
    await channel.publish("rpc", { to: hostId, op, data, reqId });
  });
}

// ==============================
// Screen 1 – Attackenwahl
// ==============================
// ==============================
// Screen 1 – Attackenwahl (FIXED)
// ==============================
ui.confirmPicks.addEventListener('click', async () => {
  if (picked.size === 0) { log("Bitte Attacken wählen."); return; }

  // Wenn "Immer vorbereitet" dabei ist, erst die Basis an die Engine schicken,
  // dann in den Rangeleien-Pool wechseln.
  if (!desireRangeleien && picked.has("Immer vorbereitet")) {
    const baseList = [...picked]; // Basis-Selection sichern

    try {
      // 1) Basis sofort serverseitig speichern (markiert NICHT als complete)
      if (isHost) {
        const ok = await Host.call("submit_attacks", {
          lobby_code: lobbyCodeVal,
          player_name: localName,
          picks: baseList,
          rangeleien: false
        });
        if (!ok) { log("Wahl abgelehnt."); return; }
      } else {
        const ok = await rpcAskHost("submit_attacks", {
          name: localName,
          picks: baseList,
          rangeleien: false
        });
        if (!ok) { log("Wahl abgelehnt."); return; }
      }

      // 2) Auf Rangeleien umschalten
      desireRangeleien = true;

      if (isHost) {
        const rl = await Host.call("get_pool", { lobby_code: lobbyCodeVal, phase: 1, rangeleien: true });
        renderPool(rl);
      } else {
        const res = await rpcAskHost("get_pool_rangeleien", { lobby_code: lobbyCodeVal });
        renderPool(res.pool || []);
      }

      // 3) UI zurücksetzen und auf 3 begrenzen
      picked.clear();
      ui.pickedList.innerHTML = "";
      ui.pickedCount.textContent = "0";
      pickedMax = 3;
      ui.pickedMax.textContent = "3";
      log("Wähle 3 Rangeleien.");
    } catch (e) {
      console.error("Rangeleien-Umschalten fehlgeschlagen", e);
      if (e && e.message) console.error(e.message);
    }
    return;
  }

  // Bestätigung: entweder normale Auswahl (ohne 'Immer vorbereitet')
  // oder die 3 Rangeleien nach dem Umschalten.
  const list = [...picked];

  // kleine Guard: für Rangeleien genau 3 fordern
  if (desireRangeleien && list.length !== 3) {
    log("Bitte genau 3 Rangeleien wählen.");
    return;
  }

  if (isHost) {
    try {
      const ok = await Host.call("submit_attacks", {
        lobby_code: lobbyCodeVal,
        player_name: localName,
        picks: list,
        rangeleien: desireRangeleien
      });
      if (!ok) { log("Wahl abgelehnt."); return; }
      const snap = await Host.snapshot();
      renderState(snap);
      await broadcast("state", { ...snap, force: true });
    } catch (e) {
      console.error("submit_attacks failed", e);
      if (e && e.message) console.error(e.message);
    }
  } else {
    const ok = await rpcAskHost("submit_attacks", {
      name: localName,
      picks: list,
      rangeleien: desireRangeleien
    });
    if (!ok) { log("Wahl abgelehnt."); return; }
  }
});

// ==============================
// Screen 2 – Leben zahlen + Flags
// ==============================
[ui.cbStart, ui.cbEnd, ui.cbReact].forEach((cb) => {
  cb.addEventListener('change', async ()=>{
    if (isHost) {
      await Host.call("set_flags", { lobby_code: lobbyCodeVal, player_name: localName, start: ui.cbStart.checked, end: ui.cbEnd.checked, react: ui.cbReact.checked });
      const snap = await Host.snapshot();
      renderState(snap);
      await broadcast("state", { ...snap, force: true });
    } else {
      await rpcAskHost("set_flags", { name: localName, start: ui.cbStart.checked, end: ui.cbEnd.checked, react: ui.cbReact.checked });
    }
  });
});

ui.payConfirm.addEventListener('click', async ()=>{
  const amount = parseInt(ui.payInput.value || "0", 10);
  if (isNaN(amount) || amount < 0) return;
  if (isHost) {
    await Host.call("submit_pay", { lobby_code: lobbyCodeVal, player_name: localName, amount });
    const snap = await Host.snapshot();
    renderState(snap);
    await broadcast("state", { ...snap, force: true });
  } else {
    await rpcAskHost("submit_pay", { name: localName, amount });
  }
});

// ==============================
// Screen 3 – Kampfsteuerung
// ==============================
ui.friends.addEventListener('click', (e)=>{
  const target = e.target.closest('.member');
  if (!target) return;
  // nur eine Gesamtauswahl
  ui.enemies.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  ui.friends.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  target.classList.add('selected');
  selectedChar = { side: "me", kind: target.dataset.kind, index: parseInt(target.dataset.index,10) };
  renderState(lastState);
});

ui.enemies.addEventListener('click', (e)=>{
  const target = e.target.closest('.member');
  if (!target) return;
  ui.friends.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  ui.enemies.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  target.classList.add('selected');
  selectedChar = { side: "opp", kind: target.dataset.kind, index: parseInt(target.dataset.index,10) };
  renderState(lastState);
});

// nur eigene Attacken anklickbar
ui.charAttacks.addEventListener('click', (e)=>{
  const atk = e.target.closest('.atk');
  if (!atk) return;
  if (!selectedChar || selectedChar.side !== "me") return;
  ui.charAttacks.querySelectorAll('.atk').forEach(el=>el.classList.remove('selected'));
  atk.classList.add('selected');
  selectedAttackId = atk.getAttribute('data-abid');
});

// Pass
ui.passBtn.addEventListener('click', async ()=>{
  if (isHost) {
    await Host.call("ui_pass", { lobby_code: lobbyCodeVal, player_name: localName });
    const snap = await Host.snapshot();
    renderState(snap);
    await broadcast("state", { ...snap, force: true });
  } else {
    await rpcAskHost("pass", { name: localName });
  }
});

// Play – Engine bestimmt Targets via attacke_gewählt
ui.playBtn.addEventListener('click', async ()=>{
  if (!selectedChar || selectedChar.side !== "me") { log("Wähle zuerst deinen Charakter/Monster."); return; }
  if (!selectedAttackId) { log("Wähle zuerst eine Attacke."); return; }

  if (isHost) {
    const ok = await Host.call("ui_play", { lobby_code: lobbyCodeVal, player_name: localName, char: selectedChar, ab_id: selectedAttackId });
    if (!ok) log("Attacke nicht einsetzbar.");
    const snap = await Host.snapshot();
    renderState(snap);
    await broadcast("state", { ...snap, force: true });
  } else {
    await rpcAskHost("play", { name: localName, char: selectedChar, ab_id: selectedAttackId });
  }
});

// Kampf-Checkboxen (Screen 3)
[ui.cbStart3, ui.cbEnd3, ui.cbReact3].forEach((cb) => {
  cb.addEventListener('change', async ()=>{
    if (isHost) {
      await Host.call("set_flags", { lobby_code: lobbyCodeVal, player_name: localName, start: ui.cbStart3.checked, end: ui.cbEnd3.checked, react: ui.cbReact3.checked });
      const snap = await Host.snapshot();
      renderState(snap);
      await broadcast("state", { ...snap, force: true });
    } else {
      await rpcAskHost("set_flags", { name: localName, start: ui.cbStart3.checked, end: ui.cbEnd3.checked, react: ui.cbReact3.checked });
    }
  });
});

// ==============================
// RPC handler (nicht-Host Eingaben, Host führt Python aus)
// ==============================
async function handleRpc(op, data) {
  if (op === "getchar") return await selectCharacterTarget();
  if (op === "getatk")  return await selectAttackTarget();
  if (op === "getstack")return await selectStackTarget();

  if (op === "notify") {
    if (data && data.text) log(String(data.text));
    return true;
  }
  
  if (!isHost) return null;

  switch (op) {
    case "get_pool_rangeleien": {
      const pool = await Host.call("get_pool", {
        lobby_code: lobbyCodeVal,
        phase: 1,
        rangeleien: true
      });
      return { pool };
    }
    case "submit_attacks": {
      const ok = await Host.call("submit_attacks", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        picks: data.picks,
        rangeleien: !!data.rangeleien
      });
      const snap = await Host.snapshot();
      await broadcast("state", { ...snap, force: true });
      return ok;
    }
    case "set_flags": {
      await Host.call("set_flags", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        start: !!data.start,
        end: !!data.end,
        react: !!data.react
      });
      const snap = await Host.snapshot();
      await broadcast("state", { ...snap, force: true });
      return true;
    }
    case "submit_pay": {
      await Host.call("submit_pay", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        amount: parseInt(data.amount || 0, 10)
      });
      const snap = await Host.snapshot();
      await broadcast("state", { ...snap, force: true });
      return true;
    }
    case "pass": {
      await Host.call("ui_pass", {
        lobby_code: lobbyCodeVal,
        player_name: data.name
      });
      const snap = await Host.snapshot();
      await broadcast("state", { ...snap, force: true });
      return true;
    }
    case "play": {
      await Host.call("ui_play", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        char: data.char,
        ab_id: data.ab_id
      });
      const snap = await Host.snapshot();
      await broadcast("state", { ...snap, force: true });
      return true;
    }
  }
  return null;
}

// ==============================
// Target selection placeholders (Engine fragt via ask_targets → PyClient → JS)
// ==============================

let selection = { mode: null, chosen: null, confirmBtn: null };
function enterSelectionMode(label = "Ziel wählen") {
  // Buttons verstecken
  ui.passBtn.classList.add("hidden");
  ui.playBtn.classList.add("hidden");

  // Confirm-Button einfügen
  const btn = document.createElement("button");
  btn.id = "select-confirm-btn";
  btn.textContent = label;
  btn.disabled = true;
  btn.className = "primary";
  document.querySelector(".bottom-bar").appendChild(btn);
  selection.confirmBtn = btn;
}
function leaveSelectionMode() {
  if (selection.confirmBtn) {
    selection.confirmBtn.remove();
  }
  selection = { mode: null, chosen: null, confirmBtn: null };
  ui.passBtn.classList.remove("hidden");
  ui.playBtn.classList.remove("hidden");
}


async function selectCharacterTarget(){
  return new Promise(resolve => {
    enterSelectionMode("Ziel wählen");

    let pick = null;
    const onPick = (e) => {
      const el = e.target.closest(".member");
      if (!el) return;
      // Visuelle Markierung
      ui.friends.querySelectorAll(".member").forEach(x=>x.classList.remove("selected"));
      ui.enemies.querySelectorAll(".member").forEach(x=>x.classList.remove("selected"));
      el.classList.add("selected");

      pick = {
        side: el.dataset.side,
        kind: el.dataset.kind,
        index: parseInt(el.dataset.index, 10)
      };
      selection.confirmBtn.disabled = false;
    };

    ui.friends.addEventListener("click", onPick);
    ui.enemies.addEventListener("click", onPick);

    const onConfirm = () => {
      ui.friends.removeEventListener("click", onPick);
      ui.enemies.removeEventListener("click", onPick);
      leaveSelectionMode();
      resolve(pick || { side:"me", kind:"player", index:0 });
    };
    selection.confirmBtn.addEventListener("click", onConfirm, { once: true });
  });
}

async function selectAttackTarget(){
  return new Promise(resolve => {
    enterSelectionMode("Ziel wählen");

    // 1) Zuerst Charakter auswählen (Besitzer der Ziel-Attacke)
    let pickedChar = null;
    const onPickChar = (e) => {
      const el = e.target.closest(".member");
      if (!el) return;

      ui.friends.querySelectorAll(".member").forEach(x=>x.classList.remove("selected"));
      ui.enemies.querySelectorAll(".member").forEach(x=>x.classList.remove("selected"));
      el.classList.add("selected");

      pickedChar = {
        side: el.dataset.side,
        kind: el.dataset.kind,
        index: parseInt(el.dataset.index, 10)
      };
      // rechte Spalte für diesen Charakter anzeigen
      selectedChar = pickedChar;
      renderState(lastState);

      // Angriffe anklickbar machen
      ui.charAttacks.querySelectorAll(".atk").forEach(a => {
        a.addEventListener("click", ()=>{
          ui.charAttacks.querySelectorAll(".atk").forEach(x=>x.classList.remove("selected"));
          a.classList.add("selected");
          selection.confirmBtn.disabled = false;
        }, { once: true });
      });
    };

    ui.friends.addEventListener("click", onPickChar);
    ui.enemies.addEventListener("click", onPickChar);

    const onConfirm = () => {
      ui.friends.removeEventListener("click", onPickChar);
      ui.enemies.removeEventListener("click", onPickChar);

      // gewählte Attacke ermitteln
      const el = document.querySelector("#char-attacks .atk.selected");
      const abId = el ? Number(el.getAttribute("data-abid")) : 0;

      const res = { charPath: pickedChar || { side:"me", kind:"player", index:0 }, ab_id: abId };
      leaveSelectionMode();
      resolve(res);
    };

    selection.confirmBtn.addEventListener("click", onConfirm, { once: true });
  });
}


async function selectStackTarget(){
  return new Promise(resolve => {
    enterSelectionMode("Ziel wählen");
    let idx = null;

    const onPick = (e) => {
      const el = e.target.closest(".item");
      if (!el) return;
      ui.stackView.querySelectorAll(".item").forEach(x=>x.classList.remove("selected"));
      el.classList.add("selected");
      idx = parseInt(el.getAttribute("data-stack-index"), 10);
      selection.confirmBtn.disabled = (isNaN(idx));
    };
    ui.stackView.addEventListener("click", onPick);

    const onConfirm = () => {
      ui.stackView.removeEventListener("click", onPick);
      const val = Number.isInteger(idx) ? idx : 0;
      leaveSelectionMode();
      resolve(val);
    };
    selection.confirmBtn.addEventListener("click", onConfirm, { once: true });
  });
}


// ==============================
// Host ensure + initial pool
// ==============================
async function ensureHostReadyAndCreate(lobbyCode, meName, otherName, otherId) {
  try {
    if (!pyReady) {
      log("[Host] Lade Pyodide & Engine…");
      await loadPyodideAndEngine();
      log("[Host] Bereit.");
    }
    if (!otherId) console.error("ensureHostReadyAndCreate: otherId is missing");

    try {
      await Host.createLobby(lobbyCode, meName, otherName, otherId);
    } catch (err) {
      console.error("Host.createLobby Python error:", err);
      if (err && err.message) console.error(err.message);
      throw err;
    }
    lobbyCreated = true;

    // Diagnostic
    try {
      const info = await pyodide.runPythonAsync(`
import json, engine as eng
json.dumps({"attack_count": sum(1 for v in eng.__dict__.values() if isinstance(v, eng.Attacke))})
      `);
      console.log("Python diagnostic:", JSON.parse(info));
    } catch (e) {
      console.error("Python diagnostic failed", e);
    }

    try {
      const pool = await Host.call("get_pool", { lobby_code: lobbyCode, phase: 1, rangeleien: false });
      await broadcast("pool", { pool, rangeleien: false });
    } catch (e) {
      console.error("initial get_pool failed", e);
      if (e && e.message) console.error(e.message);
    }

    const snap = await Host.snapshot();
    renderState(snap);
    await broadcast("state", { ...snap, force: true });

  } catch (outer) {
    console.error("ensureHostReadyAndCreate failed:", outer);
    if (outer && outer.message) console.error(outer.message);
    throw outer;
  }
}

// ==============================
// Boot
// ==============================
showScreen(0);
