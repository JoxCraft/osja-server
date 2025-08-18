// app.js
const ABLY_API_KEY = "3wcmYg.8GQUGA:WaFbpDvdQSDdntaxL6mBMg72Om8OcOybipf-Sbs5eRc"; // <-- anpassen
const PY_ENGINE_PATH = "/py/engine.py";
const PY_SHIM_PATH   = "/py/shim.py";

let realtime, channel, presence, clientId, hostId = null;
let pyodide, pyReady = false, isHost = false, lobbyCreated = false;
let screen = 0;

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


// JSON-safe Python call (ensures we get plain JS objects, not PyProxy)
async function pyCallJSON(name, args = {}) {
  const s = await pyodide.runPythonAsync(`
import json
json.dumps(${name}(**js.args))
  `, { globals: { js: { args } } });
  return JSON.parse(s);
}

// ------------------------
// Ably Init + Lobby Join
// ------------------------
async function initAbly(lobbyCode, name) {
  clientId = name + "-" + Math.random().toString(36).slice(2, 7);
  realtime = new Ably.Realtime.Promise({ key: ABLY_API_KEY, clientId });
  await new Promise((res) => realtime.connection.once('connected', res));
  channel = realtime.channels.get("osja:" + lobbyCode);
  presence = channel.presence;
  await presence.enter({ name, isHost: false });

  // Host-Ermittlung: erster Präsenz-Eintrag wird Host
  const members = await presence.get();
  if (members.length === 1) {
    isHost = true;
    hostId = clientId;
    await presence.update({ name, isHost: true });
    await channel.publish("host-set", { hostId: clientId });
  } else {
    // suche existierenden Host
    const host = members.find(m => m.data?.isHost);
    if (host) hostId = host.clientId;
  }

  channel.subscribe("host-set", (msg) => {
    hostId = msg.data.hostId;
    isHost = (hostId === clientId);
  });

  // Pool & State & RPC
  channel.subscribe("pool", (msg) => {
    renderPool(msg.data.pool || []);
    // Reset der Auswahl bei Pool-Wechsel (z.B. Rangeleien)
    resetSelections();
    if (msg.data.rangeleien) {
      pickedMax = 3;
      ui.pickedMax.textContent = "3";
      log("Wähle 3 Rangeleien.");
    } else {
      pickedMax = 4;
      ui.pickedMax.textContent = "4";
    }
  });

  channel.subscribe("state", (msg) => {
    if (!isHost || msg.data.force) renderState(msg.data);
  });

  channel.subscribe("rpc", async (msg) => {
    const { to, op, data, reqId } = msg.data;
    if (to !== clientId) return;
    const res = await handleRpc(op, data);
    await channel.publish("rpc-resp", { reqId, res });
  });

    // Let clients request the pool again if needed
  channel.subscribe("pool-req", async () => {
    if (isHost && pyReady) {
      const pool = await Host.call("get_pool", { lobby_code: lobbyCode, phase: 1, rangeleien: false });
      await broadcast("pool", { pool, rangeleien: false });
    }
  });

  // Host wartet auf zweiten Spieler, dann Lobby erstellen & Pool senden
  if (isHost) {
    presence.subscribe('enter', async () => {
      const m = await presence.get();
      if (m.length >= 2 && !lobbyCreated) {
        const other = m.find(x => x.clientId !== clientId);
        await ensureHostReadyAndCreate(lobbyCode, name, other?.data?.name || "Gegner", other.clientId);
      }
    });
    // Falls der Zweite schon da ist
    if (members.length >= 2 && !lobbyCreated) {
      const other = members.find(x => x.clientId !== clientId);
      await ensureHostReadyAndCreate(lobbyCode, name, other?.data?.name || "Gegner", other.clientId);
    }
  }
}

