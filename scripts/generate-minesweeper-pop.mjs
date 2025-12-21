import * as fs from "node:fs";
import * as path from "node:path";

const USERNAME = process.env.USERNAME || "Chirag314";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN env var.");
  process.exit(1);
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "minesweeper-pop-generator",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("GraphQL error:", JSON.stringify(json.errors || json, null, 2));
    process.exit(1);
  }
  return json.data;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function colorFor(count) {
  // GitHub-like intensity buckets (dark theme colors)
  if (count <= 0) return "#161b22";
  if (count < 3) return "#0e4429";
  if (count < 7) return "#006d32";
  if (count < 15) return "#26a641";
  return "#39d353";
}

function buildAnimatedSVG(grid, opts) {
  const {
    padding = 12,
    cell = 11,
    gap = 2,
    bg = "#0d1117",
    border = "#30363d",
    text = "#c9d1d9",
    sparkA = "#22c55e",
    sparkB = "#60a5fa",
    sparkC = "#a78bfa",
  } = opts;

  const cols = grid[0].length;
  const rows = grid.length;

  const gridW = cols * (cell + gap) - gap;
  const gridH = rows * (cell + gap) - gap;

  const viewW = gridW + padding * 2;
  const viewH = gridH + padding * 2 + 22;

  // Visit order: snakey column scan (minesweeper sweep vibe)
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) order.push([c, r]);
    else for (let r = rows - 1; r >= 0; r--) order.push([c, r]);
  }

  const totalSteps = order.length;
  const dur = clamp(Math.round(totalSteps / 18), 6, 16);
  const stepDur = dur / totalSteps;

  const cursorXValues = order.map(([c]) => (padding + c * (cell + gap) + cell / 2)).join(";");
  const cursorYValues = order.map(([,r]) => (padding + r * (cell + gap) + cell / 2)).join(";");

  const rects = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = padding + c * (cell + gap);
      const py = padding + r * (cell + gap);
      const fill = grid[r][c];
      rects.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}" />`);
    }
  }

  const popsEvery = 8;
  const popCells = order.filter((_, i) => i % popsEvery === 0);

  const pops = popCells.map(([c, r], idx) => {
    const t = (idx * popsEvery) * stepDur;
    const x = padding + c * (cell + gap) + cell / 2;
    const y = padding + r * (cell + gap) + cell / 2;

    return `
      <g opacity="0">
        <animate attributeName="opacity" values="0;1;0" dur="0.55s" begin="${t.toFixed(3)}s" />
        <circle cx="${x}" cy="${y}" r="0">
          <animate attributeName="r" values="0;5;0" dur="0.55s" begin="${t.toFixed(3)}s" />
          <animate attributeName="fill" values="${sparkA};${sparkB};${sparkC}" dur="0.55s" begin="${t.toFixed(3)}s" />
        </circle>
        <circle cx="${x}" cy="${y}" r="0" fill="${sparkB}" opacity="0.9">
          <animate attributeName="r" values="0;2.2;0" dur="0.55s" begin="${t.toFixed(3)}s" />
        </circle>
        ${[0,60,120,180,240,300].map(deg => {
          const rad = (deg * Math.PI) / 180;
          const x2 = x + Math.cos(rad) * 7;
          const y2 = y + Math.sin(rad) * 7;
          return `<line x1="${x}" y1="${y}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${sparkC}" stroke-width="1">
            <animate attributeName="stroke-opacity" values="0;1;0" dur="0.55s" begin="${t.toFixed(3)}s" />
          </line>`;
        }).join("")}
      </g>
    `;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${viewW}" height="${viewH}" viewBox="0 0 ${viewW} ${viewH}">
  <defs>
    <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect x="0" y="0" width="${viewW}" height="${viewH}" rx="12" fill="${bg}" stroke="${border}" />

  <text x="${padding}" y="${viewH - 10}" fill="${text}" font-size="12"
        font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto">
    Minesweeper-style sweep (spark pops)
  </text>

  <g>${rects.join("\n")}</g>

  <g filter="url(#softGlow)">
    <circle r="4" fill="${sparkB}">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" values="${cursorXValues}" calcMode="discrete" />
      <animate attributeName="cy" dur="${dur}s" repeatCount="indefinite" values="${cursorYValues}" calcMode="discrete" />
    </circle>
    <circle r="9" fill="${sparkB}" opacity="0.15">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" values="${cursorXValues}" calcMode="discrete" />
      <animate attributeName="cy" dur="${dur}s" repeatCount="indefinite" values="${cursorYValues}" calcMode="discrete" />
      <animate attributeName="r" values="7;10;7" dur="1.2s" repeatCount="indefinite" />
    </circle>
  </g>

  <g filter="url(#softGlow)">${pops}</g>
</svg>`;
}

async function main() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { login: USERNAME });
  const weeks = data.user.contributionsCollection.contributionCalendar.weeks;

  // Convert weeks->days into rows (7) x cols (weeks)
  const cols = weeks.length;
  const rows = 7;

  const grid = Array.from({ length: rows }, () => Array(cols).fill("#161b22"));
  for (let c = 0; c < cols; c++) {
    const days = weeks[c].contributionDays; // length 7
    for (let r = 0; r < rows; r++) {
      grid[r][c] = colorFor(days[r]?.contributionCount ?? 0);
    }
  }

  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const dark = buildAnimatedSVG(grid, {
    bg: "#0d1117", border: "#30363d", text: "#c9d1d9",
    sparkA: "#22c55e", sparkB: "#60a5fa", sparkC: "#a78bfa"
  });

  // Light version colors
  const lightGrid = grid.map(row => row.map(hex => {
    // Map dark greens to lighter palette
    return hex === "#161b22" ? "#ebedf0" :
           hex === "#0e4429" ? "#c6e48b" :
           hex === "#006d32" ? "#7bc96f" :
           hex === "#26a641" ? "#239a3b" :
           "#196127";
  }));

  const light = buildAnimatedSVG(lightGrid, {
    bg: "#ffffff", border: "#e5e7eb", text: "#111827",
    sparkA: "#10b981",
