// Pulls stats for every player in players.json from CollegeFootballData.com
// and writes data/stats.json. Requires CFBD_API_KEY in the environment.
//
// The CFBD free tier is ~1,000 calls/month, so this is deliberately frugal:
//   - schedule + season totals: refreshed at most once per ~20h (2 calls)
//   - box scores: one call per *week*, and only for games that have started
//     but haven't been re-checked since they finished
// Idle runs (no game in progress) make zero API calls.
//
// Run with --demo to write sample data instead (no key needed).
import { readFile, writeFile } from "node:fs/promises";

const BASE = process.env.CFBD_BASE ?? "https://api.collegefootballdata.com";
const KEY = process.env.CFBD_API_KEY;
const demo = process.argv.includes("--demo");
const here = (p) => new URL(p, import.meta.url);
const HOUR = 3600e3;
const GAME_LEN = 4.5 * HOUR; // after this, treat a game as over

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(here(p))); } catch { return fallback; }
};
const cfg = await readJson("../players.json");

let calls = 0;
async function api(path, params) {
  calls++;
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// "Josh Alexander Felton" ~ "Josh Felton"; ignores punctuation and Jr/II/III.
const tokens = (s) =>
  s.toLowerCase().replace(/[’'.]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/)
    .filter((t) => t && !["jr", "sr", "ii", "iii", "iv"].includes(t));
function sameName(a, b) {
  const x = tokens(a), y = tokens(b);
  return x.join(" ") === y.join(" ") || (x[0] === y[0] && x.at(-1) === y.at(-1));
}

function boxLines(side, name) {
  const lines = {};
  for (const cat of side.categories ?? []) {
    for (const type of cat.types ?? []) {
      const a = type.athletes?.find((x) => sameName(x.name, name));
      if (a) (lines[cat.name] ??= {})[type.name] = a.stat;
    }
  }
  return lines;
}

const num = (v) => parseFloat(v) || 0;

// Flags worth calling out from a stat line. `big` = milestone-level.
function highlights(stats) {
  const out = [];
  const add = (label, big = false) => out.push({ label, big });
  const v = (cat, type) => num(stats[cat]?.[type]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (v("passing", "YDS") >= 300) add(`${v("passing", "YDS")} pass yds`, true);
  if (v("rushing", "YDS") >= 100) add(`${v("rushing", "YDS")} rush yds`, true);
  if (v("receiving", "YDS") >= 100) add(`${v("receiving", "YDS")} rec yds`, true);
  for (const [cat, what] of [["passing", "passing"], ["rushing", "rushing"], ["receiving", "receiving"]]) {
    if (v(cat, "TD") > 0) add(plural(v(cat, "TD"), `${what} TD`), true);
  }
  for (const cat of ["defensive", "interceptions", "kickReturns", "puntReturns"]) {
    if (v(cat, "TD") > 0) add(plural(v(cat, "TD"), "defensive/return TD"), true);
  }
  if (v("defensive", "SACKS") >= 1) add(plural(v("defensive", "SACKS"), "sack"), v("defensive", "SACKS") >= 2);
  if (v("interceptions", "INT") >= 1) add(plural(v("interceptions", "INT"), "INT"), true);
  if (v("defensive", "TFL") >= 2) add(`${v("defensive", "TFL")} TFL`, v("defensive", "TFL") >= 3);
  if (v("defensive", "PD") >= 2) add(`${v("defensive", "PD")} PD`);
  if (v("defensive", "TOT") >= 10) add(`${v("defensive", "TOT")} tackles`, true);
  if (v("fumbles", "REC") >= 1) add(plural(v("fumbles", "REC"), "fumble recovery"), true);
  const longMin = 35;
  for (const cat of ["rushing", "receiving"]) {
    if (v(cat, "LONG") >= longMin) add(`${v(cat, "LONG")}-yd ${cat === "rushing" ? "run" : "catch"}`, true);
  }
  return out;
}

const pkey = (p) => `${p.name}|${p.team}`;

async function updateFromApi() {
  if (!KEY) throw new Error("Set CFBD_API_KEY (free key at collegefootballdata.com)");
  const year = cfg.year;
  const active = cfg.players.filter((p) => !p.verbal); // unsigned players have no stats
  const teams = new Set(active.map((p) => p.team));
  const now = Date.now();
  const cache = await readJson("../data/cache.json", {});
  cache.boxAt ??= {}; cache.lines ??= {}; cache.scores ??= {}; cache.changed ??= {};
  const warnings = [];

  // 1) Schedule + season totals, at most every ~20h.
  if (!cache.fetchedAt || now - Date.parse(cache.fetchedAt) > 20 * HOUR) {
    const types = ["regular"];
    const m = new Date().getUTCMonth();
    if (m === 11 || m === 0) types.push("postseason");
    const all = (await Promise.all(types.map((seasonType) => api("/games", { year, seasonType })))).flat();
    cache.games = all
      .filter((g) => teams.has(g.homeTeam) || teams.has(g.awayTeam))
      .map((g) => ({
        id: g.id, week: g.week, seasonType: g.seasonType, startDate: g.startDate,
        completed: !!g.completed, home: g.homeTeam, away: g.awayTeam,
        homePoints: g.homePoints, awayPoints: g.awayPoints,
      }));
    const rows = await api("/stats/player/season", { year });
    cache.season = {};
    for (const p of active) {
      for (const r of rows) {
        if (r.team === p.team && sameName(r.player, p.name)) {
          ((cache.season[pkey(p)] ??= {})[r.category] ??= {})[r.statType] = r.stat;
        }
      }
    }
    cache.fetchedAt = new Date().toISOString();
  }
  for (const t of teams) {
    if (!cache.games.some((g) => g.home === t || g.away === t)) {
      warnings.push(`No games found for team "${t}" — check the spelling in players.json (CFBD naming).`);
    }
  }

  // 2) Box scores for games that started and haven't been checked since finishing.
  const need = cache.games.filter((g) => {
    const start = Date.parse(g.startDate);
    if (start > now) return false;
    const at = cache.boxAt[g.id];
    // Skip games polled in the last 10 min (overlapping triggers) or already checked after the final whistle.
    return !at || (Date.parse(at) < start + GAME_LEN && now - Date.parse(at) > 10 * 60e3);
  });
  const weeks = new Map();
  for (const g of need) weeks.set(`${g.seasonType}|${g.week}`, { week: g.week, seasonType: g.seasonType });
  for (const { week, seasonType } of weeks.values()) {
    const boxes = await api("/games/players", { year, week, seasonType });
    const byId = new Map(boxes.map((b) => [b.id, b]));
    for (const g of need.filter((g) => g.week === week && g.seasonType === seasonType)) {
      const box = byId.get(g.id);
      if (!box) continue;
      const sides = Object.fromEntries((box.teams ?? []).map((t) => [t.team, t]));
      cache.scores[g.id] = { [g.home]: sides[g.home]?.points ?? null, [g.away]: sides[g.away]?.points ?? null };
      for (const p of active.filter((p) => p.team === g.home || p.team === g.away)) {
        const side = sides[p.team];
        if (!side) continue;
        const k = pkey(p);
        const prev = cache.lines[k]?.[g.id];
        const next = boxLines(side, p.name);
        if (JSON.stringify(prev) !== JSON.stringify(next) && Object.keys(next).length) {
          // First sighting of an already-finished game: date it to the final whistle, not "now".
          const finished = Date.parse(g.startDate) + GAME_LEN;
          (cache.changed[k] ??= {})[g.id] = new Date(prev === undefined && now > finished ? finished : now).toISOString();
        }
        (cache.lines[k] ??= {})[g.id] = next;
      }
      cache.boxAt[g.id] = new Date().toISOString();
    }
  }

  // 3) Assemble output.
  const players = cfg.players.map((p) => {
    const out = { ...p, games: [], season: cache.season?.[pkey(p)] ?? {} };
    if (p.verbal) return out;
    const mine = cache.games.filter((g) => g.home === p.team || g.away === p.team)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (const g of mine) {
      const start = Date.parse(g.startDate);
      const home = g.home === p.team;
      const sc = cache.scores[g.id];
      const completed = g.completed || now > start + GAME_LEN;
      out.games.push({
        week: g.week, date: g.startDate, opponent: home ? g.away : g.home, home,
        completed, live: start <= now && !completed,
        score: sc && sc[p.team] != null ? { team: sc[p.team], opp: sc[home ? g.away : g.home] } : null,
        stats: cache.lines[pkey(p)]?.[g.id] ?? {},
        updatedAt: cache.changed[pkey(p)]?.[g.id] ?? null,
      });
      out.games.at(-1).highlights = highlights(out.games.at(-1).stats);
    }
    return out;
  });

  await writeFile(here("../data/cache.json"), JSON.stringify(cache));
  return { players, warnings };
}

let result;
if (demo) {
  const players = (await readJson("./demo-data.json")).map((p) => {
    p.games.sort((a, b) => a.date.localeCompare(b.date));
    for (const g of p.games) {
      g.updatedAt = Object.keys(g.stats).length ? new Date(Date.parse(g.date) + 3 * HOUR).toISOString() : null;
      g.highlights = highlights(g.stats);
    }
    return p;
  });
  result = { players, warnings: [] };
} else {
  result = await updateFromApi();
}

await writeFile(
  here("../data/stats.json"),
  JSON.stringify({ year: cfg.year, updatedAt: new Date().toISOString(), demo, warnings: result.warnings, players: result.players }),
);
console.log(`Wrote ${result.players.length} players using ${calls} API call(s).`);
for (const w of result.warnings.slice(0, 10)) console.warn("WARNING:", w);
if (result.warnings.length > 10) console.warn(`...and ${result.warnings.length - 10} more warnings (see data/stats.json)`);
