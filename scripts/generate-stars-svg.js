import fs from "fs";
import { Octokit } from "@octokit/rest";

const username = process.env.GITHUB_USERNAME;
const token = process.env.GITHUB_TOKEN;
if (!username) throw new Error("GITHUB_USERNAME missing");
const octokit = new Octokit({ auth: token });

async function fetchContribWeeks() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(to.getUTCFullYear() - 1);
  const query = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays { date contributionCount weekday }
            }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql(query, {
    login: username,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return res.user.contributionsCollection.contributionCalendar.weeks;
}

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

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function monthAbbrev(d) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][
    new Date(d + "T00:00:00Z").getUTCMonth()
  ];
}
function monthIndex(d) { return new Date(d + "T00:00:00Z").getUTCMonth(); }

function buildHeatmap(weeks) {
  const W = Math.min(53, weeks.length);
  const slice = weeks.slice(-W);
  const H = 7;
  const grid  = Array.from({ length: H }, () => Array(W).fill(0));
  const monthStarts = [];
  let lastMonth = null, lastLabeledX = -999;
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
        if (x - lastLabeledX >= 4) {
          monthStarts.push({ x, label: monthAbbrev(refDate) });
          lastLabeledX = x;
        }
      }
    }
    for (let y = 0; y < H; y++) {
      const d = days?.[y];
      grid[y][x] = d?.contributionCount ?? 0;
      daysFlat.push({ contributionCount: d?.contributionCount ?? 0 });
    }
  }

  const totalYear = daysFlat.reduce((a, d) => a + d.contributionCount, 0);
  const last7  = daysFlat.slice(-7).reduce((a, d) => a + d.contributionCount, 0);
  const last30 = daysFlat.slice(-30).reduce((a, d) => a + d.contributionCount, 0);
  const seed = hashString(`${username}:${totalYear}:${daysFlat[0]?.contributionCount ?? 0}`);
  return { grid, W, H, monthStarts, totalYear, last7, last30, seed };
}

function bucketLevel(c) {
  if (c <= 0) return 0;
  if (c <= 2) return 1;
  if (c <= 5) return 2;
  if (c <= 9) return 3;
  return 4;
}

// Star visual config per level
const STAR_COLOR   = ["none", "#3d6e9e", "#7ab3e0", "#c0dbf5", "#ffffff"];
const STAR_RADIUS  = [0, 1.6, 2.2, 3.0, 4.0];
const STAR_OPACITY = [0, 0.55, 0.72, 0.88, 1.0];
const STAR_FILTER  = ["", "", "url(#glow1)", "url(#glow2)", "url(#glow3)"];

