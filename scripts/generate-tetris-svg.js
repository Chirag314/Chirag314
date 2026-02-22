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
const W = 10;
const H = 20;

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

const PIECE_COLOR = {
  I: "#38bdf8",
  O: "#fde047",
  T: "#a78bfa",
  S: "#22c55e",
  Z: "#fb7185",
  J: "#60a5fa",
  L: "#f97316",
};

function emptyBoard() {
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
    if (full) cleared++;
    else newRows.push(board[y]);
  }

  while (newRows.length < H) {
    newRows.unshift(Array.from({ length: W }, () => null));
  }

  return { board: newRows, cleared };
}

// --------------------
// Contributions -> schedule (mirrors activity)
// --------------------
function deriveGamePlan(days) {
  const recent = days.slice(-140); // strong “recent progress” mirroring

  const total = recent.reduce((a, d) => a + d.contributionCount, 0);
  const last7 = days.slice(-7).reduce((a, d) => a + d.contributionCount, 0);
  const last30 = days.slice(-30).reduce((a, d) => a + d.contributionCount, 0);

  // base seed changes over time with your contribution history
  const seed = hashString(`${username}:${total}:${recent[0]?.date ?? ""}`);

  // Build a deterministic drop schedule from daily counts:
  // - 0 contributions => usually no drops
  // - higher contributions => up to 3 drops/day
  const schedule = [];
  for (const d of recent) {
    const c = d.contributionCount;
    if (c <= 0) continue;

    const drops = clamp(1 + Math.floor(c / 8), 1, 3);

    for (let k = 0; k < drops; k++) {
      // NOTE: we will vary 'seed' per run; including seed here means piece TYPES change per run (Option B)
      const h = hashString(`${d.date}:${c}:${k}:${seed}`);

      const piece = PIECE_ORDER[h % PIECE_ORDER.length];
      const rot = (h >>> 8) % 4;
      const ox = (h >>> 16) % (W - 3);

      schedule.push({ piece, rot, ox });
    }
  }

  // keep svg manageable but not tiny
  const maxPieces = 42;
  const minPieces = 18;
  const pieces = clamp(schedule.length, minPieces, maxPieces);

  return {
    seed,
    pieces,
    schedule: schedule.slice(-pieces),
    totalRecent: total,
    last7,
    last30,
  };
}

// --------------------
// Simulate game -> steps
// --------------------
function simulateGame({ pieces, seed, schedule }) {
  const rng = mulberry32(seed);

  let board = emptyBoard();
  let score = 0;
  let lines = 0;

  const steps = [];

  for (let i = 0; i < pieces; i++) {
    const planned = schedule?.[i];

    const piece =
      planned?.piece ?? PIECE_ORDER[Math.floor(rng() * PIECE_ORDER.length)];
    const rot = planned?.rot ?? Math.floor(rng() * 4);
    const shape = PIECES[piece][rot];

    let ox = planned?.ox ?? clamp(Math.floor(3 + rng() * 4), 0, W - 4);
    let oy = 0;

    // If spawn collides, nudge a bit (still deterministic-ish)
    let tries = 0;
    while (!canPlace(board, shape, ox, oy) && tries < 10) {
      ox = clamp(Math.floor(rng() * (W - 3)), 0, W - 4);
      tries++;
    }
    if (!canPlace(board, shape, ox, oy)) break;

    let dropY = oy;
    while (canPlace(board, shape, ox, dropY + 1)) dropY++;

    steps.push({
      board,
      falling: { piece, shape, ox, fromY: -4, toY: dropY },
      flashRows: [],
      score,
      lines,
    });

    const boardAfterLand = board.map((row) => row.map((c) => (c ? { ...c } : null)));
    stamp(boardAfterLand, shape, ox, dropY, piece);

    score += 5;

    const beforeClear = boardAfterLand;
    const { board: afterClear, cleared } = clearFullRows(boardAfterLand);

    if (cleared > 0) {
      lines += cleared;
      const lineScore = [0, 100, 300, 500, 800][clamp(cleared, 0, 4)];
      score += lineScore;

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
        board,
        falling: null,
        flashRows: [],
        score,
        lines,
      });
    } else {
      board = beforeClear;
      steps.push({
        board,
        falling: null,
        flashRows: [],
        score,
        lines,
      });
    }
  }

  steps.push({ board, falling: null, flashRows: [], score, lines });
  return steps;
}

