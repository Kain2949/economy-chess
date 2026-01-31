// Economy Chess WebApp — move + buy, WS, smooth timers, glow dots (capture = big red).

const API_BASE = "https://kristan-labored-earsplittingly.ngrok-free.dev";
const API_KEY = "jdKSnwe134Hdbsju39r4bsk3r4b239gwj4hjbw3r4r5wer";

const tg = window.Telegram?.WebApp;
if (tg)
{
  try { tg.expand(); } catch {}
}

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
let GAME = null;

let selectedFrom = ""; // "e2"
let selectedBuy = "";  // "p","n","b","r","q"

// dots sets (real squares)
let dotMove = new Set();    // normal legal moves
let dotCap = new Set();     // capture moves (big red)
let dotBuy = new Set();     // buy targets

let serverOffset = 0;

let ws = null;
let wsBackoffMs = 500;
let wsPingTimer = null;
let pollTimer = null;

// ===== CONFIG =====
const COSTS =
{
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9
};

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

  return await res.json();
}

function parseFen(fen)
{
  const parts = (fen || "").split(" ");
  const boardPart = parts[0] || "";
  const ep = (parts[3] && parts[3] !== "-") ? parts[3] : "";

  const rows = boardPart.split("/");
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

  return { map, ep };
}

function isWhitePieceChar(ch)
{
  return ch && (ch === ch.toUpperCase());
}