function renderSvg({ grid, W, H, monthStarts, totalYear, last7, last30, seed }) {
  const cell = 12, gap = 2;
  const leftLabelW = 34, topLabelH = 22, pad = 16, hudH = 46;
  const wellW = W * (cell + gap) - gap;
  const wellH = H * (cell + gap) - gap;
  const width  = pad * 2 + leftLabelW + wellW;
  const height = pad * 2 + topLabelH + wellH + hudH;
  const INTRINSIC_W = 900;
  const INTRINSIC_H = Math.round((height / width) * INTRINSIC_W);
  const gridX0 = pad + leftLabelW;
  const gridY0 = pad + topLabelH;

  // Timing constants
  const STAGGER    = 0.045;  // seconds between successive star appearances
  const APPEAR_DUR = 0.55;   // twinkle-in duration
  const POST_BUILD = 2.0;    // pause after sky is full
  const FLASH_DUR  = 1.8;    // two-flash window
  const RESET_FADE = 0.6;

  // Shuffle non-zero cells
  const rng = mulberry32(seed);
  const cells = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (grid[y][x] > 0) cells.push({ x, y });
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  const buildEnd    = cells.length * STAGGER + APPEAR_DUR;
  const finishStart = buildEnd + POST_BUILD;
  const finishEnd   = finishStart + FLASH_DUR;
  const cycleDur    = finishEnd + RESET_FADE;

  // Build appear-time lookup
  const appearAt = Array.from({ length: H }, () => Array(W).fill(null));
  cells.forEach(({ x, y }, k) => { appearAt[y][x] = k * STAGGER; });

  const defs = `
  <defs>
    <radialGradient id="skyBg" cx="50%" cy="25%" r="75%">
      <stop offset="0%"   stop-color="#0d1929"/>
      <stop offset="100%" stop-color="#020408"/>
    </radialGradient>
    <filter id="glow1" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="1.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glow2" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="2.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glow3" x="-150%" y="-150%" width="400%" height="400%">
      <feGaussianBlur stdDeviation="4.0" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  // Month labels
  let monthLabels = "";
  for (const m of monthStarts) {
    const x = gridX0 + m.x * (cell + gap);
    monthLabels += `<text x="${x}" y="${pad + 14}" fill="#3a5570"
      font-family="ui-sans-serif,system-ui" font-size="11">${m.label}</text>\n`;
  }

  // Weekday labels
  const dayLabel = (label, row) => {
    const y = gridY0 + row * (cell + gap) + cell - 2;
    return `<text x="${pad + leftLabelW - 6}" y="${y}" fill="#3a5570"
      font-family="ui-sans-serif,system-ui" font-size="11" text-anchor="end">${label}</text>\n`;
  };
  const weekdayLabels = dayLabel("Mon", 1) + dayLabel("Wed", 3) + dayLabel("Fri", 5);

  // Stars
  let stars = "";
  const tDisappear = finishEnd;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const lvl = bucketLevel(grid[y][x]);
      const cx  = gridX0 + x * (cell + gap) + cell / 2;
      const cy  = gridY0 + y * (cell + gap) + cell / 2;

      if (lvl === 0) {
        // Faint ambient dot for sky texture — always visible
        stars += `<circle cx="${cx}" cy="${cy}" r="0.55" fill="#1c2e45" opacity="0.6"/>\n`;
        continue;
      }

      const r      = STAR_RADIUS[lvl];
      const color  = STAR_COLOR[lvl];
      const maxOp  = STAR_OPACITY[lvl];
      const filter = STAR_FILTER[lvl];
      const tA     = appearAt[y][x] ?? 0;

      // keyTimes: 0 → tA(dark) → tA+flare → tA+settle → tDisappear(hold) → fade → 1(dark)
      const eps = 0.0005;
      const k0  = 0;
      const k1  = clamp(tA / cycleDur, eps, 1);
      const k2  = clamp((tA + APPEAR_DUR * 0.25) / cycleDur, k1 + eps, 1);
      const k3  = clamp((tA + APPEAR_DUR) / cycleDur, k2 + eps, 1);
      const k4  = clamp(tDisappear / cycleDur, k3 + eps, 1);
      const k5  = clamp((tDisappear + RESET_FADE * 0.7) / cycleDur, k4 + eps, 1);

      const flashOp = Math.min(maxOp * 1.5, 1).toFixed(3);
      const opVals  = `0;0;${flashOp};${maxOp};${maxOp};0;0`;
      const ktimes  = `${k0};${k1};${k2};${k3};${k4};${k5};1`;

      const anim = `<animate attributeName="opacity" begin="0s"
        dur="${cycleDur.toFixed(3)}s" repeatCount="indefinite"
        values="${opVals}" keyTimes="${ktimes}" fill="remove"/>`;

      stars += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" ${filter ? `filter="${filter}"` : ""} opacity="0">${anim}</circle>\n`;

      // Cross spikes for level-4 stars
      if (lvl === 4) {
        const spike = r * 2.4;
        const spikeAnim = `<animate attributeName="opacity" begin="0s"
          dur="${cycleDur.toFixed(3)}s" repeatCount="indefinite"
          values="0;0;0.7;0.35;0.35;0;0" keyTimes="${ktimes}" fill="remove"/>`;
        stars += `<line x1="${cx}" y1="${(cy - spike).toFixed(1)}" x2="${cx}" y2="${(cy + spike).toFixed(1)}"
          stroke="${color}" stroke-width="0.45" opacity="0">${spikeAnim}</line>\n`;
        stars += `<line x1="${(cx - spike).toFixed(1)}" y1="${cy}" x2="${(cx + spike).toFixed(1)}" y2="${cy}"
          stroke="${color}" stroke-width="0.45" opacity="0">${spikeAnim}</line>\n`;
      }
    }
  }

  // Comets — random streaks during the build/hold phase
  const N_COMETS = 5;
  const cometRng = mulberry32((seed + 99991) >>> 0);
  let comets = "";

  for (let c = 0; c < N_COMETS; c++) {
    // Random start time spread across build + hold, avoiding last 2s before flash
    const tStart = 1.5 + cometRng() * Math.max(1, buildEnd + POST_BUILD - 3.5);
    const dur    = 0.7 + cometRng() * 0.6;  // 0.7–1.3s

    // Entry from top edge or right edge; exit to bottom-right area
    const fromTop = cometRng() > 0.35;
    let sx, sy, ex, ey;
    if (fromTop) {
      sx = gridX0 + cometRng() * wellW * 0.8;
      sy = gridY0 - 12;
      ex = sx + (60 + cometRng() * 100);
      ey = gridY0 + wellH * (0.3 + cometRng() * 0.6);
    } else {
      sx = gridX0 + wellW + 10;
      sy = gridY0 + cometRng() * wellH * 0.5;
      ex = sx - (80 + cometRng() * 120);
      ey = sy + (30 + cometRng() * 60);
    }

    // Tail direction (opposite of travel vector)
    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    const tailLen = 28 + cometRng() * 18;
    const tx = (-dx / len * tailLen).toFixed(1);
    const ty = (-dy / len * tailLen).toFixed(1);

    // keyTimes relative to cycleDur
    const eps = 0.0005;
    const k0 = clamp(tStart / cycleDur, eps, 0.999);
    const k1 = clamp((tStart + 0.12) / cycleDur, k0 + eps, 0.999);
    const k2 = clamp((tStart + dur - 0.15) / cycleDur, k1 + eps, 0.999);
    const k3 = clamp((tStart + dur) / cycleDur, k2 + eps, 0.999);

    comets += `
    <g opacity="0">
      <line x1="${tx}" y1="${ty}" x2="0" y2="0"
            stroke="#ddeeff" stroke-width="1.1" stroke-linecap="round"
            filter="url(#glow1)" opacity="0.55"/>
      <circle cx="0" cy="0" r="1.6" fill="#ffffff" filter="url(#glow2)"/>
      <animate attributeName="opacity" begin="0s"
        dur="${cycleDur.toFixed(3)}s" repeatCount="indefinite"
        values="0;0;1;1;0;0"
        keyTimes="0;${k0};${k1};${k2};${k3};1" fill="remove"/>
      <animateTransform attributeName="transform" type="translate" begin="0s"
        dur="${cycleDur.toFixed(3)}s" repeatCount="indefinite"
        values="${sx.toFixed(1)},${sy.toFixed(1)};${sx.toFixed(1)},${sy.toFixed(1)};${ex.toFixed(1)},${ey.toFixed(1)};${ex.toFixed(1)},${ey.toFixed(1)}"
        keyTimes="0;${k0};${k3};1" fill="remove"/>
    </g>`;
  }

  // Two-flash overlay after sky is full
  const f0 = clamp(finishStart / cycleDur, 0, 1);
  const f1 = clamp((finishStart + FLASH_DUR * 0.18) / cycleDur, 0, 1);
  const f2 = clamp((finishStart + FLASH_DUR * 0.32) / cycleDur, 0, 1);
  const f3 = clamp((finishStart + FLASH_DUR * 0.50) / cycleDur, 0, 1);
  const f4 = clamp((finishStart + FLASH_DUR * 0.68) / cycleDur, 0, 1);
  const f5 = clamp((finishStart + FLASH_DUR * 0.82) / cycleDur, 0, 1);
  const f6 = clamp(finishEnd / cycleDur, 0, 1);

  const flash = `<rect x="${gridX0}" y="${gridY0}" width="${wellW}" height="${wellH}" rx="6"
    fill="#c8e0ff" opacity="0">
    <animate attributeName="opacity" begin="0s"
      dur="${cycleDur.toFixed(3)}s" repeatCount="indefinite"
      values="0;0;0.22;0;0.22;0;0;0"
      keyTimes="0;${f0};${f1};${f2};${f3};${f4};${f6};1"
      fill="remove"/>
  </rect>`;

  // HUD
  const legendY = gridY0 + wellH + 26;
  const legendXRight = gridX0 + wellW;
  const legendCircles = [1, 2, 3, 4].map((lvl, i) => {
    const lx = legendXRight - (4 - i) * 22 + 8;
    return `<circle cx="${lx}" cy="${legendY - 4}" r="${STAR_RADIUS[lvl]}"
      fill="${STAR_COLOR[lvl]}" opacity="${STAR_OPACITY[lvl]}" ${STAR_FILTER[lvl] ? `filter="${STAR_FILTER[lvl]}"` : ""}/>`;
  }).join("\n");

  const stats = `<text x="${gridX0}" y="${legendY + 2}" fill="#4a6a8a"
    font-family="ui-sans-serif,system-ui" font-size="11">
    ${totalYear} contributions in the last year • 7d: ${last7} • 30d: ${last30}
  </text>`;

  const legend = `
    <text x="${legendXRight - 4 * 22 - 4}" y="${legendY + 2}"
      fill="#3a5570" font-family="ui-sans-serif,system-ui" font-size="11" text-anchor="end">Dim</text>
    ${legendCircles}
    <text x="${legendXRight + 2}" y="${legendY + 2}"
      fill="#3a5570" font-family="ui-sans-serif,system-ui" font-size="11">Bright</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg"
     width="${INTRINSIC_W}" height="${INTRINSIC_H}"
     viewBox="0 0 ${width} ${height}"
     preserveAspectRatio="xMidYMid meet">
  ${defs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#skyBg)"/>
  ${monthLabels}
  ${weekdayLabels}
  ${stars}
  ${comets}
  ${flash}
  ${stats}
  ${legend}
</svg>`.trim();
}

const weeks = await fetchContribWeeks();
const heatmap = buildHeatmap(weeks);
const svg = renderSvg(heatmap);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/tetris.svg", svg, "utf-8");
if (svg.includes("<<<<<<<") || svg.includes(">>>>>>>")) throw new Error("SVG has merge markers");
console.log("Wrote output/tetris.svg");