// --------------------
// SVG Rendering (10 runs + infinite loop)
// --------------------
function renderSvg(runs, hudStats) {
  const cell = 18;
  const gap = 2;

  const pad = 22;
  const wellW = W * (cell + gap) - gap;
  const wellH = H * (cell + gap) - gap;

  const width = pad * 2 + wellW;
  const height = pad * 2 + wellH + 52;

  // Make GitHub render it wide (intrinsic px size)
  const INTRINSIC_W = 1200;
  const INTRINSIC_H = Math.round((height / width) * INTRINSIC_W);

  // Timing
  const stepDur = 0.9;
  const runDurations = runs.map((steps) => Math.max(steps.length * stepDur, 8));
  const totalDur = runDurations.reduce((a, b) => a + b, 0);

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

    <!-- Master clock: repeats the whole 10-run timeline forever -->
    <animate id="clock" attributeName="opacity"
             values="1;1" dur="${totalDur}s" repeatCount="indefinite" />
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
          <animate attributeName="opacity" values="0;0.55;0"
                   dur="${dur}s" begin="clock.begin+${begin}s" fill="remove" />
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

    let blocks = "";
    for (const [dx, dy] of shape) {
      const bx = x0 + dx * (cell + gap);
      const by = yStart + dy * (cell + gap);
      blocks += `<rect x="${bx}" y="${by}" width="${cell}" height="${cell}" rx="3"
                      fill="${color}" stroke="#0f172a" stroke-width="1"
                      filter="url(#neonGlow)" />\n`;
    }

    const dyTrans = (yEnd - yStart).toFixed(2);

    return `
      <g opacity="1">
        <animateTransform attributeName="transform" type="translate"
                          from="0 0" to="0 ${dyTrans}"
                          dur="${dur}s" begin="clock.begin+${begin}s" fill="remove" />
        <animate attributeName="opacity" values="1;1;0"
                 keyTimes="0;0.98;1" dur="${dur}s" begin="clock.begin+${begin}s" fill="remove" />
        ${blocks}
      </g>
    `;
  }

  // Frames for all runs back-to-back with offsets
  let frames = "";
  let timeOffset = 0;

  for (let r = 0; r < runs.length; r++) {
    const steps = runs[r];

    for (let i = 0; i < steps.length; i++) {
      const beginLocal = i * stepDur;
      const begin = timeOffset + beginLocal;

      const boardSvg = renderBoard(steps[i].board);
      const flashSvg = renderFlashRows(
        steps[i].flashRows,
        begin + stepDur * 0.15,
        stepDur * 0.55
      );
      const fallingSvg = renderFalling(steps[i].falling, begin, stepDur * 0.9);

      frames += `
        <g opacity="0">
          <animate attributeName="opacity"
                   values="0;1;1;0"
                   keyTimes="0;0.02;0.98;1"
                   dur="${stepDur}s"
                   begin="clock.begin+${begin}s"
                   fill="remove" />
          ${boardSvg}
        </g>
        ${fallingSvg}
        ${flashSvg}
      `;
    }

    timeOffset += Math.max(steps.length * stepDur, 8);
  }

  // HUD (fixed: right-aligned so it never clips)
  const hud = (() => {
    const { totalRecent, last7, last30 } = hudStats;

    // Use the *last step of the last run* for displayed score/lines
    const lastRun = runs[runs.length - 1] || [];
    const final = lastRun[lastRun.length - 1] || { score: 0, lines: 0 };

    const score = final.score ?? 0;
    const lines = final.lines ?? 0;

    const y = pad + wellH + 34;

    const leftX = pad + 12;
    const rightX = pad + wellW - 12;

    return `
      <g opacity="0.98">
        <rect x="${pad}" y="${y - 18}" width="${wellW}" height="28" rx="10"
              fill="#0f172a" stroke="#1f2a44" />

        <text x="${leftX}" y="${y}" fill="#e5e7eb"
              font-family="ui-sans-serif, system-ui" font-size="12" font-weight="800">
          SCORE: ${score}  •  LINES: ${lines}
        </text>

        <text x="${rightX}" y="${y}" fill="#93c5fd"
              font-family="ui-sans-serif, system-ui" font-size="12"
              text-anchor="end">
          Recent: ${totalRecent}  •  7d: ${last7}  •  30d: ${last30}
        </text>
      </g>
    `;
  })();

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${INTRINSIC_W}" height="${INTRINSIC_H}"
     viewBox="0 0 ${width} ${height}"
     preserveAspectRatio="xMidYMid meet">
  ${defs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>
  ${title}
  ${grid}
  ${frames}
  ${hud}
</svg>
`.trim();
}

// --------------------
// Main (10 runs, different piece sequences)
// --------------------
const days = await fetchContribDays();
const basePlan = deriveGamePlan(days);

const N_RUNS = 10;

// IMPORTANT (Option B):
// We change the seed per run AND rebuild a run-specific schedule using that seed,
// so piece TYPES + rotations + X positions differ per run (still contribution-driven).
const runs = [];
for (let i = 0; i < N_RUNS; i++) {
  const runSeed = (basePlan.seed + i * 10007) >>> 0;

  // rebuild schedule with runSeed included so the piece types differ per run
  const runPlan = {
    ...basePlan,
    seed: runSeed,
    schedule: basePlan.schedule.map((s, idx) => {
      const h = hashString(`${idx}:${s.piece}:${s.rot}:${s.ox}:${runSeed}`);
      return {
        piece: PIECE_ORDER[h % PIECE_ORDER.length],
        rot: (h >>> 8) % 4,
        ox: (h >>> 16) % (W - 3),
      };
    }),
  };

  runs.push(simulateGame(runPlan));
}

const svg = renderSvg(runs, basePlan);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/tetris.svg", svg, "utf-8");

// Extra safety: make sure it is valid XML/SVG-ish (no merge markers, etc.)
if (svg.includes("<<<<<<") || svg.includes("======") || svg.includes(">>>>>>")) {
  throw new Error("SVG contains merge markers!");
}

console.log("Wrote output/tetris.svg");