function isMyPieceChar(ch)
{
  if (!ch || !MY_SIDE) return false;
  const w = isWhitePieceChar(ch);
  return (MY_SIDE === "w" && w) || (MY_SIDE === "b" && !w);
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

function squareColorClass(fileChar, rankNum)
{
  // a1 is dark
  const f = fileChar.charCodeAt(0) - 97;
  const r = rankNum - 1;
  return ((f + r) % 2 === 0) ? "dark" : "light";
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
  dotMove.clear();
  dotCap.clear();
}

function clearBuySelection()
{
  selectedBuy = "";
  dotBuy.clear();
  document.querySelectorAll(".shopbtn").forEach(b => b.classList.remove("active"));
}

function clearAllSelection()
{
  clearMoveSelection();
  clearBuySelection();
}

// ===== PIECES (SVG silhouettes) =====
// Not chess.com assets (those are copyrighted). This is a custom silhouette set with outline for black.
function pieceSvg(ch)
{
  const p = (ch || "").toLowerCase();
  const white = isWhitePieceChar(ch);

  const fill = white ? "rgba(245,248,255,0.95)" : "rgba(0,0,0,0.0)";
  const stroke = white ? "rgba(190,210,255,0.18)" : "rgba(255,255,255,0.38)";
  const strokeW = white ? "1.6" : "2.8";

  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" stroke-linejoin="round" stroke-linecap="round"`;

  const paths =
  {
    p: `<circle ${common} cx="32" cy="18" r="7"/>
        <path ${common} d="M26 28c0 6 3 10 6 14h-6v6h24v-6h-6c3-4 6-8 6-14 0-3-1-6-2-8H28c-1 2-2 5-2 8z"/>
        <path ${common} d="M18 52h28l4 8H14l4-8z"/>`,

    r: `<path ${common} d="M18 14h28v10h-4v-5h-4v5h-4v-5h-4v5h-4v-5h-4v5h-4V14z"/>
        <path ${common} d="M22 24h20v20H22z"/>
        <path ${common} d="M16 52h32l4 8H12l4-8z"/>`,

    n: `<path ${common} d="M44 18c-8-8-24-6-28 6l-2 8 10 6-6 10h20c6 0 10-4 10-10 0-6-4-10-10-10h-4l2-4c2-4 2-4 8-6z"/>
        <path ${common} d="M16 52h32l4 8H12l4-8z"/>`,

    b: `<path ${common} d="M32 12c6 0 10 5 10 10 0 5-3 8-6 10 4 3 6 7 6 12 0 6-4 10-10 10s-10-4-10-10c0-5 2-9 6-12-3-2-6-5-6-10 0-5 4-10 10-10z"/>
        <path ${common} d="M16 52h32l4 8H12l4-8z"/>`,

    q: `<path ${common} d="M18 24c0 9 6 14 14 16l-6 8h12l-6-8c8-2 14-7 14-16H18z"/>
        <circle ${common} cx="24" cy="18" r="3"/>
        <circle ${common} cx="32" cy="14" r="3"/>
        <circle ${common} cx="40" cy="18" r="3"/>
        <path ${common} d="M16 52h32l4 8H12l4-8z"/>`,

    k: `<path ${common} d="M30 10h4v6h6v4h-6v6h-4v-6h-6v-4h6v-6z"/>
        <path ${common} d="M22 28c0 10 6 16 10 18l-6 8h12l-6-8c4-2 10-8 10-18H22z"/>
        <path ${common} d="M16 52h32l4 8H12l4-8z"/>`
  };

  const cls = white ? "pcw" : "pcb";
  return `<svg class="pcsvg ${cls}" viewBox="0 0 64 64" aria-hidden="true">${paths[p] || ""}</svg>`;
}

// ===== DOTS (inline styles so CSS can stay simple) =====
function dotStyle(kind)
{
  // kind: "move" | "cap" | "buy" | "sel"
  let size = 10;
  let c = "rgba(0, 255, 210, 0.92)";   // teal
  let glow = "0 0 10px rgba(0, 255, 210, 0.55), 0 0 22px rgba(0, 255, 210, 0.28)";

  if (kind === "buy")
  {
    c = "rgba(255, 215, 0, 0.92)";
    glow = "0 0 10px rgba(255, 215, 0, 0.45), 0 0 22px rgba(255, 215, 0, 0.22)";
    size = 11;
  }
  if (kind === "cap")
  {
    c = "rgba(255, 80, 120, 0.95)";
    glow = "0 0 12px rgba(255, 80, 120, 0.55), 0 0 28px rgba(255, 80, 120, 0.28)";
    size = 20; // ~2x
  }
  if (kind === "sel")
  {
    c = "rgba(193, 76, 255, 0.95)";
    glow = "0 0 12px rgba(193, 76, 255, 0.55), 0 0 28px rgba(193, 76, 255, 0.28)";
    size = 14;
  }

  return { size, c, glow };
}

function makeDot(kind)
{
  const d = document.createElement("span");
  const s = dotStyle(kind);

  d.style.position = "absolute";
  d.style.left = "50%";
  d.style.top = "50%";
  d.style.transform = "translate(-50%, -50%)";
  d.style.width = s.size + "px";
  d.style.height = s.size + "px";
  d.style.borderRadius = "999px";
  d.style.background = s.c;
  d.style.boxShadow = s.glow;
  d.style.pointerEvents = "none";
  d.style.zIndex = "1";
  return d;
}

// ===== UI =====
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
  dotMove.clear();
  dotCap.clear();

  if (!selectedFrom || !isMyTurn()) return;
  if (!GAME_ID) return;

  const r = await apiPost("/api/game/legals",
  {
    game_id: GAME_ID,
    username: USERNAME,
    from: selectedFrom
  });

  const dests = (r && r.ok) ? (r.dests || []) : [];
  const { map, ep } = parseFen(GAME.fen);

  const fromPc = map[selectedFrom] || "";
  const fromIsPawn = fromPc && fromPc.toLowerCase() === "p";

  for (const to of dests)
  {
    const toPc = map[to];

    // normal capture
    if (toPc && !isMyPieceChar(toPc))
    {
      dotCap.add(to);
      continue;
    }

    // en-passant capture heuristic
    if (fromIsPawn && ep && to === ep)
    {
      const df = Math.abs(to.charCodeAt(0) - selectedFrom.charCodeAt(0));
      if (df === 1) dotCap.add(to);
      else dotMove.add(to);
      continue;
    }

    dotMove.add(to);
  }
}

