// app.js
// ==============================
// Configure these paths/keys
// ==============================
const ABLY_API_KEY = "3wcmYg.8GQUGA:WaFbpDvdQSDdntaxL6mBMg72Om8OcOybipf-Sbs5eRc"; // <-- set your Ably key
const PY_ENGINE_PATH = "/py/engine.py";
const PY_SHIM_PATH   = "/py/shim.py";

// ==============================
// Globals
// ==============================
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

// Helpful global error logs
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

// Universal safe Python call: serialize args as JSON
async function pyCallJSON(name, args = {}) {
  try {
    // expose args as JSON to Python
    globalThis._pyArgsJSON = JSON.stringify(args);

    const s = await pyodide.runPythonAsync(`
import json
from js import _pyArgsJSON
_args = json.loads(_pyArgsJSON)
_resp = ${name}(**_args)
json.dumps(_resp)
    `);

    return JSON.parse(s);

  } catch (err) {
    console.error("Python call failed:", name, err);
    if (err && err.message) {
      console.error("Python error message:", err.message);
    }
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

  channel.subscribe("state", (msg) => {
    if (!isHost || msg.data.force) renderState(msg.data);
  });

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

  // Let clients ask host to resend the pool
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

  // Host creates lobby and sends pool when second joins
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
function broadcast(type, data) {
  return channel.publish(type, data);
}

// ==============================
// Pyodide load + engine import
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
// Host bridge to Python (NO globals arg)
// ==============================
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
    const localClient = this.mkLocalClient();
    const remoteClient = this.mkRemoteClient(otherId);
    try {
      // expose variables to Python via js module
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
    return pyCallJSON(name, args); // JSON-safe bridge
  }
};

// ==============================
// UI state + selection
// ==============================
let localName = "", lobbyCodeVal = "", opponentName = "Gegner";
let picked = new Set();
let pickedMax = 4;
let desireRangeleien = false;
let selectedChar = null;    // { side:'me'|'opp', kind:'player'|'monster', index:int }
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

    const iHavePriority = (state.priority_name === localName);
    ui.passBtn.disabled = !iHavePriority;
    ui.playBtn.disabled = !iHavePriority;
  }

  if (state.opp_known) {
    ui.oppKnown.innerHTML = state.opp_known.map(a => `
      <div class="atk">
        <div><strong>${a.name}</strong></div>
        <div class="small">${a.keywords.join(", ")}</div>
        <div class="small">${a.text}</div>
      </div>
    `).join("");
  }

  if (state.stack) {
    ui.stackView.innerHTML = state.stack.map(item => `
      <div class="item ${item.color}">
        <div><strong>${item.name}</strong> (${item.owner})</div>
        ${item.targets.map(t => `<div class="small">• ${t}</div>`).join("")}
      </div>
    `).join("");
  }

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

  if (state.screen === 2 && state.me) {
    const max = Math.max(0, (state.me.hp ?? 500) - 200);
    ui.payInput.max = String(max);
  }
}

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
// Screen 1 – Attackenwahl
// ==============================
ui.confirmPicks.addEventListener('click', async () => {
  if (picked.size === 0) { log("Bitte Attacken wählen."); return; }

  // 1) Umschalten auf Rangeleien NUR für den Spieler, der "Immer vorbereitet" gewählt hat
  if (!desireRangeleien && picked.has("Immer vorbereitet")) {
    desireRangeleien = true;

    try {
      if (isHost) {
        // Host holt Pool lokal – KEIN Broadcast, damit der andere Spieler nicht umschaltet
        const rl = await Host.call("get_pool", { lobby_code: lobbyCodeVal, phase: 1, rangeleien: true });
        renderPool(rl);
      } else {
        // Client bittet Host per RPC nur für sich um den Rangeleien-Pool
        const res = await rpcAskHost("get_pool_rangeleien", { lobby_code: lobbyCodeVal });
        renderPool(res.pool || []);
      }
      // Nach Umschalten: Auswahl zurücksetzen & Max=3
      picked.clear();
      ui.pickedList.innerHTML = "";
      ui.pickedCount.textContent = "0";
      pickedMax = 3;
      ui.pickedMax.textContent = "3";
      log("Wähle 3 Rangeleien.");
    } catch (e) {
      console.error("Rangeleien-Pool laden fehlgeschlagen", e);
    }
    return; // Diesem Klick folgt typischerweise ein zweiter Klick zum Bestätigen der Rangeleien-Wahl
  }

  // 2) Normale Bestätigung (entweder normale Attacken oder Rangeleien)
  const list = [...picked];

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
      await broadcast("state", snap);
      if (snap.screen === 2) showScreen(2);
    } catch (e) {
      console.error("submit_attacks failed", e);
      if (e && e.message) console.error(e.message);
    }
  } else {
    // Client schickt RPC an den Host, der wirklich Python aufruft (handleRpc patched)
    const ok = await rpcAskHost("submit_attacks", {
      name: localName,
      picks: list,
      rangeleien: desireRangeleien
    });
    if (!ok) { log("Wahl abgelehnt."); return; }
  }
});


