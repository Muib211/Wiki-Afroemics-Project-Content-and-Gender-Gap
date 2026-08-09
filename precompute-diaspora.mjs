#!/usr/bin/env node
/**
 * WAP Diaspora — offline precompute script
 * ------------------------------------------------------------------
 * Runs the heavy Wikidata queries ONCE (in small, patient pieces —
 * one residency signal at a time, per country) and writes their
 * combined results to diaspora-data.json, which the page then loads
 * as a static file instead of querying WDQS live in the browser.
 *
 * Requires Node 18+ (uses the built-in fetch). Run it with:
 *   node precompute-diaspora.mjs
 *
 * It writes diaspora-data.json into the same folder as this script.
 * Re-run it whenever you want fresher numbers (daily/weekly — your
 * call) and re-upload that JSON file alongside wap-diaspora.html.
 * ------------------------------------------------------------------
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "diaspora-data.json");

const ENDPOINT = "https://query.wikidata.org/sparql";
// WDQS is a shared public resource — be a polite client. These are
// generous per-query timeouts (the batch job isn't time-pressured)
// and a pause between requests so we don't hammer the endpoint.
const QUERY_TIMEOUT_MS = 60_000;
const PAUSE_BETWEEN_QUERIES_MS = 2_500;
const MAX_RETRIES = 2;
// After finishing every country once, if anything failed, wait this long
// (letting whatever caused a burst of 502/429s subside) and try each
// failed piece one more time before giving up for good.
const RETRY_SWEEP_PAUSE_MS = 45_000;

const MALE = "http://www.wikidata.org/entity/Q6581097";
const FEMALE = "http://www.wikidata.org/entity/Q6581072";
const OCC_ROOTS = ["wd:Q901", "wd:Q1650915", "wd:Q3400985", "wd:Q1622272"];
const CORE_LANGS = ["en", "fr", "ar", "pt"];

// The five receiving countries this page tracks, with each one's own primary
// Wikipedia language. No anglophone/francophone nationality restriction —
// every country checks all 54 African nationalities.
const DIASPORA_COUNTRIES = [
  ["Q145", "United Kingdom", "en"],
  ["Q30", "United States", "en"],
  ["Q16", "Canada", "en"],
  ["Q183", "Germany", "de"],
  ["Q142", "France", "fr"],
];

// The same 54 African country QIDs the live page used.
const AFRICAN_NAT_VALUES =
  "wd:Q262 wd:Q916 wd:Q962 wd:Q963 wd:Q965 wd:Q967 wd:Q1011 wd:Q1009 wd:Q929 wd:Q657 wd:Q970 wd:Q971 wd:Q974 wd:Q977 wd:Q79 wd:Q983 wd:Q986 wd:Q1050 wd:Q115 wd:Q1000 wd:Q1005 wd:Q117 wd:Q1006 wd:Q1007 wd:Q1008 wd:Q114 wd:Q1013 wd:Q1014 wd:Q1016 wd:Q1019 wd:Q1020 wd:Q912 wd:Q1025 wd:Q1027 wd:Q1028 wd:Q1029 wd:Q1030 wd:Q1032 wd:Q1033 wd:Q1037 wd:Q1039 wd:Q1041 wd:Q1042 wd:Q1044 wd:Q1045 wd:Q258 wd:Q958 wd:Q1049 wd:Q924 wd:Q945 wd:Q948 wd:Q1036 wd:Q953 wd:Q954";

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
const AFRICAN_NAT_LIST = AFRICAN_NAT_VALUES.split(" ");
// Batch size for the nationality-vs-employer query. All five countries now
// check the full 54-country nationality list with no narrowing filter, so
// the P108 (employer) signal — which reliably timed out as one big query —
// is always split into smaller batches and merged in JS.
const NAT_BATCH_SIZE = 9;

function buildLangSet(localCode) {
  const codes = [...CORE_LANGS];
  if (localCode && !codes.includes(localCode)) codes.push(localCode);
  return codes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractErrorDetail(bodyText) {
  // Blazegraph's parser errors always contain "Encountered ... at line X,
  // column Y. Was expecting one of: ..." — the actual human-readable
  // reason. The response body has no real line breaks, so we can't just
  // grab "the rest of the line" — we search for known markers directly
  // and take a fixed window from there.
  const markers = ["Encountered", "MalformedQueryException", "QueryParseException", "ParseException"];
  for (const marker of markers) {
    const idx = bodyText.indexOf(marker);
    if (idx >= 0) {
      return bodyText.slice(idx, idx + 350).replace(/\s+/g, " ").trim();
    }
  }
  return bodyText.slice(0, 200).replace(/\s+/g, " ").trim();
}

async function runSparql(query, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      // POST with the query in the body, not GET with it in the URL —
      // the occupation-subclass VALUES list alone can be hundreds of
      // QIDs, which blows past URL length limits (HTTP 414) as a GET.
      const resp = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/sparql-query",
          "User-Agent": "WAP-Diaspora-Precompute/1.0 (Wiki AfroDemics Project)",
        },
        body: query,
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "");
        const detail = extractErrorDetail(bodyText);
        throw new Error(`HTTP ${resp.status}${detail ? " — " + detail : ""}`);
      }
      const data = await resp.json();
      return data.results.bindings;
    } catch (err) {
      clearTimeout(t);
      const isLast = attempt === MAX_RETRIES;
      console.warn(
        `  [warn] ${label} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}` +
          (isLast ? " — giving up on this piece." : " — retrying…")
      );
      if (isLast) return null;
      await sleep(3000 * Math.pow(2, attempt));
    } finally {
      await sleep(PAUSE_BETWEEN_QUERIES_MS);
    }
  }
  return null;
}

// ---------- step 1: one residency-signal query, per country ----------
function residencyTriple(qid, signal) {
  if (signal === "P551") return `?person wdt:P551 wd:${qid}.`;
  if (signal === "P937") return `?person wdt:P937 wd:${qid}.`;
  // P108 (employer) -> P17 (country) is the two-hop signal, kept as its
  // own separate small query rather than folded into a UNION.
  return `?person wdt:P108 ?employer.\n      ?employer wdt:P17 wd:${qid}.`;
}

function personQuery(qid, signal, langs, natValuesList) {
  const wikiHosts = langs.map((c) => `<https://${c}.wikipedia.org/>`).join(", ");
  const natValues = (natValuesList || AFRICAN_NAT_LIST).join(" ");
  return `
    SELECT ?person ?personLabel ?nat ?natLabel ?gender ?sites
    WHERE {
      {
        SELECT ?person ?nat ?gender
               (GROUP_CONCAT(DISTINCT ?site; separator="|") AS ?sites)
        WHERE {
          ${residencyTriple(qid, signal)}
          VALUES ?nat { ${natValues} }
          ?person wdt:P27 ?nat.
          ?person p:P106 ?statement0.
          ?statement0 (ps:P106/(wdt:P279*)) ?occ.
          FILTER(?occ IN (${OCC_ROOTS.join(", ")}))
          OPTIONAL { ?person wdt:P21 ?gender. }
          OPTIONAL {
            ?w schema:about ?person; schema:isPartOf ?wiki.
            FILTER(?wiki IN (${wikiHosts}))
            BIND(REPLACE(STR(?wiki), "^https://([a-z]+).wikipedia.org/$", "$1") AS ?site)
          }
        }
        GROUP BY ?person ?nat ?gender
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;
}

function absorbRowsIntoMap(map, rows) {
  if (!rows) return;
  for (const r of rows) {
    const id = r.person.value.split("/").pop();
    const existing = map.get(id) || {
      qid: id,
      label: r.personLabel ? r.personLabel.value : id,
      natLabel: r.natLabel ? r.natLabel.value : "",
      isMale: false,
      isFemale: false,
      sites: new Set(),
    };
    if (r.gender && r.gender.value === MALE) existing.isMale = true;
    if (r.gender && r.gender.value === FEMALE) existing.isFemale = true;
    if (r.sites && r.sites.value) {
      r.sites.value.split("|").filter(Boolean).forEach((s) => existing.sites.add(s));
    }
    map.set(id, existing);
  }
}

function pieceLabel(name, piece, totalBatches) {
  return piece.batchIndex === null
    ? `${name} / ${piece.signal}`
    : `${name} / ${piece.signal} (batch ${piece.batchIndex + 1}/${totalBatches})`;
}

async function fetchCountryPeople(qid, name, localCode) {
  const langs = buildLangSet(localCode);
  const signals = ["P551", "P937", "P108"];
  const peopleMap = new Map();
  const failedPieces = []; // { signal, batchIndex: number|null }

  for (const signal of signals) {
    // P108 (employer) is the one signal that reliably times out as a
    // single 54-country query — always split into smaller nationality
    // batches and merge. P551/P937 have proven fine as single queries
    // even against the full 54-country list, so they stay as-is.
    const needsBatching = signal === "P108";
    if (!needsBatching) {
      const label = `${name} / ${signal}`;
      console.log(`  fetching ${label}…`);
      const rows = await runSparql(personQuery(qid, signal, langs), label);
      if (!rows) {
        console.warn(`  [warn] skipping ${label} — no data for this signal this run.`);
        failedPieces.push({ signal, batchIndex: null });
      }
      absorbRowsIntoMap(peopleMap, rows);
      continue;
    }
    const batches = chunkArray(AFRICAN_NAT_LIST, NAT_BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const label = `${name} / ${signal} (batch ${i + 1}/${batches.length})`;
      console.log(`  fetching ${label}…`);
      const rows = await runSparql(personQuery(qid, signal, langs, batches[i]), label);
      if (!rows) {
        console.warn(`  [warn] skipping ${label} — no data for this batch this run.`);
        failedPieces.push({ signal, batchIndex: i });
      }
      absorbRowsIntoMap(peopleMap, rows);
    }
  }
  return { langs, peopleMap, failedPieces };
}

async function retryPiece(qid, name, langs, piece) {
  const batches = chunkArray(AFRICAN_NAT_LIST, NAT_BATCH_SIZE);
  const natValuesList = piece.batchIndex === null ? undefined : batches[piece.batchIndex];
  const label = `${pieceLabel(name, piece, batches.length)} [retry sweep]`;
  console.log(`  retrying ${label}…`);
  return await runSparql(personQuery(qid, piece.signal, langs, natValuesList), label);
}

// ---------- step 3: derive overview stats + gap-explorer lists in JS ----------
function summarize(qid, name, localCode, langs, people) {
  const anyCovered = (p) => langs.some((l) => p.sites.has(l));
  const total = people.length;
  const covered = people.filter(anyCovered).length;
  const men = people.filter((p) => p.isMale).length;
  const women = people.filter((p) => p.isFemale).length;
  const coveredByMOrF = people.filter((p) => p.isMale || p.isFemale).length; // not used directly
  const both = people.filter((p) => p.isMale && p.isFemale).length;
  const other = Math.max(0, total - (men + women - both));

  const personCard = (p) => ({
    qid: p.qid,
    label: p.label,
    natLabel: p.natLabel,
    isMale: p.isMale,
    isFemale: p.isFemale,
  });
  const missing = (checkLangs) =>
    people.filter((p) => !checkLangs.some((l) => p.sites.has(l))).map(personCard);

  const gaps = {
    all: missing(langs),
    en: missing(["en"]),
    fr: missing(["fr"]),
    ar: missing(["ar"]),
    pt: missing(["pt"]),
    local: localCode ? missing([localCode]) : [],
  };

  return {
    overview: { name, total, covered, men, women, other },
    gaps,
  };
}

// ---------- main ----------
async function main() {
  const countryData = []; // { qid, name, localCode, langs, peopleMap, failedPieces }

  for (const [qid, name, localCode] of DIASPORA_COUNTRIES) {
    console.log(`Country: ${name}`);
    const { langs, peopleMap, failedPieces } = await fetchCountryPeople(qid, name, localCode);
    countryData.push({ qid, name, localCode, langs, peopleMap, failedPieces });
    console.log(`  -> ${peopleMap.size} people so far (before any retry sweep).\n`);
  }

  const totalFailed = countryData.reduce((n, c) => n + c.failedPieces.length, 0);
  if (totalFailed > 0) {
    console.log(
      `\n${totalFailed} piece(s) failed across all countries — waiting ${RETRY_SWEEP_PAUSE_MS / 1000}s ` +
        `(letting whatever caused it subside) then retrying each one once more…\n`
    );
    await sleep(RETRY_SWEEP_PAUSE_MS);
    for (const c of countryData) {
      const stillFailed = [];
      for (const piece of c.failedPieces) {
        const rows = await retryPiece(c.qid, c.name, c.langs, piece);
        if (rows) {
          absorbRowsIntoMap(c.peopleMap, rows);
          console.log(`  [ok] recovered ${pieceLabel(c.name, piece, Math.ceil(AFRICAN_NAT_LIST.length / NAT_BATCH_SIZE))} on retry sweep.`);
        } else {
          stillFailed.push(piece);
        }
      }
      c.failedPieces = stillFailed;
    }
    console.log("");
  }

  const overview = {};
  const gaps = {};
  const failedCountries = [];
  let anyPartial = false;

  for (const c of countryData) {
    const people = Array.from(c.peopleMap.values());
    if (!people.length) {
      console.warn(`  [warn] no data collected for ${c.name} — check warnings above.`);
      failedCountries.push(c.name);
    }
    const { overview: ov, gaps: gp } = summarize(c.qid, c.name, c.localCode, c.langs, people);
    ov.incomplete = c.failedPieces.length > 0;
    ov.missingPieces = c.failedPieces.map((p) =>
      pieceLabel("", p, Math.ceil(AFRICAN_NAT_LIST.length / NAT_BATCH_SIZE)).replace(/^ \/ /, "")
    );
    overview[c.qid] = ov;
    gaps[c.qid] = gp;
    if (c.failedPieces.length) {
      anyPartial = true;
      console.warn(
        `  [warn] ${c.name}'s total is still an UNDERCOUNT after the retry sweep — ` +
          `${c.failedPieces.length} piece(s) failed twice: ${ov.missingPieces.join(", ")}`
      );
    }
    console.log(`  -> ${c.name}: ${ov.total} people, ${ov.covered} covered (final).`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    failedCountries,
    overview,
    gaps,
  };

  await writeFile(OUT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nDone. Wrote ${OUT_PATH}`);
  if (failedCountries.length) {
    console.warn(
      `Note: ${failedCountries.join(", ")} came back completely empty this run — re-run the script, WDQS may have been under load.`
    );
  }
  if (anyPartial) {
    console.warn(
      `Note: some countries above still have "incomplete": true after the retry sweep — their totals are undercounts, not necessarily the real number. A future run may recover them if WDQS is calmer.`
    );
  }
}


main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
