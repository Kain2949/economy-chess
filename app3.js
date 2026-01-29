// Economy Chess WebApp — click controls (move + buy), WS updates, smooth timers.
//
// Set these 2:
//   API_BASE = ngrok HTTPS URL (no trailing slash)
//   API_KEY  = WEB_SECRET_KEY from chesswa.py
//
// The WebApp identifies you by Telegram username (@name). If Telegram username is missing,
// it will ask once and save to localStorage.
//
// Backend endpoints used:
//   POST /api/game/my            { username }
//   POST /api/game/legals        { game_id, username, from }
//   POST /api/game/drop_targets  { game_id, username, piece }
//   POST /api/game/drop          { game_id, username, piece, square }
//   POST /api/game/move          { game_id, username, from, to }
//   WS   /ws/game/{game_id}?key=API_KEY&username=@name
//
// Notes:
// - WS state messages from your backend may have data.you = null. We preserve MY_SIDE locally.
// - Timers are computed from server snapshot using serverOffset.

const API_BASE = "https://YOUR-NGROK.ngrok-free.dev";
const API_KEY = "super_secret_key_change_me";

const tg = window.Telegram?.WebApp;
if (tg)
{
  try { tg.expand(); } catch {}
}

const COSTS =
{
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9
};

// ===== DOM =====
const elBoard = document.getElementById("board");
const elStatus = document.getElementById("status");
const elMe = document.getElementById("me");
const elCW = document.getElementById("cW");
const elCB = document.getElementById("cB");
const elMyCoins = document.getElementById("myCoins");
const elTG = document.getElementById("tGlobal");
const elTW = document.getElementById("tW");
const elTB = document.getElementById("tB");

function setStatus(s)
{
  if (elStatus) elStatus.textContent = s;
}

