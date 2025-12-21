// scripts/generate-minesweeper-pop.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import cheerio from "cheerio";

const USERNAME = process.env.USERNAME || "Chirag314";

// Fetch the contribution SVG-ish HTML (no auth needed)
async function fetchContribHTML(username) {
  const url = `https://github.com/users/${username}/contributions`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "minesweeper-pop-generator",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch contributions: ${res.status}`);
  return await res.text();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Turn GitHub contribution rects into our own SVG grid + animation overlay
function buildAnimatedSVG(rects, opts) {
  const {
    width = 900,
    height = 180,
    padding = 12,
    cell = 11,
    gap = 2,
    bg = "#0d1117",
    border = "#30363d",
    text = "#c9d1d9",
    sparkA = "#22c55e",  // green
    sparkB = "#60a5fa",  // blue
    sparkC = "#a78bfa",  // purple
  } = opts;

  // GitHub provides x/y positions already; normalize to start at (0,0)
  const xs = rects.map(r => r.x);
  const ys = rects.map(r => r.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  const norm = rects.map(r => ({
    ...r,
    x: (r.x - minX),
    y: (r.y - minY),
  }));

  const maxX = Math.max(...norm.map(r => r.x));
  const maxY = Math.max(...norm.map(r => r.y));

  // Scale grid to our chosen cell size (GitHub uses 11 and 2 gap already; we’ll re-map)
  // We infer step from the data by looking at smallest non-zero delta.
  const uniqX = [...new Set(norm.map(r => r.x))].sort((a,b)=>a-b);
  const uniqY = [...new Set(norm.map(r => r.y))].sort((a,b)=>a-b);
  const stepX = uniqX.length > 1 ? (uniqX[1] - uniqX[0]) : 13;
  const stepY = uniqY.length > 1 ? (uniqY[1] - uniqY[0]) : 13;

  const cols = uniqX.length;
  const rows = uniqY.length;

  const gridW = cols * (cell + gap) - gap;
  const gridH = rows * (cell + gap) - gap;

  const viewW = Math.max(width, gridW + padding * 2);
  const viewH = Math.max(height, gridH + padding * 2 + 22);

  // Map original x/y to grid coordinates 0..cols-1 / 0..rows-1
  const xIndex = new Map(uniqX.map((x,i)=>[x,i]));
  const yIndex = new Map(uniqY.map((y,i)=>[y,i]));

  const cells = norm.map(r => {
    const cx = xIndex.get(r.x);
    const cy = yIndex.get(r.y);
    const px = padding + cx * (cell + gap);
    const py = padding + cy * (cell + gap);
    return { ...r, cx, cy, px, py };
  });

  // Animation sweep: visit cells in a snakey scan pattern (like Minesweeper clearing)
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) {
      for (let r = 0; r < rows; r++) order.push([c, r]);
    } else {
      for (let r = rows - 1; r >= 0; r--) order.push([c, r]);
    }
  }

  const totalSteps = order.length;
  const dur = clamp(Math.round(totalSteps / 18), 6, 16); // 6–16s, based on grid size
  const stepDur = dur / totalSteps;

  function cellAt(c, r) {
    // find by indices
    // grid is dense; use a map for speed
  }
  const cellMap = new Map(cells.map(cc => [`${cc.cx},${cc.cy}`, cc]));
  const seq = order.map(([c,r]) => cellMap.get(`${c},${r}`)).filter(Boolean);

  // Cursor path animation values
  const cursorXValues = seq.map(s => (s.px + cell/2)).join(";");
  const cursorYValues = seq.map(s => (s.py + cell/2)).join(";");

  // Spark pops: pick every Nth visited cell (avoid too many elements)
  const popsEvery = 8; // tweak this if you want more/less pops
  const popCells = seq.filter((_,i) => i % popsEvery === 0);

  const popElements = popCells.map((s, idx) => {
    const t = (idx * popsEvery) * stepDur; // seconds into animation
    const id = `p${idx}`;
    const x = s.px + cell/2;
    const y = s.py + cell/2;

    // Cartoon “spark”: small circles + star-ish lines that scale + fade quickly
    // Safe/clean: no bomb shapes, just celebratory pops.
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

  const rectElements = cells.map(s => {
    // Use GitHub-provided fill (already indicates intensity)
    const fill = s.fill || "#161b22";
    return `<rect x="${s.px}" y="${s.py}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}" />`;
  }).join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
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

  <text x="${padding}" y="${viewH - 10}" fill="${text}" font-size="12" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto">
    Minesweeper-style sweep (spark pops)
  </text>

  <g>
    ${rectElements}
  </g>

  <!-- cursor -->
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

  <!-- spark pops -->
  <g filter="url(#softGlow)">
    ${popElements}
  </g>
</svg>`;

  return svg;
}

function parseRectsFromHTML(html) {
  const $ = cheerio.load(html);
  const rects = [];
  $("svg rect").each((_, el) => {
    const x = Number($(el).attr("x"));
    const y = Number($(el).attr("y"));
    const fill = $(el).attr("fill") || undefined;
    // Some rects have data-count, data-date etc. (optional)
    rects.push({ x, y, fill });
  });
  if (rects.length === 0) throw new Error("No rects found; GitHub page structure may have changed.");
  return rects;
}

async function main() {
  const html = await fetchContribHTML(USERNAME);
  const rects = parseRectsFromHTML(html);

  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });

  // Dark (GitHub-native)
  const darkSVG = buildAnimatedSVG(rects, {
    bg: "#0d1117",
    border: "#30363d",
    text: "#c9d1d9",
    sparkA: "#22c55e",
    sparkB: "#60a5fa",
    sparkC: "#a78bfa",
  });

  // Light
  const lightSVG = buildAnimatedSVG(rects, {
    bg: "#ffffff",
    border: "#e5e7eb",
    text: "#111827",
    sparkA: "#10b981",
    sparkB: "#2563eb",
    sparkC: "#7c3aed",
  });

  fs.writeFileSync(path.join(distDir, "minesweeper-pop-dark.svg"), darkSVG, "utf8");
  fs.writeFileSync(path.join(distDir, "minesweeper-pop.svg"), lightSVG, "utf8");

  console.log("Generated dist/minesweeper-pop.svg and dist/minesweeper-pop-dark.svg");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