async function refreshBuyTargets()
{
  dotBuy.clear();
  if (!selectedBuy || !isMyTurn()) return;
  if (!GAME_ID) return;

  const r = await apiPost("/api/game/drop_targets",
  {
    game_id: GAME_ID,
    username: USERNAME,
    piece: selectedBuy
  });

  const targets = (r && r.ok) ? (r.targets || []) : [];
  dotBuy = new Set(targets);
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
  tickTimers();

  const { map } = parseFen(GAME.fen);

  const squares = [];
  for (let vr = 8; vr >= 1; vr--)
  {
    for (let vf = 0; vf < 8; vf++)
    {
      const file = String.fromCharCode(97 + vf);
      const disp = file + vr;
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
    div.className = "sq " + squareColorClass(file, rank);
    div.dataset.sq = real;

    // to support absolute dots
    div.style.position = "relative";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.justifyContent = "center";

    // piece
    const pc = map[real];
    if (pc)
    {
      div.classList.add("haspc", isWhitePieceChar(pc) ? "pcw" : "pcb");
      div.innerHTML = pieceSvg(pc);

      // ensure centering
      const svg = div.querySelector("svg");
      if (svg)
      {
        svg.style.width = "78%";
        svg.style.height = "78%";
        svg.style.display = "block";
        svg.style.zIndex = "2";
        svg.style.pointerEvents = "none";
        // soft shadow so white stands out; black already outlined
        svg.style.filter = isWhitePieceChar(pc)
          ? "drop-shadow(0 10px 26px rgba(0,0,0,0.45))"
          : "drop-shadow(0 10px 26px rgba(0,0,0,0.35))";
      }
    }

    // dots
    if (selectedFrom === real)
    {
      div.classList.add("sel");
      div.appendChild(makeDot("sel"));
    }
    if (dotMove.has(real)) div.appendChild(makeDot("move"));
    if (dotCap.has(real)) div.appendChild(makeDot("cap"));
    if (dotBuy.has(real)) div.appendChild(makeDot("buy"));

    div.addEventListener("click", () => onSquareClick(real));
    elBoard.appendChild(div);
  }
}

function applySnapshot(newGame)
{
  if (!newGame) return;

  if (!newGame.you && MY_SIDE) newGame.you = MY_SIDE;

  // ignore stale snapshots (prevents WS/poll overwriting newer coins/fen)
  if (GAME && typeof GAME.server_ts === "number" && typeof newGame.server_ts === "number")
  {
    if (newGame.server_ts < GAME.server_ts) return;
  }

  GAME = newGame;

  if (!MY_SIDE && GAME.you) MY_SIDE = GAME.you;

  const nowClient = Math.floor(Date.now() / 1000);
  if (typeof GAME.server_ts === "number")
  {
    serverOffset = GAME.server_ts - nowClient;
  }

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
    if (!dotBuy.has(sq)) return;

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

    if (GAME.in_check_start === 1 && GAME.buy_locked === 1)
    {
      clearBuySelection();
      await refreshMoveTargets();
      render();
      return;
    }

    await refreshBuyTargets();
    render();
    return;
  }

  // MOVE mode
  if (!isMyTurn()) return;

  const { map } = parseFen(GAME.fen);
  const pc = map[sq];

  // select your own piece
  if (pc && isMyPieceChar(pc))
  {
    selectedFrom = sq;
    await refreshMoveTargets();
    render();
    return;
  }

  // move to legal target
  if (selectedFrom && (dotMove.has(sq) || dotCap.has(sq)))
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

  // otherwise clear selection
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

      if (GAME.in_check_start === 1 && GAME.buy_locked === 1) return;

      const p = (btn.dataset.piece || "").toLowerCase();
      if (!COSTS[p]) return;

      const coins = myCoins();
      if (coins < COSTS[p]) return;

      if (selectedBuy === p)
      {
        clearBuySelection();
        render();
        return;
      }

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

  const nowClient = Math.floor(Date.now() / 1000);
  const nowServer = nowClient + serverOffset;

  const globalRem = Math.max(0, GAME.global_end_ts - nowServer);

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

// ===== WS / POLL =====
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
    startPolling();
    return;
  }

  ws.onopen = () =>
  {
    wsBackoffMs = 500;

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
        if (GAME)
        {
          GAME.status = "finished";
          GAME.result = msg.data;
        }
        render();

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
    // onclose will handle
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
    setStatus("Не могу определить твою сторону. Убедись, что ты нажимал /start у бота.");
    render();
    startPolling();
    return;
  }

  connectWS();
  render();
}

setInterval(() =>
{
  tickTimers();
}, 250);

init();
