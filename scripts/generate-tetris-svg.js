// scripts/generate-tetris-svg.js
import fs from "fs";
import { Octokit } from "@octokit/rest";

const username = process.env.GITHUB_USERNAME;
const token = process.env.GITHUB_TOKEN;

if (!username) throw new Error("GITHUB_USERNAME missing");

const octokit = new Octokit({ auth: token });

// --------------------
// Fetch contribution weeks (keep week structure)
// --------------------
async function fetchContribWeeks() {
  const query = `
    query($login:String!) {
      user(login:$login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
                weekday
              }
            }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql(query, { login: username });
  return res.user.contributionsCollection.contributionCalendar.weeks;
}

// --------------------
// Deterministic hashing / RNG
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
// Tetromino shapes (same as before)
// --------------------
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

// --------------------
// Build an exact GitHub-like heatmap grid (last 52/53 weeks)
// --------------------
function monthAbbrev(dateStr) {
  const m = new Date(dateStr + "T00:00:00Z").getUTCMonth(); // 0-11
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m];
}
function monthIndex(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCMonth();
}

const MIN_WEEKS_BETWEEN_MONTH_LABELS = 4; // GH-like spacing

function buildHeatmap(weeks) {
  const W = Math.min(53, weeks.length);
  const slice = weeks.slice(-W);
  const H = 7;

  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => 0));
  const dates = Array.from({ length: H }, () => Array.from({ length: W }, () => null));

  // month label positions (x indices) like GitHub: label at the first week that contains a new month
   const monthStarts = []; // { x, label }
  let lastMonth = null;
  let lastLabeledX = -999;

  const daysFlat = [];

  for (let x = 0; x < W; x++) {
    const days = slice[x].contributionDays;

    // Find the month for this column (use the top day in the column as reference)
        const refDate = days?.[0]?.date ?? null;
    if (refDate) {
      const mi = monthIndex(refDate);

      if (lastMonth === null) {
        lastMonth = mi;
        monthStarts.push({ x: 0, label: monthAbbrev(refDate) });
        lastLabeledX = 0;
      } else if (mi !== lastMonth) {
        lastMonth = mi;

        // Only label if there's enough horizontal room since the last label
        if (x - lastLabeledX >= MIN_WEEKS_BETWEEN_MONTH_LABELS) {
          monthStarts.push({ x, label: monthAbbrev(refDate) });
          lastLabeledX = x;
        }
      }
    }
    for (let y = 0; y < H; y++) {
      const d = days?.[y];
      const c = d?.contributionCount ?? 0;
      const date = d?.date ?? null;

      grid[y][x] = c;
      dates[y][x] = date;

      daysFlat.push({ date, contributionCount: c });
    }
  }

  const totalYear = daysFlat.reduce((a, d) => a + (d.contributionCount ?? 0), 0);
  const last7 = daysFlat.slice(-7).reduce((a, d) => a + (d.contributionCount ?? 0), 0);
  const last30 = daysFlat.slice(-30).reduce((a, d) => a + (d.contributionCount ?? 0), 0);

  const seed = hashString(`${username}:${totalYear}:${daysFlat[0]?.date ?? ""}`);

  return { grid, dates, W, H, monthStarts, totalYear, last7, last30, seed };
}
// GitHub-like intensity buckets (0..4)
// You can tweak thresholds if you want it to “feel” closer to your profile.
function bucketLevel(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

// Neon-ish GitHub-like greens on dark
const LEVEL_COLOR = {
  0: "#0b1224", // empty tile
  1: "#0e4429",
  2: "#006d32",
  3: "#26a641",
  4: "#39d353",
};

// --------------------
// SVG render: landscape heatmap + tetromino overlay animation
// --------------------
function renderSvg({ grid, W, H, monthStarts, totalYear, last7, last30, seed }) {
  const cell = 12;
  const gap = 2;

  const leftLabelW = 34; // Mon/Wed/Fri
  const topLabelH = 22;  // month labels
  const pad = 16;
  const hudH = 46;       // legend + stats

  const wellW = W * (cell + gap) - gap;
  const wellH = H * (cell + gap) - gap;

  const width = pad * 2 + leftLabelW + wellW;
  const height = pad * 2 + topLabelH + wellH + hudH;

  const INTRINSIC_W = 900;
  const INTRINSIC_H = Math.round((height / width) * INTRINSIC_W);

  const gridX0 = pad + leftLabelW;
  const gridY0 = pad + topLabelH;

  // --- Timing: 10 runs loop ---
  const N_RUNS = 10;
  const piecesPerRun = 18;
  const stepDur = 0.55;
  const pieceDur = 0.85;
  const runDur = Math.max(piecesPerRun * stepDur + 1.0, 8);
  const totalDur = N_RUNS * runDur;

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

    <animate id="clock" attributeName="opacity"
             values="1;1" dur="${totalDur}s" repeatCount="indefinite" />
  </defs>
  `;

  // --- Month labels (filtered spacing already handled in buildHeatmap) ---
  let monthLabels = "";
  for (const m of monthStarts) {
    const x = gridX0 + m.x * (cell + gap);
    monthLabels += `
      <text x="${x}" y="${pad + 14}"
            fill="#9ca3af"
            font-family="ui-sans-serif, system-ui"
            font-size="11">
        ${m.label}
      </text>
    `;
  }

  // --- Weekday labels like GitHub: Mon/Wed/Fri on left ---
  const dayLabel = (label, row) => {
    const y = gridY0 + row * (cell + gap) + cell - 2;
    return `
      <text x="${pad + leftLabelW - 6}" y="${y}"
            fill="#9ca3af"
            font-family="ui-sans-serif, system-ui"
            font-size="11"
            text-anchor="end">
        ${label}
      </text>
    `;
  };
  const weekdayLabels = `
    ${dayLabel("Mon", 1)}
    ${dayLabel("Wed", 3)}
    ${dayLabel("Fri", 5)}
  `;

  // --- Heatmap truth layer ---
  let heat = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = gridX0 + x * (cell + gap);
      const py = gridY0 + y * (cell + gap);

      const lvl = bucketLevel(grid[y][x]);
      const fill = LEVEL_COLOR[lvl];

      heat += `
        <rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="3"
              fill="${fill}" stroke="#0f172a" stroke-width="1" />
      `;
    }
  }

  // --- Tetromino overlay animation ---
  function renderFallingPiece({ piece, shape, ox, fromY, toY }, begin) {
    const color = PIECE_COLOR[piece];

    const x0 = gridX0 + ox * (cell + gap);
    const yStart = gridY0 + fromY * (cell + gap);
    const yEnd = gridY0 + toY * (cell + gap);

    let blocks = "";
    for (const [dx, dy] of shape) {
      const bx = x0 + dx * (cell + gap);
      const by = yStart + dy * (cell + gap);
      blocks += `
        <rect x="${bx}" y="${by}" width="${cell}" height="${cell}" rx="3"
              fill="${color}" stroke="#0f172a" stroke-width="1"
              filter="url(#neonGlow)" opacity="0.95" />
      `;
    }

    const dyTrans = (yEnd - yStart).toFixed(2);

    return `
      <g opacity="0">
        <animate attributeName="opacity"
                 values="0;1;1;0"
                 keyTimes="0;0.05;0.95;1"
                 dur="${pieceDur}s"
                 begin="clock.begin+${begin}s"
                 fill="remove" />
        <animateTransform attributeName="transform" type="translate"
                          from="0 0" to="0 ${dyTrans}"
                          dur="${pieceDur}s"
                          begin="clock.begin+${begin}s"
                          fill="remove" />
        ${blocks}
      </g>
    `;
  }

  let overlay = "";
  for (let r = 0; r < N_RUNS; r++) {
    const runSeed = (seed + r * 10007) >>> 0;
    const rng = mulberry32(runSeed);
    const baseT = r * runDur;

    for (let i = 0; i < piecesPerRun; i++) {
      const piece = PIECE_ORDER[Math.floor(rng() * PIECE_ORDER.length)];
      const rot = Math.floor(rng() * 4);
      const shape = PIECES[piece][rot];

      const ox = clamp(Math.floor(rng() * (W - 3)), 0, Math.max(0, W - 4));
      const fromY = -4;
      const toY = clamp(H - 4 + Math.floor(rng() * 3), 0, Math.max(0, H - 1));

      const begin = baseT + i * stepDur;
      overlay += renderFallingPiece({ piece, shape, ox, fromY, toY }, begin);
    }
  }

  // --- Legend + stats (GitHub-like) ---
  const legendY = gridY0 + wellH + 26;
  const legendXRight = gridX0 + wellW;

  const legendSquares = [0, 1, 2, 3, 4].map((lvl, i) => {
    const x = legendXRight - (5 - i) * (cell + 4) + 10;
    return `<rect x="${x}" y="${legendY - 10}" width="${cell}" height="${cell}" rx="3"
                  fill="${LEVEL_COLOR[lvl]}" stroke="#0f172a" stroke-width="1" />`;
  }).join("\n");

  const stats = `
    <text x="${gridX0}" y="${legendY + 2}"
          fill="#e5e7eb"
          font-family="ui-sans-serif, system-ui"
          font-size="11">
      ${totalYear} contributions in the last year • 7d: ${last7} • 30d: ${last30}
    </text>
  `;

  const legend = `
    <text x="${legendXRight - 5 * (cell + 4) - 2}" y="${legendY + 2}"
          fill="#9ca3af" font-family="ui-sans-serif, system-ui" font-size="11"
          text-anchor="end">
      Less
    </text>
    ${legendSquares}
    <text x="${legendXRight + 2}" y="${legendY + 2}"
          fill="#9ca3af" font-family="ui-sans-serif, system-ui" font-size="11">
      More
    </text>
  `;

  // --- Final SVG ---
  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${INTRINSIC_W}" height="${INTRINSIC_H}"
     viewBox="0 0 ${width} ${height}"
     preserveAspectRatio="xMidYMid meet">
  ${defs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>

  ${monthLabels}
  ${weekdayLabels}

  ${heat}
  ${overlay}

  ${stats}
  ${legend}
</svg>
`.trim();
}

  // Animated tetromino overlay (visual flair, 10 deterministic variations)
  function renderFallingPiece({ piece, shape, ox, fromY, toY }, begin) {
    const color = PIECE_COLOR[piece];

    const x0 = pad + ox * (cell + gap);
    const yStart = gridTop + fromY * (cell + gap);
    const yEnd = gridTop + toY * (cell + gap);

    let blocks = "";
    for (const [dx, dy] of shape) {
      const bx = x0 + dx * (cell + gap);
      const by = yStart + dy * (cell + gap);
      blocks += `
        <rect x="${bx}" y="${by}" width="${cell}" height="${cell}" rx="3"
              fill="${color}" stroke="#0f172a" stroke-width="1"
              filter="url(#neonGlow)" opacity="0.95" />
      `;
    }

    const dyTrans = (yEnd - yStart).toFixed(2);

    return `
      <g opacity="0">
        <animate attributeName="opacity"
                 values="0;1;1;0"
                 keyTimes="0;0.05;0.95;1"
                 dur="${pieceDur}s"
                 begin="clock.begin+${begin}s"
                 fill="remove" />
        <animateTransform attributeName="transform" type="translate"
                          from="0 0" to="0 ${dyTrans}"
                          dur="${pieceDur}s"
                          begin="clock.begin+${begin}s"
                          fill="remove" />
        ${blocks}
      </g>
    `;
  }

  // Build the overlay timeline
  let overlay = "";
  for (let r = 0; r < N_RUNS; r++) {
    const runSeed = (seed + r * 10007) >>> 0;
    const rng = mulberry32(runSeed);

    const baseT = r * runDur;

    for (let i = 0; i < piecesPerRun; i++) {
      // Piece choice changes each run (Option B)
      const piece = PIECE_ORDER[Math.floor(rng() * PIECE_ORDER.length)];
      const rot = Math.floor(rng() * 4);
      const shape = PIECES[piece][rot];

      // Choose an x that stays in bounds for 4-wide shapes
      const ox = clamp(Math.floor(rng() * (W - 3)), 0, Math.max(0, W - 4));

      // Small grid height: land near bottom-ish, but vary a bit
      const fromY = -4;
      const toY = clamp(H - 4 + Math.floor(rng() * 3), 0, Math.max(0, H - 1)); // ~bottom region

      const begin = baseT + i * stepDur;
      overlay += renderFallingPiece({ piece, shape, ox, fromY, toY }, begin);
    }
  

  // HUD (always on top, no overlap)
  const hudY = gridTop + wellH + 26;
  const hud = `
    <g opacity="0.98">
      <rect x="${pad}" y="${hudY - 18}" width="${wellW}" height="28" rx="10"
            fill="#0f172a" stroke="#1f2a44" />
      <text x="${pad + 12}" y="${hudY}" fill="#e5e7eb"
            font-family="ui-sans-serif, system-ui" font-size="12" font-weight="800">
        Year: ${totalYear}
      </text>
      <text x="${pad + wellW - 12}" y="${hudY}" fill="#93c5fd"
            font-family="ui-sans-serif, system-ui" font-size="12"
            text-anchor="end">
        7d: ${last7}  •  30d: ${last30}  •  Weeks: ${W}
      </text>
    </g>
  `;

  // IMPORTANT z-order:
  // background -> heatmap truth -> animated overlay -> title/hud on top
  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${INTRINSIC_W}" height="${INTRINSIC_H}"
     viewBox="0 0 ${width} ${height}"
     preserveAspectRatio="xMidYMid meet">
  ${defs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>

  ${heat}
  ${overlay}

  ${title}
  ${hud}
</svg>
`.trim();
}

// --------------------
// Main
// --------------------
const weeks = await fetchContribWeeks();
const heatmap = buildHeatmap(weeks);
const svg = renderSvg(heatmap);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/tetris.svg", svg, "utf-8");

if (svg.includes("<<<<<<<") || svg.includes("=======") || svg.includes(">>>>>>>")) {
  throw new Error("SVG contains merge markers!");
}

console.log("Wrote output/tetris.svg");
