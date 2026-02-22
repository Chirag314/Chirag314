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
// Build an exact GitHub-like heatmap grid (last 52/53 weeks)
// --------------------
function monthAbbrev(dateStr) {
  const m = new Date(dateStr + "T00:00:00Z").getUTCMonth(); // 0-11
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m];
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

  // Seed changes gradually with your year total + first visible date
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

// GitHub-like greens on dark
const LEVEL_COLOR = {
  0: "#0b1224",
  1: "#0e4429",
  2: "#006d32",
  3: "#26a641",
  4: "#39d353",
};

// --------------------
// SVG render: blank -> build rows bottom-to-top -> flash -> reset -> loop
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

  // --- Timing model (per cycle) ---
  // “One line at a time”: we treat each weekday row as a line, building bottom -> top.
  // Within a line, we drop only on cells that are >0 (contributed).
  const ROW_DUR = 0.75;        // seconds per row
  const STAGGER = 0.02;        // spacing between blocks within the row
  const FALL_DUR = 0.55;       // fall time for each 1×1 block
  const FINISH_FLASH = 2.0;    // hold/flash at the end
  const RESET_FADE = 0.35;     // fade out to blank

  const buildStart = 0.0;
  const buildEnd = buildStart + H * ROW_DUR;
  const finishStart = buildEnd + 0.2;
  const finishEnd = finishStart + FINISH_FLASH;
  const cycleDur = finishEnd + RESET_FADE;

  // RNG used only to randomize order of blocks within a row (still deterministic per day)
  const rng = mulberry32(seed);

  const defs = `
  <defs>
    <filter id="neonGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="1.6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#070a14"/>
      <stop offset="100%" stop-color="#0b1020"/>
    </linearGradient>

    <!-- Master clock: entire animation loop -->
    <animate id="clock" attributeName="opacity"
             values="1;1" dur="${cycleDur}s" repeatCount="indefinite" />
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

  // --- Base empty grid (always visible) ---
  let baseGrid = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = gridX0 + x * (cell + gap);
      const py = gridY0 + y * (cell + gap);
      baseGrid += `
        <rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="3"
              fill="${LEVEL_COLOR[0]}" stroke="#0f172a" stroke-width="1" />
      `;
    }
  }

  // --- Helper: animated opacity for a contributed tile (blank -> appear -> hold -> disappear) ---
  function tileOpacityAnim(tAppear, tDisappear) {
    const eps = 0.001;
    const a0 = 0;
    const a1 = clamp(tAppear / cycleDur, 0, 1);
    const a2 = clamp((tAppear + eps) / cycleDur, 0, 1);
    const d = clamp(tDisappear / cycleDur, 0, 1);

    // values: 0 until appear, jump to 1, stay 1, then go to 0 by end
    return `
      <animate attributeName="opacity"
               begin="0s;clock.repeatEvent"
               dur="${cycleDur}s"
               values="0;0;1;1;0"
               keyTimes="${a0};${a1};${a2};${d};1"
               fill="remove" />
    `.trim();
  }

  // --- Contributed tiles layer (starts blank; tiles appear when their blocks land) ---
  // We schedule an appearance time per cell according to “row build” logic below.
  const appearTime = Array.from({ length: H }, () => Array.from({ length: W }, () => null));

  // build order: bottom row (H-1) to top row (0)
  for (let y = H - 1; y >= 0; y--) {
    const rowIndex = (H - 1) - y;       // 0..H-1
    const rowStart = buildStart + rowIndex * ROW_DUR;

    // collect contributed cells in this row
    const xs = [];
    for (let x = 0; x < W; x++) {
      if (grid[y][x] > 0) xs.push(x);
    }

    // deterministic shuffle so it looks “alive” but stable per day
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }

    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      const tFall = rowStart + k * STAGGER;
      const tLand = tFall + FALL_DUR;
      appearTime[y][x] = tLand;
    }
  }

  let contribTiles = "";
  const tDisappear = finishEnd; // after flash/hold, fade to blank
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (grid[y][x] <= 0) continue;

      const px = gridX0 + x * (cell + gap);
      const py = gridY0 + y * (cell + gap);

      const lvl = bucketLevel(grid[y][x]);
      const fill = LEVEL_COLOR[lvl];

      const tAppear = appearTime[y][x] ?? buildEnd; // fallback
      contribTiles += `
        <rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="3"
              fill="${fill}" stroke="#0f172a" stroke-width="1"
              opacity="0">
          ${tileOpacityAnim(tAppear, tDisappear)}
        </rect>
      `;
    }
  }

  // --- Falling blocks overlay (1×1 “drops” landing exactly on contributed tiles) ---
  function fallingBlock({ x, y, fill, begin }) {
    const px = gridX0 + x * (cell + gap);
    const pyEnd = gridY0 + y * (cell + gap);

    // start above the grid
    const yStart = gridY0 - 7 * (cell + gap);
    const dyTrans = (pyEnd - yStart).toFixed(2);

    // Draw the rect at start position and translate down
    return `
      <g opacity="0">
        <animate attributeName="opacity"
                 begin="${begin}s;clock.repeatEvent+${begin}s"
                 dur="${FALL_DUR}s"
                 values="0;1;1;0"
                 keyTimes="0;0.02;0.95;1"
                 fill="remove" />
        <animateTransform attributeName="transform" type="translate"
                          begin="${begin}s;clock.repeatEvent+${begin}s"
                          dur="${FALL_DUR}s"
                          from="0 0" to="0 ${dyTrans}"
                          fill="remove" />
        <rect x="${px}" y="${yStart}" width="${cell}" height="${cell}" rx="3"
              fill="${fill}" stroke="#0f172a" stroke-width="1"
              filter="url(#neonGlow)" opacity="0.98" />
      </g>
    `.trim();
  }

  let drops = "";
  for (let y = H - 1; y >= 0; y--) {
    const rowIndex = (H - 1) - y;
    const rowStart = buildStart + rowIndex * ROW_DUR;

    const xs = [];
    for (let x = 0; x < W; x++) if (grid[y][x] > 0) xs.push(x);

    // same deterministic shuffle as above (must match, so we re-shuffle with same rng state?).
    // To keep it simple + stable, we compute order again using a per-row seeded rng:
    const rowSeed = (seed + (y + 1) * 10007) >>> 0;
    const rr = mulberry32(rowSeed);
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rr() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }

    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      const lvl = bucketLevel(grid[y][x]);
      const fill = LEVEL_COLOR[lvl];
      const tFall = rowStart + k * STAGGER;

      drops += "\n" + fallingBlock({ x, y, fill, begin: tFall });
    }
  }

  // --- Finish flash (2 seconds) ---
  // A soft white overlay over the heatmap area to indicate “complete”.
  const flash = `
    <rect x="${gridX0}" y="${gridY0}" width="${wellW}" height="${wellH}" rx="10"
          fill="#ffffff" opacity="0">
      <animate attributeName="opacity"
               begin="${finishStart}s;clock.repeatEvent+${finishStart}s"
               dur="${FINISH_FLASH}s"
               values="0;0.18;0.28;0.18;0"
               keyTimes="0;0.15;0.5;0.85;1"
               fill="remove" />
    </rect>
  `;

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

  ${baseGrid}
  ${contribTiles}
  ${drops}
  ${flash}

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