// ==============================
// Screen 2 – Leben zahlen
// ==============================
[ui.cbStart, ui.cbEnd, ui.cbReact].forEach((cb) => {
  cb.addEventListener('change', async ()=>{
    if (isHost) {
      await Host.call("set_flags", { lobby_code: lobbyCodeVal, player_name: localName, start: ui.cbStart.checked, end: ui.cbEnd.checked, react: ui.cbReact.checked });
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
    await Host.call("submit_pay", { lobby_code: lobbyCodeVal, player_name: localName, amount });
    await broadcast("state", await Host.snapshot());
    showScreen(3);
  } else {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "submit_pay", data: { name: localName, amount }, reqId });
  }
});

// ==============================
// Screen 3 – Kampfsteuerung
// ==============================
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
    await Host.call("ui_pass", { lobby_code: lobbyCodeVal, player_name: localName });
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
    const ok = await Host.call("ui_play", { lobby_code: lobbyCodeVal, player_name: localName, char: selectedChar, attack_index: selectedAttackIndex });
    if (!ok) log("Attacke nicht einsetzbar.");
    await broadcast("state", await Host.snapshot());
  } else {
    const reqId = Math.random().toString(36).slice(2);
    await channel.publish("rpc", { to: hostId, op: "play", data: { name: localName, char: selectedChar, attackIndex: selectedAttackIndex }, reqId });
  }
});

// ==============================
// RPC handler (non-host)
// ==============================
async function handleRpc(op, data) {
  // Zielauswahl (immer beim Empfänger ausführen)
  if (op === "getchar") return await selectCharacterTarget();
  if (op === "getatk")  return await selectAttackTarget();
  if (op === "getstack")return await selectStackTarget();

  // Host-seitige RPCs: nur der Host führt Python aus
  if (!isHost) return null;

  switch (op) {
    case "get_pool_rangeleien": {
      // Nur anfragendem Client schicken, nicht broadcasten
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
      await broadcast("state", snap);
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
      await broadcast("state", snap);
      return true;
    }
    case "submit_pay": {
      await Host.call("submit_pay", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        amount: parseInt(data.amount || 0, 10)
      });
      const snap = await Host.snapshot();
      await broadcast("state", snap);
      return true;
    }
    case "pass": {
      await Host.call("ui_pass", {
        lobby_code: lobbyCodeVal,
        player_name: data.name
      });
      const snap = await Host.snapshot();
      await broadcast("state", snap);
      return true;
    }
    case "play": {
      await Host.call("ui_play", {
        lobby_code: lobbyCodeVal,
        player_name: data.name,
        char: data.char,
        attack_index: data.attackIndex
      });
      const snap = await Host.snapshot();
      await broadcast("state", snap);
      return true;
    }
  }
  return null;
}


// ==============================
// Target selection placeholders
// ==============================
async function selectCharacterTarget(){ return { side:"me", kind:"player", index:0 }; }
async function selectAttackTarget(){ return { charPath: { side:"me", kind:"player", index:0 }, attackIndex: 0 }; }
async function selectStackTarget(){ return 0; }

// ==============================
// Host ensure + send initial pool
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

    // Diagnostic: how many Attacke were found?
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
    await broadcast("state", snap);

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