async function ensureHostReadyAndCreate(lobbyCode, meName, otherName, otherId) {
  if (!pyReady) {
    log("[Host] Lade Pyodide & Engine…");
    await loadPyodideAndEngine();
    log("[Host] Bereit.");
  }
  await Host.createLobby(lobbyCode, meName, otherName, otherId);
  lobbyCreated = true;

  // Pool (normale Attacken) laden & broadcasten
  const pool = await Host.call("get_pool", { lobby_code: lobbyCode, phase: 1, rangeleien: false });
  await broadcast("pool", { pool, rangeleien: false });

  const snap = await Host.snapshot();
  await broadcast("state", snap);
}

function broadcast(type, data) {
  return channel.publish(type, data);
}

// ------------------------
// Pyodide Host-Ladung
// ------------------------
async function loadPyodideAndEngine() {
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
}

// ------------------------
// Host: Python-Brücke
// ------------------------
const Host = {
  mkLocalClient() {
    return {
      message: async (text) => broadcast("msg", { text: `[Server] ${text}` }),
      getcharactertarget: async () => selectCharacterTarget(),
      getatktarget: async () => selectAttackTarget(),
      getstacktarget: async () => selectStackTarget(),
      win: async () => { await broadcast("state", await Host.snapshot()); }
    };
  },
  mkRemoteClient(remoteId) {
    return {
      message: async (text) => broadcast("msg", { text }),
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
    // Cleanup stale lobbies passiert im shim
    const localClient = this.mkLocalClient();
    const remoteClient = this.mkRemoteClient(otherId);
    await pyodide.runPythonAsync(`
lc = js.localClient
rc = js.remoteClient
lobbyCode = js.lobbyCode
meName = js.meName
otherName = js.otherName
create_lobby(lobbyCode)
assert await spieler_beitreten_py(lobbyCode, meName, lc)
assert await spieler_beitreten_py(lobbyCode, otherName, rc)
    `, {
      globals: {
        js: {
          localClient, remoteClient,
          lobbyCode, meName, otherName
        }
      }
    });
  },
  async snapshot() {
    const state = await pyodide.runPythonAsync(`
import json
json.dumps(lobby_snapshot(js.lobbyCode))
    `, { globals: { js: { lobbyCode: ui.lobby.value.trim() } } });
    return JSON.parse(state);
  },
    async call(name, args = {}) {
    return pyCallJSON(name, args);
  }
};

// ------------------------
// UI State + Selektion
// ------------------------
let localName = "", lobbyCode = "", opponentName = "Gegner";
let picked = new Set();
let pickedMax = 4;
let desireRangeleien = false;
let selectedChar = null;  // {side:'me'|'opp', kind:'player'|'monster', index:int}
let selectedAttackIndex = null;

function resetSelections() {
  selectedChar = null;
  selectedAttackIndex = null;
  picked.clear();
  desireRangeleien = false;
  pickedMax = 4;
  ui.pickedMax.textContent = pickedMax;
  ui.pickedCount.textContent = "0";
  ui.pickedList.innerHTML = "";
}

function renderState(state) {
  showScreen(state.screen);

  if (state.screen >= 3) {
    ui.turnNum.textContent = state.turn;
    ui.turnPhase.textContent = phaseLabel(state.turntime, state.reaction);
    ui.priorityName.textContent = state.priority_name || "-";

    // Buttons nur bei Priority aktiv
    const iHavePriority = (state.priority_name === localName);
    ui.passBtn.disabled = !iHavePriority;
    ui.playBtn.disabled = !iHavePriority;
  }

  // Gegnerische bekannte Attacken (Screen 2)
  if (state.opp_known) {
    ui.oppKnown.innerHTML = state.opp_known.map(a => `
      <div class="atk">
        <div><strong>${a.name}</strong></div>
        <div class="small">${a.keywords.join(", ")}</div>
        <div class="small">${a.text}</div>
      </div>
    `).join("");
  }

  // Stack
  if (state.stack) {
    ui.stackView.innerHTML = state.stack.map(item => `
      <div class="item ${item.color}">
        <div><strong>${item.name}</strong> (${item.owner})</div>
        ${item.targets.map(t => `<div class="small">• ${t}</div>`).join("")}
      </div>
    `).join("");
  }

  // Teams
  function memberHtml(m, side, kind, index){
    const life = `${m.hp}/${m.max}`;
    return `<div class="member" data-side="${side}" data-kind="${kind}" data-index="${index}">
      <div><strong>${m.name}</strong> <span class="small">(${life})${m.spott ? " · Spott" : ""}</span></div>
    </div>`;
  }
  if (state.me && state.opp) {
    const me = state.me, opp = state.opp;
    ui.friends.innerHTML = memberHtml(me, "me", "player", 0)
      + me.monsters.map((mm,i)=>memberHtml(mm,"me","monster",i)).join("");
    ui.enemies.innerHTML = memberHtml(opp, "opp", "player", 0)
      + opp.monsters.map((mm,i)=>memberHtml(mm,"opp","monster",i)).join("");
  }

  // Rechte Spalte
  ui.charAttacks.innerHTML = "";
  ui.rightTitle.textContent = "Attacken";
  if (selectedChar) {
    const bundle = (selectedChar.side === "me") ? state.me : state.opp;
    if (selectedChar.side === "opp") {
      ui.rightTitle.textContent = "Bekannte gegnerische Attacken";
      ui.charAttacks.innerHTML = (state.opp_known || []).map(a=>`
        <div class="atk">
          <div><strong>${a.name}</strong></div>
          <div class="small">${a.keywords.join(", ")}</div>
          <div class="small">${a.text}</div>
        </div>
      `).join("");
    } else {
      const list = (selectedChar.kind === "player") ? bundle.attacks : (bundle.monsters[selectedChar.index]?.attacks || []);
      ui.charAttacks.innerHTML = list.map((a,i)=>`
        <div class="atk" data-attack-index="${i}">
          <div><strong>${a.name}</strong></div>
          <div class="small">${a.keywords.join(", ")}</div>
          <div class="small">${a.text}</div>
        </div>
      `).join("");
    }
  }

  // Screen 2: max Bezahlsumme einstellen
  if (state.screen === 2 && state.me) {
    const max = Math.max(0, (state.me.hp ?? 500) - 200);
    ui.payInput.max = String(max);
  }
}

function renderPool(attacks) {
  ui.pool.innerHTML = attacks.map(a=>`
    <div class="atk" data-name="${a.name}">
      <div><strong>${a.name}</strong></div>
      <div class="small">${a.keywords.join(", ")}</div>
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

// ------------------------
// Screen 0 – Join
// ------------------------
ui.joinBtn.addEventListener('click', async () => {
  const name = ui.name.value.trim();
  const lobby = ui.lobby.value.trim();
  if (!name || !lobby) { log("Bitte Name und Lobbycode ausfüllen."); return; }
  localName = name; lobbyCode = lobby;

  await initAbly(lobbyCode, localName);
  showScreen(1);
  broadcast("msg", { text: `${localName} ist beigetreten.` });
    // If I'm not host, ask host to resend the pool
  if (!isHost) {
    await broadcast("pool-req", {});
  }

});

// ------------------------
// Screen 1 – Attackenwahl
// ------------------------
ui.confirmPicks.addEventListener('click', async ()=>{
  if (picked.size === 0) { log("Bitte Attacken wählen."); return; }

  // Rangeleien aktivieren?
  if (!desireRangeleien && picked.has("Immer vorbereitet")) {
    desireRangeleien = true;
    if (isHost) {
      const rl = await Host.call("get_pool", { lobby_code: lobbyCode, phase: 1, rangeleien: true });
      await broadcast("pool", { pool: rl, rangeleien: true });
    } else {
      log("Host schaltet auf Rangeleien um…");
    }
    return;
  }

  const list = [...picked];
  if (isHost) {
    const ok = await Host.call("submit_attacks", { lobby_code: lobbyCode, player_name: localName, picks: list, rangeleien: desireRangeleien });
    if (!ok) { log("Wahl abgelehnt."); return; }
    const snap = await Host.snapshot();
    await broadcast("state", snap);
    if (snap.screen === 2) showScreen(2);
  } else {
    // RPC an Host (mit hostId!)
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "submit_attacks", data: { name: localName, picks: list, rangeleien: desireRangeleien }, reqId });
  }
});

// ------------------------
// Screen 2 – Leben zahlen
// ------------------------
[ui.cbStart, ui.cbEnd, ui.cbReact].forEach((cb) => {
  cb.addEventListener('change', async ()=>{
    if (isHost) {
      await Host.call("set_flags", { lobby_code: lobbyCode, player_name: localName, start: ui.cbStart.checked, end: ui.cbEnd.checked, react: ui.cbReact.checked });
      await broadcast("state", await Host.snapshot());
    } else {
      const reqId = Math.random().toString(36).slice(2);
      await channel.publish("rpc", { to: hostId, op: "set_flags", data: { name: localName, start: ui.cbStart.checked, end: ui.cbEnd.checked, react: ui.cbReact.checked }, reqId });
    }
  });
});

ui.payConfirm.addEventListener('click', async ()=>{
  const amount = parseInt(ui.payInput.value || "0", 10);
  if (isNaN(amount) || amount < 0) return;
  if (isHost) {
    await Host.call("submit_pay", { lobby_code: lobbyCode, player_name: localName, amount });
    await broadcast("state", await Host.snapshot());
    showScreen(3);
  } else {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "submit_pay", data: { name: localName, amount }, reqId });
  }
});

// ------------------------
// Screen 3 – Kampfsteuerung
// ------------------------
ui.friends.addEventListener('click', (e)=>{
  const target = e.target.closest('.member');
  if (!target) return;
  ui.friends.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  target.classList.add('selected');
  selectedChar = { side: "me", kind: target.dataset.kind, index: parseInt(target.dataset.index,10) };
});

ui.enemies.addEventListener('click', (e)=>{
  const target = e.target.closest('.member');
  if (!target) return;
  ui.enemies.querySelectorAll('.member').forEach(el=>el.classList.remove('selected'));
  target.classList.add('selected');
  selectedChar = { side: "opp", kind: target.dataset.kind, index: parseInt(target.dataset.index,10) };
});

ui.charAttacks.addEventListener('click', (e)=>{
  const atk = e.target.closest('.atk');
  if (!atk) return;
  ui.charAttacks.querySelectorAll('.atk').forEach(el=>el.classList.remove('selected'));
  atk.classList.add('selected');
  selectedAttackIndex = parseInt(atk.dataset.attackIndex ?? "-1", 10);
});

ui.passBtn.addEventListener('click', async ()=>{
  if (isHost) {
    await Host.call("ui_pass", { lobby_code: lobbyCode, player_name: localName });
    await broadcast("state", await Host.snapshot());
  } else {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "pass", data: { name: localName }, reqId });
  }
});

ui.playBtn.addEventListener('click', async ()=>{
  if (!selectedChar || selectedChar.side !== "me") { log("Wähle zuerst deinen Charakter/Monster."); return; }
  if (selectedAttackIndex == null) { log("Wähle zuerst eine Attacke."); return; }
  if (isHost) {
    const ok = await Host.call("ui_play", { lobby_code: lobbyCode, player_name: localName, char: selectedChar, attack_index: selectedAttackIndex });
    if (!ok) log("Attacke nicht einsetzbar.");
    await broadcast("state", await Host.snapshot());
  } else {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "play", data: { name: localName, char: selectedChar, attackIndex: selectedAttackIndex }, reqId });
  }
});

// ------------------------
// RPC-Handler (Nicht-Host)
// ------------------------
async function handleRpc(op, data) {
  switch(op){
    case "getchar": return await selectCharacterTarget();
    case "getatk": return await selectAttackTarget();
    case "getstack": return await selectStackTarget();
    case "submit_attacks":
    case "set_flags":
    case "submit_pay":
    case "pass":
    case "play":
      return true;
  }
  return null;
}

// ------------------------
// Auswahl-Dialoge (Platzhalter)
// ------------------------
async function selectCharacterTarget(){ return { side:"me", kind:"player", index:0 }; }
async function selectAttackTarget(){ return { charPath: { side:"me", kind:"player", index:0 }, attackIndex: 0 }; }
async function selectStackTarget(){ return 0; }

// ------------------------
// Start
// ------------------------
showScreen(0);
