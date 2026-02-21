// scripts/generate-tetris-svg.js
import fs from "fs";
import { Octokit } from "@octokit/rest";

const username = process.env.GITHUB_USERNAME;
const token = process.env.GITHUB_TOKEN;

if (!username) throw new Error("GITHUB_USERNAME missing");

const octokit = new Octokit({ auth: token });

// --------------------
// Fetch contributions
// --------------------
async function fetchContribDays() {
  const query = `
    query($login:String!) {
      user(login:$login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql(query, { login: username });
  const weeks = res.user.contributionsCollection.contributionCalendar.weeks;
  return weeks.flatMap((w) => w.contributionDays);
}

// --------------------
// Deterministic RNG
// --------------------
function hashString(s) {
  // FNV-1a-ish
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --------------------
// Tetris model
// --------------------
const W = 10;      // well width
const H = 20;      // well height

// Tetromino definitions (4 rotations each, as list of (x,y) blocks)
const PIECES = {
  I: [
    [[0,1],[1,1],[2,1],[3,1]],
    [[2,0],[2,1],[2,2],[2,3]],
    [[0,2],[1,2],[2,2],[3,2]],
    [[1,0],[1,1],[1,2],[1,3]],
  ],
  O: [
    [[1,0],[2,0],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[2,1]],
  ],
  T: [
    [[1,0],[0,1],[1,1],[2,1]],
    [[1,0],[1,1],[2,1],[1,2]],
    [[0,1],[1,1],[2,1],[1,2]],
    [[1,0],[0,1],[1,1],[1,2]],
  ],
  S: [
    [[1,0],[2,0],[0,1],[1,1]],
    [[1,0],[1,1],[2,1],[2,2]],
    [[1,1],[2,1],[0,2],[1,2]],
    [[0,0],[0,1],[1,1],[1,2]],
  ],
  Z: [
    [[0,0],[1,0],[1,1],[2,1]],
    [[2,0],[1,1],[2,1],[1,2]],
    [[0,1],[1,1],[1,2],[2,2]],
    [[1,0],[0,1],[1,1],[0,2]],
  ],
  J: [
    [[0,0],[0,1],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[1,2]],
    [[0,1],[1,1],[2,1],[2,2]],
    [[1,0],[1,1],[0,2],[1,2]],
  ],
  L: [
    [[2,0],[0,1],[1,1],[2,1]],
    [[1,0],[1,1],[1,2],[2,2]],
    [[0,1],[1,1],[2,1],[0,2]],
    [[0,0],[1,0],[1,1],[1,2]],
  ],
};

const PIECE_ORDER = ["I", "O", "T", "S", "Z", "J", "L"];

// neon palette per piece
const PIECE_COLOR = {
  I: "#38bdf8", // sky
  O: "#fde047", // yellow
  T: "#a78bfa", // violet
  S: "#22c55e", // green
  Z: "#fb7185", // pink/red
  J: "#60a5fa", // blue
  L: "#f97316", // orange
};

function emptyBoard() {
  // board[y][x] = null or {piece: "T", color:"#..."}
  return Array.from({ length: H }, () => Array.from({ length: W }, () => null));
}

function canPlace(board, shape, ox, oy) {
  for (const [dx, dy] of shape) {
    const x = ox + dx;
    const y = oy + dy;
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    if (board[y][x]) return false;
  }
  return true;
}

function stamp(board, shape, ox, oy, piece) {
  for (const [dx, dy] of shape) {
    const x = ox + dx;
    const y = oy + dy;
    board[y][x] = { piece, color: PIECE_COLOR[piece] };
  }
}

function clearFullRows(board) {
  let cleared = 0;
  const newRows = [];

  for (let y = 0; y < H; y++) {
    const full = board[y].every((c) => c !== null);
    if (full) {
      cleared++;
    } else {
      newRows.push(board[y]);
    }
  }

  while (newRows.length < H) {
    newRows.unshift(Array.from({ length: W }, () => null));
  }

  return { board: newRows, cleared };
}

// --------------------
// Convert contributions -> number of pieces + seed
// --------------------
function deriveGamePlan(days) {
  // Use recent activity to define "how long the game runs"
  const recent = days.slice(-180);
  const total = recent.reduce((a, d) => a + d.contributionCount, 0);

  // Energy: damp high values, keep it stable
  const energy = recent.reduce((a, d) => a + Math.min(d.contributionCount, 10), 0);

  // Pieces target: keep SVG size manageable
  // ~14 to 26 pieces feels animated but not huge
  const pieces = clamp(Math.floor(energy / 35), 14, 26);

  // Seed uses username + total so it changes gradually over time
  const seed = hashString(`${username}:${total}:${recent[0]?.date ?? ""}`);

  // Also return quick stats for HUD
  const last7 = days.slice(-7).reduce((a, d) => a + d.contributionCount, 0);
  const last30 = days.slice(-30).reduce((a, d) => a + d.contributionCount, 0);

  return { pieces, seed, totalRecent: total, last7, last30 };
}

// --------------------
// Simulate game -> steps (frames)
// --------------------
function simulateGame({ pieces, seed }) {
  const rng = mulberry32(seed);

  let board = emptyBoard();
  let score = 0;
  let lines = 0;

  // Each step = { boardSnapshot, falling, flashRows, score, lines }
  const steps = [];

  for (let i = 0; i < pieces; i++) {
    const piece = PIECE_ORDER[Math.floor(rng() * PIECE_ORDER.length)];
    const rot = Math.floor(rng() * 4);
    const shape = PIECES[piece][rot];

    // spawn x around center, allow some randomness
    let ox = clamp(Math.floor(3 + rng() * 4), 0, W - 4);
    let oy = 0;

    // If spawn collides, nudge a bit
    let tries = 0;
    while (!canPlace(board, shape, ox, oy) && tries < 10) {
      ox = clamp(Math.floor(rng() * (W - 3)), 0, W - 4);
      tries++;
    }
    if (!canPlace(board, shape, ox, oy)) {
      // Game over condition: stop
      break;
    }

    // Drop until collision
    let dropY = oy;
    while (canPlace(board, shape, ox, dropY + 1)) dropY++;

    // Snapshot BEFORE landing (for animation: falling piece)
    steps.push({
      board: board,
      falling: { piece, shape, ox, fromY: -4, toY: dropY },
      flashRows: [],
      score,
      lines,
    });

    // Land
    const boardAfterLand = board.map((row) => row.map((c) => (c ? { ...c } : null)));
    stamp(boardAfterLand, shape, ox, dropY, piece);

    // Placement points (simple)
    score += 5;

    // Clear rows
    const beforeClear = boardAfterLand;
    const { board: afterClear, cleared } = clearFullRows(boardAfterLand);

    if (cleared > 0) {
      lines += cleared;
      // Tetris-like scoring
      const lineScore = [0, 100, 300, 500, 800][clamp(cleared, 0, 4)];
      score += lineScore;

      // Flash any full rows from the "beforeClear" snapshot
      const flash = [];
      for (let y = 0; y < H; y++) {
        if (beforeClear[y].every((c) => c !== null)) flash.push(y);
      }

      steps.push({
        board: beforeClear,
        falling: null,
        flashRows: flash,
        score,
        lines,
      });

      board = afterClear;
      steps.push({
        board: board,
        falling: null,
        flashRows: [],
        score,
        lines,
      });
    } else {
      board = beforeClear;
      // Snapshot AFTER landing
      steps.push({
        board: board,
        falling: null,
        flashRows: [],
        score,
        lines,
      });
    }
  }

  // Final state
  steps.push({
    board,
    falling: null,
    flashRows: [],
    score,
    lines,
  });

  return steps;
}

// --------------------
// SVG Rendering
// --------------------
function renderSvg(steps, hudStats) {
  const cell = 18;
  const gap = 2;

  const pad = 22;
  const wellW = W * (cell + gap) - gap;
  const wellH = H * (cell + gap) - gap;

  const width = pad * 2 + wellW;
  const height = pad * 2 + wellH + 52;

  // Timing
  const stepDur = 0.9;  // seconds per step
  const totalDur = Math.max(steps.length * stepDur, 8);

  const defs = `
  <defs>
    <filter id="neonGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.7" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#070a14"/>
      <stop offset="100%" stop-color="#0b1020"/>
    </linearGradient>
  </defs>
  `;

  const title = `
  <text x="${pad}" y="${pad - 6}"
        fill="#e5e7eb"
        font-family="ui-sans-serif, system-ui"
        font-size="15"
        font-weight="800">
    Contribution Tetris (tetromino mode)
  </text>
  `;

  // Well background tiles
  let grid = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = pad + x * (cell + gap);
      const py = pad + y * (cell + gap);
      grid += `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="3" fill="#0b1224" stroke="#0f172a" stroke-width="1" />\n`;
    }
  }

  function renderBoard(board) {
    let out = "";
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = board[y][x];
        if (!c) continue;
        const px = pad + x * (cell + gap);
        const py = pad + y * (cell + gap);
        out += `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="3"
                      fill="${c.color}" stroke="#0f172a" stroke-width="1"
                      filter="url(#neonGlow)" />\n`;
      }
    }
    return out;
  }

  function renderFlashRows(rows, begin, dur) {
    if (!rows || rows.length === 0) return "";
    let out = "";
    for (const y of rows) {
      const py = pad + y * (cell + gap);
      out += `
        <rect x="${pad}" y="${py}" width="${wellW}" height="${cell}" rx="6"
              fill="#ffffff" opacity="0">
          <animate attributeName="opacity" values="0;0.55;0" dur="${dur}s" begin="${begin}s" fill="freeze" />
        </rect>
      `;
    }
    return out;
  }

  function renderFalling(falling, begin, dur) {
    if (!falling) return "";
    const { piece, shape, ox, fromY, toY } = falling;
    const color = PIECE_COLOR[piece];

    const x0 = pad + ox * (cell + gap);
    const yStart = pad + fromY * (cell + gap);
    const yEnd = pad + toY * (cell + gap);

    // Render as a group translated in Y
    let blocks = "";
    for (const [dx, dy] of shape) {
      const bx = x0 + dx * (cell + gap);
      const by = yStart + dy * (cell + gap);
      blocks += `<rect x="${bx}" y="${by}" width="${cell}" height="${cell}" rx="3"
                      fill="${color}" stroke="#0f172a" stroke-width="1"
                      filter="url(#neonGlow)" />\n`;
    }

    // Animate translateY by (yEnd - yStart)
    const dyTrans = (yEnd - yStart).toFixed(2);

    return `
      <g opacity="1">
        <animateTransform attributeName="transform" type="translate"
                          from="0 0" to="0 ${dyTrans}"
                          dur="${dur}s" begin="${begin}s" fill="freeze" />
        <animate attributeName="opacity" values="1;1;0"
                 keyTimes="0;0.98;1" dur="${dur}s" begin="${begin}s" fill="freeze" />
        ${blocks}
      </g>
    `;
  }

  // Frame groups: show board snapshots step-by-step
  let frames = "";
  for (let i = 0; i < steps.length; i++) {
    const begin = i * stepDur;
    const end = begin + stepDur;

    const boardSvg = renderBoard(steps[i].board);
    const flashSvg = renderFlashRows(steps[i].flashRows, begin + stepDur * 0.15, stepDur * 0.55);
    const fallingSvg = renderFalling(steps[i].falling, begin, stepDur * 0.9);

    frames += `
      <g opacity="0">
        <animate attributeName="opacity"
                 values="0;1;1;0"
                 keyTimes="0;0.02;0.98;1"
                 dur="${stepDur}s"
                 begin="${begin}s"
                 fill="freeze" />
        ${boardSvg}
      </g>
      ${fallingSvg}
      ${flashSvg}
    `;
  }

  // HUD (scoreboard)
  const hud = (() => {
    const { totalRecent, last7, last30 } = hudStats;

    // Take last step score/lines
    const final = steps[steps.length - 1] || { score: 0, lines: 0 };
    const score = final.score ?? 0;
    const lines = final.lines ?? 0;

    const y = pad + wellH + 34;

    return `
      <g opacity="0.98">
        <rect x="${pad}" y="${y - 18}" width="${width - pad * 2}" height="28" rx="10"
              fill="#0f172a" stroke="#1f2a44" />
        <text x="${pad + 12}" y="${y}" fill="#e5e7eb"
              font-family="ui-sans-serif, system-ui" font-size="12" font-weight="800">
          SCORE: ${score}  •  LINES: ${lines}
        </text>
        <text x="${pad + 175}" y="${y}" fill="#93c5fd"
              font-family="ui-sans-serif, system-ui" font-size="12">
          Recent: ${totalRecent}
        </text>
        <text x="${pad + 292}" y="${y}" fill="#86efac"
              font-family="ui-sans-serif, system-ui" font-size="12">
          7d: ${last7}
        </text>
        <text x="${pad + 360}" y="${y}" fill="#fda4af"
              font-family="ui-sans-serif, system-ui" font-size="12">
          30d: ${last30}
        </text>
      </g>
    `;
  })();

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
     viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>
  ${defs}
  ${title}
  ${grid}
  ${frames}
  ${hud}
</svg>
`.trim();
}

// --------------------
// Main
// --------------------
const days = await fetchContribDays();
const plan = deriveGamePlan(days);
const steps = simulateGame(plan);
const svg = renderSvg(steps, plan);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/tetris.svg", svg, "utf-8");
console.log("Wrote output/tetris.svg");
