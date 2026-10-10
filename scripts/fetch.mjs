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

let calls = 0, calls_espn = 0;
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

const ESPN = process.env.ESPN_BASE ?? "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const normTeam = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// One ESPN game summary, reshaped like CFBD's box score. Returns null if no box score yet.
async function espnGame(g) {
  calls_espn++;
  const res = await fetch(`${ESPN}/summary?event=${g.id}`);
  if (!res.ok) throw new Error(`${res.status}`);
  const d = await res.json();
  const comp = d.header?.competitions?.[0];
  const boxPlayers = d.boxscore?.players ?? [];
  if (!comp || !boxPlayers.length) return null;
  // Map each ESPN team id to our CFBD team name (by name, falling back to home/away).
  const ours = {};
  for (const c of comp.competitors ?? []) {
    const loc = normTeam(c.team?.location);
    ours[c.team.id] = loc === normTeam(g.home) ? g.home : loc === normTeam(g.away) ? g.away : c.homeAway === "home" ? g.home : g.away;
  }
  const sides = {}, scores = {};
  for (const c of comp.competitors ?? []) scores[ours[c.team.id]] = c.score != null ? Number(c.score) : null;
  for (const t of boxPlayers) {
    const name = ours[t.team?.id];
    if (!name) continue;
    sides[name] = {
      categories: (t.statistics ?? []).map((cat) => ({
        name: cat.name,
        types: (cat.labels ?? []).map((label, i) => ({
          name: label,
          athletes: (cat.athletes ?? []).map((a) => ({ name: a.athlete?.displayName ?? "", stat: a.stats?.[i] })),
        })),
      })),
    };
  }
  const drives = [...(d.drives?.previous ?? []), ...(d.drives?.current ? [d.drives.current] : [])];
  const plays = drives.flatMap((dr) => dr.plays ?? []).map((p) => ({
    id: p.id, text: p.text ?? "", type: p.type?.text ?? "", period: p.period?.number, clock: p.clock?.displayValue,
    yds: p.statYardage, scoring: !!p.scoringPlay, turnover: !!p.isTurnover, at: p.wallclock,
  }));
  return { state: comp.status?.type?.state, scores, sides, plays };
}

