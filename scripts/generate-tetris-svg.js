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
// Tetromino shapes
// --------------------
const PIECES = {
  I: [
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    [
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
    ],
    [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ],
    [
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ],
  ],
  O: [
    [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
  ],
  T: [
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
  ],
  S: [
    [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
    ],
    [
      [1, 1],
      [2, 1],
      [0, 2],
      [1, 2],
    ],
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
  ],
  Z: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
    [
      [2, 0],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    [
      [0, 1],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
    ],
  ],
  J: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [2, 0],
      [1, 1],
      [1, 2],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [2, 2],
    ],
    [
      [1, 0],
      [1, 1],
      [0, 2],
      [1, 2],
    ],
  ],
  L: [
    [
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 2],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
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
  const m = new Date(dateStr + "T00:00:00Z").getUTCMonth();
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m];
}
function monthIndex(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCMonth();
}

const MIN_WEEKS_BETWEEN_MONTH_LABELS = 4;

function buildHeatmap(weeks) {
  const W = Math.min(53, weeks.length);
  const slice = weeks.slice(-W);
  const H = 7;

  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => 0));
  const dates = Array.from({ length: H }, () => Array.from({ length: W }, () => null));

  const monthStarts = [];
  let lastMonth = null;
  let lastLabeledX = -999;

  const daysFlat = [];

  for (let x = 0; x < W; x++) {
    const days = slice[x].contributionDays;

    const refDate = days?.[0]?.date ?? null;
    if (refDate) {
      const mi = monthIndex(refDate);

      if (lastMonth === null) {
        lastMonth = mi;
        monthStarts.push({ x: 0, label: monthAbbrev(refDate) });
        lastLabeledX = 0;
      } else if (mi !== lastMonth) {
        lastMonth = mi;
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
function bucketLevel(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

// Neon-ish GitHub-like greens on dark
const LEVEL_COLOR = {
  0: "#0b1224",
  1: "#0e4429",
  2: "#006d32",
  3: "#26a641",
  4: "#39d353",
};

// --------------------
// SVG render: landscape heatmap + “pixel-perfect” tiling overlay
// Tetrominoes cover as much as possible; 1×1 fallback covers the rest.
// --------------------
function renderSvg({ grid, W, H, monthStarts, totalYear, last7, last30, seed }) {
  const cell = 12;
  const gap = 2;

  const leftLabelW = 34;
  const topLabelH = 22;
  const pad = 16;
  const hudH = 46;

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
  const stepDur = 0.18; // faster since tiling can create many placements
  const pieceDur = 0.55;
  const runDur = 10; // fixed run duration for stable looping
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

  // --- Month labels ---
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

  // --- Weekday labels ---
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

  // --- Renderer for a falling piece (supports color override for 1×1 fallback) ---
  function renderFallingPiece({ piece, shape, ox, fromY, toY, color }, begin) {
    const fillColor = color ?? PIECE_COLOR[piece] ?? "#ffffff";

    const x0 = gridX0 + ox * (cell + gap);
    const yStart = gridY0 + fromY * (cell + gap);
    const yEnd = gridY0 + toY * (cell + gap);

    let blocks = "";
    for (const [dx, dy] of shape) {
      const bx = x0 + dx * (cell + gap);
      const by = yStart + dy * (cell + gap);
      blocks += `
        <rect x="${bx}" y="${by}" width="${cell}" height="${cell}" rx="3"
              fill="${fillColor}" stroke="#0f172a" stroke-width="1"
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
                 begin="${begin}s;clock.repeatEvent+${begin}s"
                 fill="remove" />
        <animateTransform attributeName="transform" type="translate"
                          from="0 0" to="0 ${dyTrans}"
                          dur="${pieceDur}s"
                          begin="${begin}s;clock.repeatEvent+${begin}s"
                          fill="remove" />
        ${blocks}
      </g>
    `;
  }

  // --------------------
  // Pixel-perfect tiler (best-effort tetromino packing + 1×1 fallback)
  // NEVER places blocks on empty cells.
  // --------------------
  function makeMaskFromGrid() {
    return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => grid[y][x] > 0));
  }

  function canPlaceOnMask(mask, shape, ox, oy) {
    for (const [dx, dy] of shape) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      if (!mask[y][x]) return false;
    }
    return true;
  }

  function applyPlace(mask, shape, ox, oy) {
    for (const [dx, dy] of shape) {
      const x = ox + dx;
      const y = oy + dy;
      mask[y][x] = false;
    }
  }

  function chooseNextCell(mask, rng) {
    // Bottom-most first (gives a tetris-like build-up)
    for (let y = H - 1; y >= 0; y--) {
      const xs = [];
      for (let x = 0; x < W; x++) if (mask[y][x]) xs.push(x);
      if (xs.length) {
        return { x: xs[Math.floor(rng() * xs.length)], y };
      }
    }
    return null;
  }

  function placementScore(shape, ox, oy) {
    let s = 0;
    for (const [dx, dy] of shape) {
      s += bucketLevel(grid[oy + dy][ox + dx]);
    }
    return s;
  }

  function tileToPlacements(rng) {
    const mask = makeMaskFromGrid();
    const placements = [];

    // Greedy packing; if impossible for a cell, use 1×1 fallback.
    let safety = 0;
    while (safety++ < 4000) {
      const cell = chooseNextCell(mask, rng);
      if (!cell) break;

      const { x: cx, y: cy } = cell;

      let best = null;

      // Try all tetrominoes/rotations anchored on that cell
      for (const p of PIECE_ORDER) {
        for (let rot = 0; rot < 4; rot++) {
          const shape = PIECES[p][rot];

          for (const [dx, dy] of shape) {
            const ox = cx - dx;
            const oy = cy - dy;

            if (!canPlaceOnMask(mask, shape, ox, oy)) continue;

            const sc = placementScore(shape, ox, oy);
            if (!best || sc > best.score) {
              best = { piece: p, shape, ox, oy, score: sc };
            }
          }
        }
      }

      if (best) {
        applyPlace(mask, best.shape, best.ox, best.oy);
        placements.push(best);
      } else {
        // 1×1 fallback: cover this single contributed cell exactly
        const lvl = bucketLevel(grid[cy][cx]);
        applyPlace(mask, [[0, 0]], cx, cy);
        placements.push({
          piece: "P",
          shape: [[0, 0]],
          ox: cx,
          oy: cy,
          color: LEVEL_COLOR[lvl], // match GH green intensity
          score: lvl,
        });
      }
    }

    return placements;
  }

  // --- Build the overlay timeline ---
  let overlay = "";
  for (let r = 0; r < N_RUNS; r++) {
    const runSeed = (seed + r * 10007) >>> 0;
    const rng = mulberry32(runSeed);
    const baseT = r * runDur;

    const placements = tileToPlacements(rng);

    // Spread animations across the run duration
    const localStep = placements.length > 0 ? Math.min(stepDur, (runDur - 0.5) / placements.length) : stepDur;

    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i];
      const begin = baseT + i * localStep;

      overlay += renderFallingPiece(
        {
          piece: pl.piece,
          shape: pl.shape,
          ox: pl.ox,
          fromY: -6,
          toY: pl.oy,
          color: pl.color,
        },
        begin
      );
    }
  }

  // --- Legend + stats (GitHub-like) ---
  const legendY = gridY0 + wellH + 26;
  const legendXRight = gridX0 + wellW;

  const legendSquares = [0, 1, 2, 3, 4]
    .map((lvl, i) => {
      const x = legendXRight - (5 - i) * (cell + 4) + 10;
      return `<rect x="${x}" y="${legendY - 10}" width="${cell}" height="${cell}" rx="3"
                  fill="${LEVEL_COLOR[lvl]}" stroke="#0f172a" stroke-width="1" />`;
    })
    .join("\n");

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