function fmt(sec)
{
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function wsUrlFromHttpBase(httpBase)
{
  const u = new URL(httpBase);
  u.protocol = (u.protocol === "https:") ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

// ===== STATE =====
let USERNAME = "";
let GAME_ID = "";
let MY_SIDE = ""; // "w" or "b"

let GAME = null; // last server snapshot game payload

// client-side selections (not shared with opponent)
let selectedFrom = ""; // square "e2"
let selectedBuy = "";  // "p","n","b","r","q"
let green = new Set(); // legal move target squares
let yellow = new Set(); // drop target squares

// timers smoothing
let serverOffset = 0; // server_ts - client_now_ts at snapshot

// WS + fallback polling
let ws = null;
let wsBackoffMs = 500;
let wsPingTimer = null;
let pollTimer = null;

// ===== HELPERS =====
function getTelegramUsername()
{
  try
  {
    const u = tg?.initDataUnsafe?.user;
    if (u?.username) return "@" + u.username;
  }
  catch {}
  return "";
}

function getUsername()
{
  let u = getTelegramUsername();
  if (u) return u;

  u = (localStorage.getItem("ec_username") || "").trim();
  if (u) return u.startsWith("@") ? u : ("@" + u);

  const p = prompt("Введи свой Telegram username (например: @myname)");
  if (!p) return "";
  const v = p.trim().startsWith("@") ? p.trim() : ("@" + p.trim());
  localStorage.setItem("ec_username", v);
  return v;
}

async function apiPost(path, body)
{
  const res = await fetch(API_BASE + path,
  {
    method: "POST",
    headers:
    {
      "Content-Type": "application/json",
      "X-API-KEY": API_KEY
    },
    body: JSON.stringify(body || {})
  });

  // If ngrok/hosting returns HTML error, this would throw. That's ok.
  return await res.json();
}

function fenToMap(fen)
{
  const part = fen.split(" ")[0];
  const rows = part.split("/");
  const map = {};
  for (let r = 0; r < 8; r++)
  {
    let file = 0;
    for (const ch of rows[r])
    {
      if (/\d/.test(ch))
      {
        file += parseInt(ch, 10);
      }
      else
      {
        const sq = String.fromCharCode(97 + file) + (8 - r);
        map[sq] = ch;
        file++;
      }
    }
  }
  return map;
}

function pieceGlyph(ch)
{
  const isWhite = (ch === ch.toUpperCase());
  const p = ch.toLowerCase();
  const w = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" };
  const b = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  return isWhite ? w[p] : b[p];
}

function myCoins()
{
  if (!GAME) return 0;
  return (MY_SIDE === "w") ? GAME.coins_w : GAME.coins_b;
}

function isMyTurn()
{
  return GAME && GAME.status === "active" && GAME.turn === MY_SIDE;
}

function clearMoveSelection()
{
  selectedFrom = "";
  green.clear();
}

function clearBuySelection()
{
  selectedBuy = "";
  yellow.clear();
  document.querySelectorAll(".shopbtn").forEach(b => b.classList.remove("active"));
}

function clearAllSelection()
{
  clearMoveSelection();
  clearBuySelection();
}

function squareAllowedColorClass(fileChar, rankNum)
{
  // Standard: a1 is dark
  const f = fileChar.charCodeAt(0) - 97;
  const r = rankNum - 1;
  return ((f + r) % 2 === 0) ? "dark" : "light";
}

function flipSquareIfBlackPerspective(sq)
{
  if (MY_SIDE !== "b") return sq;

  const file = sq[0];
  const rank = parseInt(sq[1], 10);

  const f = 7 - (file.charCodeAt(0) - 97);
  const r = 9 - rank;

  return String.fromCharCode(97 + f) + r;
}

// ===== UI UPDATES =====
function updateShopButtons()
{
  if (!GAME) return;

  const coins = myCoins();
  const buyBlocked = (!isMyTurn()) || (GAME.in_check_start === 1 && GAME.buy_locked === 1);

  for (const p of ["p", "n", "b", "r", "q"])
  {
    const qty = Math.floor(coins / COSTS[p]);
    const qtyEl = document.getElementById("q_" + p);
    if (qtyEl) qtyEl.textContent = (qty > 0 && !buyBlocked) ? String(qty) : "";

    const btn = document.querySelector(`.shopbtn[data-piece="${p}"]`);
    if (btn)
    {
      const dim = buyBlocked || qty <= 0;
      btn.classList.toggle("dim", dim);
    }
  }
}

async function refreshMoveTargets()
{
  green.clear();
  if (!selectedFrom || !isMyTurn()) return;

  const r = await apiPost("/api/game/legals",
  {
    game_id: GAME_ID,
    username: USERNAME,
    from: selectedFrom
  });

  const dests = (r && r.ok) ? (r.dests || []) : [];
  green = new Set(dests);
}

async function refreshBuyTargets()
{
  yellow.clear();
  if (!selectedBuy || !isMyTurn()) return;

  const r = await apiPost("/api/game/drop_targets",
  {
    game_id: GAME_ID,
    username: USERNAME,
    piece: selectedBuy
  });

  const targets = (r && r.ok) ? (r.targets || []) : [];
  yellow = new Set(targets);
}

function render()
{
  if (!GAME)
  {
    setStatus("Нет активной партии. Открой матч через бота.");
    if (elBoard) elBoard.innerHTML = "";
    return;
  }

  if (GAME.status === "active")
  {
    setStatus(isMyTurn() ? "Твой ход" : "Ход соперника");
  }
  else
  {
    setStatus("Партия завершена");
  }

  if (elMe) elMe.textContent = USERNAME || "?";
  if (elCW) elCW.textContent = String(GAME.coins_w);
  if (elCB) elCB.textContent = String(GAME.coins_b);
  if (elMyCoins) elMyCoins.textContent = String(myCoins());

  updateShopButtons();

  // render timers once here; tick() will update continuously
  tickTimers();

  // render board
  const map = fenToMap(GAME.fen);

  // Visual board squares: we always generate "display squares" from a8..h1
  // and map to real squares when MY_SIDE === "b"
  const squares = [];
  for (let vr = 8; vr >= 1; vr--)
  {
    for (let vf = 0; vf < 8; vf++)
    {
      const file = String.fromCharCode(97 + vf);
      const disp = file + vr; // display label
      const real = (MY_SIDE === "b") ? flipSquareIfBlackPerspective(disp) : disp;
      squares.push({ disp, real });
    }
  }

  elBoard.innerHTML = "";
  for (const { disp, real } of squares)
  {
    const file = disp[0];
    const rank = parseInt(disp[1], 10);

    const div = document.createElement("div");
    div.className = "sq " + squareAllowedColorClass(file, rank);
    div.dataset.sq = real;

    const pc = map[real];
    if (pc) div.textContent = pieceGlyph(pc);

    if (selectedFrom === real) div.classList.add("sel");
    if (green.has(real)) div.classList.add("g");
    if (yellow.has(real)) div.classList.add("y");

    div.addEventListener("click", () => onSquareClick(real));
    elBoard.appendChild(div);
  }
}

function applySnapshot(newGame)
{
  if (!newGame) return;

  // preserve side even if WS snapshot has no "you"
  if (!newGame.you && MY_SIDE) newGame.you = MY_SIDE;

  GAME = newGame;

  // If we didn't know side yet (first load), take it
  if (!MY_SIDE && GAME.you) MY_SIDE = GAME.you;

  // update time offset
  const nowClient = Math.floor(Date.now() / 1000);
  if (typeof GAME.server_ts === "number")
  {
    serverOffset = GAME.server_ts - nowClient;
  }

  // clear local selections after any server update (prevents desync)
  clearAllSelection();
  render();
}

// ===== CLICK HANDLERS =====
async function onSquareClick(sq)
{
  if (!GAME || GAME.status !== "active") return;

  // BUY mode
  if (selectedBuy)
  {
    if (!isMyTurn()) return;
    if (!yellow.has(sq)) return;

    const r = await apiPost("/api/game/drop",
    {
      game_id: GAME_ID,
      username: USERNAME,
      piece: selectedBuy,
      square: sq
    });

    if (!r || !r.ok)
    {
      setStatus("Ошибка покупки: " + (r?.reason || "unknown"));
      return;
    }

    applySnapshot(r.game);

    // If buy got locked by "resolve check" rule, exit buy mode
    if (GAME.in_check_start === 1 && GAME.buy_locked === 1)
    {
      clearBuySelection();
      await refreshMoveTargets();
      render();
      return;
    }

    // still in buy mode: refresh targets (coins changed / square occupied now)
    await refreshBuyTargets();
    render();
    return;
  }

  // MOVE mode
  if (!isMyTurn()) return;

  const map = fenToMap(GAME.fen);
  const pc = map[sq];

  // Click your own piece -> select it (like normal chess)
  if (pc)
  {
    const isWhite = (pc === pc.toUpperCase());
    const isMine = (MY_SIDE === "w" && isWhite) || (MY_SIDE === "b" && !isWhite);
    if (isMine)
    {
      selectedFrom = sq;
      await refreshMoveTargets();
      render();
      return;
    }
  }

  // Click a legal target -> make move
  if (selectedFrom && green.has(sq))
  {
    const r = await apiPost("/api/game/move",
    {
      game_id: GAME_ID,
      username: USERNAME,
      from: selectedFrom,
      to: sq
    });

    if (!r || !r.ok)
    {
      setStatus("Ошибка хода: " + (r?.reason || "unknown"));
      return;
    }

    applySnapshot(r.game);
    return;
  }

  // Click anywhere else clears selection
  if (selectedFrom)
  {
    clearMoveSelection();
    render();
  }
}

// ===== SHOP BUTTONS =====
function setupShopButtons()
{
  document.querySelectorAll(".shopbtn").forEach(btn =>
  {
    btn.addEventListener("click", async () =>
    {
      if (!GAME || GAME.status !== "active") return;
      if (!isMyTurn()) return;

      // blocked by special rule
      if (GAME.in_check_start === 1 && GAME.buy_locked === 1) return;

      const p = (btn.dataset.piece || "").toLowerCase();
      if (!COSTS[p]) return;

      const coins = myCoins();
      if (coins < COSTS[p]) return;

      // toggle
      if (selectedBuy === p)
      {
        clearBuySelection();
        render();
        return;
      }

      // entering buy mode cancels move selection
      clearMoveSelection();
      selectedBuy = p;

      document.querySelectorAll(".shopbtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      await refreshBuyTargets();
      render();
    });
  });
}

// ===== TIMERS =====
function tickTimers()
{
  if (!GAME)
  {
    if (elTG) elTG.textContent = "--:--";
    if (elTW) elTW.textContent = "--:--";
    if (elTB) elTB.textContent = "--:--";
    return;
  }

  // approximate server "now" using offset
  const nowClient = Math.floor(Date.now() / 1000);
  const nowServer = nowClient + serverOffset;

  const globalRem = Math.max(0, GAME.global_end_ts - nowServer);

  // elapsed since snapshot in server-time coordinates
  const snapTs = (typeof GAME.server_ts === "number") ? GAME.server_ts : nowServer;
  const elapsed = Math.max(0, nowServer - snapTs);

  let w = GAME.clock_w_rem;
  let b = GAME.clock_b_rem;

  if (GAME.status === "active")
  {
    if (GAME.turn === "w") w = Math.max(0, w - elapsed);
    if (GAME.turn === "b") b = Math.max(0, b - elapsed);
  }

  if (elTG) elTG.textContent = fmt(globalRem);
  if (elTW) elTW.textContent = fmt(w);
  if (elTB) elTB.textContent = fmt(b);
}

// ===== WS =====
function stopPolling()
{
  if (pollTimer)
  {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling()
{
  if (pollTimer) return;
  pollTimer = setInterval(async () =>
  {
    if (!GAME_ID) return;
    try
    {
      const r = await apiPost("/api/game/state",
      {
        game_id: GAME_ID,
        username: USERNAME
      });
      if (r && r.ok && r.game) applySnapshot(r.game);
    }
    catch {}
  }, 1200);
}

function closeWS()
{
  if (ws)
  {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (wsPingTimer)
  {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
}

function connectWS()
{
  if (!GAME_ID) return;

  closeWS();
  stopPolling();

  const base = wsUrlFromHttpBase(API_BASE);
  const url = base + `/ws/game/${encodeURIComponent(GAME_ID)}?key=${encodeURIComponent(API_KEY)}&username=${encodeURIComponent(USERNAME)}`;

  try
  {
    ws = new WebSocket(url);
  }
  catch
  {
    // fallback immediately
    startPolling();
    return;
  }

  ws.onopen = () =>
  {
    wsBackoffMs = 500;

    // keepalive
    wsPingTimer = setInterval(() =>
    {
      try
      {
        if (ws && ws.readyState === 1) ws.send("ping");
      }
      catch {}
    }, 20000);
  };

  ws.onmessage = (ev) =>
  {
    // server sends JSON for state/finished; may send "pong"
    if (typeof ev.data === "string" && ev.data === "pong") return;

    try
    {
      const msg = JSON.parse(ev.data);

      if (msg.type === "state")
      {
        if (msg.data) applySnapshot(msg.data);
        return;
      }

      if (msg.type === "finished")
      {
        // keep last board state, but show result
        if (GAME)
        {
          GAME.status = "finished";
          GAME.result = msg.data;
        }
        render();

        // show a short readable reason
        const r = msg.data || {};
        const reason = r.reason || "finished";
        const winner = r.winner || "";
        let text = `Партия завершена: ${reason}`;
        if (winner) text += `, победитель: ${winner}`;
        if (typeof r.cap_w === "number" && typeof r.cap_b === "number")
        {
          text += ` (капитал W=${r.cap_w}, B=${r.cap_b})`;
        }
        alert(text);
        return;
      }
    }
    catch {}
  };

  ws.onclose = () =>
  {
    closeWS();

    // WS can be flaky on free ngrok; fallback to polling after a few retries
    wsBackoffMs = Math.min(8000, Math.floor(wsBackoffMs * 1.6));
    if (wsBackoffMs >= 4000)
    {
      startPolling();
    }
    else
    {
      setTimeout(connectWS, wsBackoffMs);
    }
  };

  ws.onerror = () =>
  {
    // let onclose handle retry
  };
}

// ===== INIT =====
async function init()
{
  USERNAME = getUsername();
  if (!USERNAME)
  {
    setStatus("Нет username. Без него я не найду твою партию.");
    return;
  }

  if (elMe) elMe.textContent = USERNAME;

  setupShopButtons();

  setStatus("Загрузка партии…");

  let r = null;
  try
  {
    r = await apiPost("/api/game/my", { username: USERNAME });
  }
  catch
  {
    setStatus("Нет связи с backend (проверь API_BASE / ngrok).");
    return;
  }

  if (!r || !r.ok)
  {
    setStatus("Ошибка backend.");
    return;
  }

  if (!r.game)
  {
    setStatus("Нет активной партии. Создай матч через бота.");
    render();
    return;
  }

  applySnapshot(r.game);

  if (!GAME || !GAME.game_id)
  {
    setStatus("Некорректный ответ game.");
    return;
  }

  GAME_ID = GAME.game_id;

  if (!MY_SIDE)
  {
    // if backend couldn't determine side (rare), we still can show board,
    // but buying/moving will be blocked. Usually means user not in DB (no /start).
    setStatus("Не могу определить твою сторону. Убедись, что ты нажимал /start у бота.");
    render();
    startPolling();
    return;
  }

  connectWS();
  render();
}

// smooth UI timer tick
setInterval(() =>
{
  tickTimers();
}, 250);

init();