// ---- Play-by-play -------------------------------------------------------
const cleanPlay = (t) => t
  .replace(/^\(\d+:\d+\)\s*/, "")
  .replace(/#\d+\s*/g, "")
  .replace(/\b(?:No Huddle-Shotgun|No Huddle-Pistol|No Huddle|Shotgun|Pistol)\s*/gi, "")
  .replace(/,?\s*End Of Play/gi, "")
  .trim();

function playTags(p) {
  const tags = [];
  const t = p.text.toLowerCase();
  if (p.scoring) tags.push({ label: /touchdown/.test(t) ? "TD" : "Score", big: true });
  if (p.turnover || /intercept/.test(t)) tags.push({ label: /intercept/.test(t) ? "INT" : "Turnover", big: true });
  else if (/fumble/.test(t)) tags.push({ label: "Fumble", big: true });
  if (/\bsack/.test(t)) tags.push({ label: "Sack", big: true });
  if (/broken up by/.test(t)) tags.push({ label: "PBU", big: false });
  if (p.yds >= 35 && /(pass|rush|run)/.test(t)) tags.push({ label: `${p.yds} yds`, big: true });
  return tags;
}

// Plays from `plays` in which `name` made the play (not merely targeted or penalized).
function playerPlays(name, plays) {
  const t = tokens(name);
  const first = t[0]?.[0], last = t.at(-1);
  if (!first || !last) return [];
  const who = `\\b${first}\\.\\s?${last}\\b`;
  const mention = new RegExp(who);
  const credited = new RegExp(`(?:broken up|hurried) by[^,]*?${who}`);
  const tackle = new RegExp(`\\([^)]*${who}`);
  const out = [], seen = new Set();
  for (const p of plays) {
    if (seen.has(p.id)) continue; // ESPN can list a play under two drives
    seen.add(p.id);
    const low = p.text.toLowerCase().replace(/['’]/g, "");
    if (!mention.test(low) || /penalty/i.test(p.type)) continue;
    // On incompletions only count defenders credited with the breakup/hurry, not the targeted receiver.
    if (/incomplet/i.test(p.type + " " + low) && !credited.test(low)) continue;
    const tags = playTags(p);
    if (tackle.test(low) && !tags.some((t) => t.label === "PBU")) tags.unshift({ label: "Tackle", big: false });
    out.push({ id: p.id, q: p.period, clock: p.clock, at: p.at, yds: p.yds, text: cleanPlay(p.text), tags });
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

  // 2) Box scores. ESPN (free, live, same game ids as CFBD) is primary; CFBD box scores
  // are the fallback once a game is over. Finished games are fetched once and then frozen.
  cache.state ??= {}; cache.plays ??= {}; cache.playsDone ??= {}; cache.noEspnAt ??= {};
  const started = cache.games.filter((g) => Date.parse(g.startDate) <= now);
  const isFinal = (g) =>
    cache.state[g.id] === "post" ||
    (cache.state[g.id] === undefined && cache.boxAt[g.id] && Date.parse(cache.boxAt[g.id]) >= Date.parse(g.startDate) + GAME_LEN);
  const need = started.filter((g) =>
    (!isFinal(g) || !cache.playsDone[g.id]) &&
    // skip games polled in the last 10 min (overlapping triggers) or that ESPN doesn't cover (retry daily)
    !(cache.boxAt[g.id] && now - Date.parse(cache.boxAt[g.id]) < 10 * 60e3) &&
    !(cache.noEspnAt[g.id] && now - Date.parse(cache.noEspnAt[g.id]) < 24 * HOUR));

  // Store one game's results. `sideFor(team)` returns a CFBD-shaped side ({categories}) or undefined.
  function record(g, scores, sideFor, plays = null) {
    cache.scores[g.id] = scores;
    for (const p of active.filter((p) => p.team === g.home || p.team === g.away)) {
      const side = sideFor(p.team);
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
      if (plays) (cache.plays[k] ??= {})[g.id] = playerPlays(p.name, plays);
    }
    if (plays?.length) cache.playsDone[g.id] = true;
    cache.boxAt[g.id] = new Date().toISOString();
  }

  const fallback = [];
  const queue = [...need];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let g; (g = queue.shift()); ) {
      try {
        const e = await espnGame(g, g.home, g.away);
        if (!e) { cache.noEspnAt[g.id] = new Date().toISOString(); fallback.push(g); continue; }
        cache.state[g.id] = e.state;
        record(g, e.scores, (team) => e.sides[team], e.plays);
      } catch (err) {
        console.warn(`ESPN failed for game ${g.id}: ${err.message}`);
        fallback.push(g);
      }
    }
  }));

  const stale = fallback.filter((g) => now > Date.parse(g.startDate) + GAME_LEN);
  const weeks = new Map();
  for (const g of stale) weeks.set(`${g.seasonType}|${g.week}`, { week: g.week, seasonType: g.seasonType });
  for (const { week, seasonType } of weeks.values()) {
    const boxes = await api("/games/players", { year, week, seasonType });
    const byId = new Map(boxes.map((b) => [b.id, b]));
    for (const g of stale.filter((g) => g.week === week && g.seasonType === seasonType)) {
      const box = byId.get(g.id);
      if (!box) continue;
      const sides = Object.fromEntries((box.teams ?? []).map((t) => [t.team, t]));
      record(g, { [g.home]: sides[g.home]?.points ?? null, [g.away]: sides[g.away]?.points ?? null }, (team) => sides[team]);
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
      const st = cache.state?.[g.id];
      const completed = g.completed || st === "post" || now > start + (st === "in" ? 8 * HOUR : GAME_LEN);
      out.games.push({
        week: g.week, date: g.startDate, opponent: home ? g.away : g.home, home,
        completed, live: start <= now && !completed,
        score: sc && sc[p.team] != null ? { team: sc[p.team], opp: sc[home ? g.away : g.home] } : null,
        stats: cache.lines[pkey(p)]?.[g.id] ?? {},
        updatedAt: cache.changed[pkey(p)]?.[g.id] ?? null,
        plays: now - start < 10 * 24 * HOUR ? cache.plays[pkey(p)]?.[g.id] ?? [] : [],
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
console.log(`Wrote ${result.players.length} players using ${calls} CFBD call(s) and ${calls_espn} ESPN call(s).`);
for (const w of result.warnings.slice(0, 10)) console.warn("WARNING:", w);
if (result.warnings.length > 10) console.warn(`...and ${result.warnings.length - 10} more warnings (see data/stats.json)`);
