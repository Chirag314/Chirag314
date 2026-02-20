import fs from "fs";
import { Octokit } from "@octokit/rest";

const username = process.env.GITHUB_USERNAME;
const token = process.env.GITHUB_TOKEN;

if (!username) throw new Error("GITHUB_USERNAME missing");

const octokit = new Octokit({ auth: token });

/**
 * Fetch contributions via GraphQL (best source for intensity).
 * We'll map intensity -> block height / color.
 */
async function fetchContrib() {
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
  const days = weeks.flatMap(w => w.contributionDays);
  return days;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function colorFor(count) {
  // Tetris-ish neon palette by intensity
  if (count <= 0) return "#111827";         // dark
  if (count <= 2) return "#22c55e";         // green
  if (count <= 5) return "#06b6d4";         // cyan
  if (count <= 10) return "#a855f7";        // purple
  return "#f97316";                         // orange
}

function buildSvg(days) {
  // Use last 52 weeks like GitHub: 7 rows (days) x ~53 cols (weeks)
  // We'll render as blocks that "drop" into place (simple animation).
  const cell = 12, gap = 2;
  const cols = Math.ceil(days.length / 7);
  const width = cols * (cell + gap) + 40;
  const height = 7 * (cell + gap) + 80;

  let rects = "";
  for (let i = 0; i < days.length; i++) {
    const row = i % 7;
    const col = Math.floor(i / 7);
    const x = 20 + col * (cell + gap);
    const yFinal = 40 + row * (cell + gap);

    const c = days[i].contributionCount;
    const fill = colorFor(c);

    // drop animation: start above and fall down
    const yStart = yFinal - 60 - (c * 2);
    const delay = (col * 0.01) + (row * 0.02);

    rects += `
      <rect x="${x}" y="${yStart}" width="${cell}" height="${cell}" rx="2" fill="${fill}">
        <animate attributeName="y" from="${yStart}" to="${yFinal}" dur="0.9s" begin="${delay}s" fill="freeze" />
      </rect>
    `;
  }

  const title = `
    <text x="20" y="22" fill="#e5e7eb" font-family="ui-sans-serif, system-ui" font-size="14" font-weight="700">
      Contributions Tetris (auto-updated)
    </text>
  `;

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#0b1020"/>
    ${title}
    ${rects}
  </svg>
  `.trim();
}

const days = await fetchContrib();
const svg = buildSvg(days);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/tetris.svg", svg, "utf-8");

console.log("Wrote output/tetris.svg");
