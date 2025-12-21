// scripts/generate-minesweeper-pop.mjs
import fs from "node:fs";
import path from "node:path";

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
      Authorization: `bearer ${TOKEN}`,
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

function darkColor(count) {
  if (count <= 0) return "#161b22";
  if (count < 3) return "#0e4429";
  if (count < 7) return "#006d32";
  if (count < 15) return "#26a641";
  return "#39d353";
}

function lightColor(count) {
  if (count <= 0) return "#ebedf0";
  if (count < 3) return "#c6e48b";
  if (count < 7) return "#7bc96f";
  if (count < 15) return "#239a3b";
  return "#196127";
}

function buildSVG(grid, theme) {
  const rows = 7;
  const cols = grid[0].length;

  const padding = 12;
  const cell = 11;
  const gap = 2;

  const gridW = cols * (cell + gap) - gap;
  const gridH = rows * (cell + gap) - gap;

  const width = gridW + padding * 2;
  const height = gridH + padding * 2 + 22;

  const bg = theme === "dark" ? "#0d1117" : "#ffffff";
  const border = theme === "dark" ? "#30363d" : "#e5e7eb";
  const text = theme === "dark" ? "#c9d1d9" : "#111827";

  const sparkA = theme === "dark" ? "#22c55e" : "#10b981";
  const sparkB = theme === "dark" ? "#60a5fa" : "#2563eb";
  const sparkC = theme === "dark" ? "#a78bfa" : "#7c3aed";

  // Sweep order (snakey columns)
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) order.push([c, r]);
    else for (let r = rows - 1; r >= 0; r--) order.push([c, r]);
  }

  const steps = order.length;
  const dur = Math.max(8, Math.min(16, Math.round(steps / 18)));
  const cursorX = order.map(([c]) => (padding + c * (cell + gap) + cell / 2)).join(";");
  const cursorY = order.map(([, r]) => (padding + r * (cell + gap) + cell / 2)).join(";");

  const rects = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padding + c * (cell + gap);
      const y = padding + r * (cell + gap);
      rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${grid[r][c]}" />`);
    }
  }

  // Pops every N cells visited
  const popsEvery = 6;
  const popOrder = order.filter((_, i) => i % popsEvery === 0);

  const stepDur = dur / steps;
  const pops = popOrder
    .map(([c, r], idx) => {
      const t = (idx * popsEvery) * stepDur;
      const x = padding + c * (cell + gap) + cell / 2;
      const y = padding + r * (cell + gap) + cell / 2;

      const rays = [0, 60, 120, 180, 240, 300]
        .map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const x2 = x + Math.cos(rad) * 7;
          const y2 = y + Math.sin(rad) * 7;
          return `<line x1="${x}" y1="${y}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${sparkC}" stroke-width="1">
  <animate attributeName="stroke-opacity" values="0;1;0" dur="0.55s" begin="${t.toFixed(3)}s" />
</line>`;
        })
        .join("");

      return `<g opacity="0">
  <animate attributeName="opacity" values="0;1;0" dur="0.55s" begin="${t.toFixed(3)}s" />
  <circle cx="${x}" cy="${y}" r="0">
    <animate attributeName="r" values="0;5;0" dur="0.55s" begin="${t.toFixed(3)}s" />
    <animate attributeName="fill" values="${sparkA};${sparkB};${sparkC}" dur="0.55s" begin="${t.toFixed(3)}s" />
  </circle>
  <circle cx="${x}" cy="${y}" r="0" fill="${sparkB}" opacity="0.9">
    <animate attributeName="r" values="0;2.2;0" dur="0.55s" begin="${t.toFixed(3)}s" />
  </circle>
  ${rays}
</g>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${bg}" stroke="${border}" />

  <text x="${padding}" y="${height - 10}" fill="${text}" font-size="12"
        font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto">
    Minesweeper-style sweep (spark pops)
  </text>

  <g>${rects.join("\n")}</g>

  <g filter="url(#softGlow)">
    <circle r="4" fill="${sparkB}">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" values="${cursorX}" calcMode="discrete" />
      <animate attributeName="cy" dur="${dur}s" repeatCount="indefinite" values="${cursorY}" calcMode="discrete" />
    </circle>
    <circle r="9" fill="${sparkB}" opacity="0.15">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" values="${cursorX}" calcMode="discrete" />
      <animate attributeName="cy" dur="${dur}s" repeatCount="indefinite" values="${cursorY}" calcMode="discrete" />
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

  const cols = weeks.length;
  const rows = 7;

  const gridDark = Array.from({ length: rows }, () => Array(cols).fill("#161b22"));
  const gridLight = Array.from({ length: rows }, () => Array(cols).fill("#ebedf0"));

  for (let c = 0; c < cols; c++) {
    const days = weeks[c].contributionDays;
    for (let r = 0; r < rows; r++) {
      const count = days[r]?.contributionCount ?? 0;
      gridDark[r][c] = darkColor(count);
      gridLight[r][c] = lightColor(count);
    }
  }

  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });

  fs.writeFileSync(path.join(distDir, "minesweeper-pop-dark.svg"), buildSVG(gridDark, "dark"), "utf8");
  fs.writeFileSync(path.join(distDir, "minesweeper-pop.svg"), buildSVG(gridLight, "light"), "utf8");

  console.log("Generated dist/minesweeper-pop.svg and dist/minesweeper-pop-dark.svg");
}

main();
