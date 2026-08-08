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
const QUERY_TIMEOUT_MS = 90_000;
const PAUSE_BETWEEN_QUERIES_MS = 1_200;
const MAX_RETRIES = 2;

const MALE = "http://www.wikidata.org/entity/Q6581097";
const FEMALE = "http://www.wikidata.org/entity/Q6581072";
const LANG_ENGLISH = "wd:Q1860";
const LANG_FRENCH = "wd:Q150";
const OCC_ROOTS = ["wd:Q901", "wd:Q1650915", "wd:Q3400985", "wd:Q1622272"];
const CORE_LANGS = ["en", "fr", "ar", "pt"];

// Same 5 receiving countries and per-country official-language filter
// as the live page used. null natLangFilter = no restriction (Germany).
const DIASPORA_COUNTRIES = [
  ["Q145", "United Kingdom", "en", LANG_ENGLISH],
  ["Q30", "United States", "en", LANG_ENGLISH],
  ["Q16", "Canada", "en", LANG_ENGLISH],
  ["Q183", "Germany", "de", null],
  ["Q142", "France", "fr", LANG_FRENCH],
];

// The same 54 African country QIDs the live page used.
const AFRICAN_NAT_VALUES =
  "wd:Q262 wd:Q916 wd:Q962 wd:Q963 wd:Q965 wd:Q967 wd:Q1011 wd:Q1009 wd:Q929 wd:Q657 wd:Q970 wd:Q971 wd:Q974 wd:Q977 wd:Q79 wd:Q983 wd:Q986 wd:Q1050 wd:Q115 wd:Q1000 wd:Q1005 wd:Q117 wd:Q1006 wd:Q1007 wd:Q1008 wd:Q114 wd:Q1013 wd:Q1014 wd:Q1016 wd:Q1019 wd:Q1020 wd:Q912 wd:Q1025 wd:Q1027 wd:Q1028 wd:Q1029 wd:Q1030 wd:Q1032 wd:Q1033 wd:Q1037 wd:Q1039 wd:Q1041 wd:Q1042 wd:Q1044 wd:Q1045 wd:Q258 wd:Q958 wd:Q1049 wd:Q924 wd:Q945 wd:Q948 wd:Q1036 wd:Q953 wd:Q954";

function buildLangSet(localCode) {
  const codes = [...CORE_LANGS];
  if (localCode && !codes.includes(localCode)) codes.push(localCode);
  return codes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
      await sleep(2000 * (attempt + 1));
    } finally {
      await sleep(PAUSE_BETWEEN_QUERIES_MS);
    }
  }
  return null;
}

// ---------- step 1: flatten the occupation subclass tree ONCE ----------
async function fetchOccupationList() {
  const query = `
    SELECT DISTINCT ?occ WHERE {
      VALUES ?root { ${OCC_ROOTS.join(" ")} }
      ?occ wdt:P279* ?root.
    }
  `;
  const rows = await runSparql(query, "occupation subclass list");
  if (!rows) throw new Error("Could not fetch the occupation subclass list — cannot continue.");
  return rows.map((r) => "wd:" + r.occ.value.split("/").pop());
}

// ---------- step 2: one residency-signal query, per country ----------
function residencyTriple(qid, signal) {
  if (signal === "P551") return `?person wdt:P551 wd:${qid}.`;
  if (signal === "P937") return `?person wdt:P937 wd:${qid}.`;
  // P108 (employer) -> P17 (country) is the two-hop signal, kept as its
  // own separate small query rather than folded into a UNION.
  return `?person wdt:P108 ?employer.\n      ?employer wdt:P17 wd:${qid}.`;
}

function personQuery(qid, signal, natLangFilter, occValues, langs) {
  const natLangJoin = natLangFilter ? `\n      ?nat wdt:P37 ${natLangFilter}.` : "";
  const wikiHosts = langs.map((c) => `<https://${c}.wikipedia.org/>`).join(", ");
  return `
    SELECT ?person ?personLabel ?nat ?natLabel ?gender
           (GROUP_CONCAT(DISTINCT ?site; separator="|") AS ?sites)
    WHERE {
      ${residencyTriple(qid, signal)}
      VALUES ?nat { ${AFRICAN_NAT_VALUES} }
      ?person wdt:P27 ?nat.${natLangJoin}
      VALUES ?occ { ${occValues.join(" ")} }
      ?person wdt:P106 ?occ.
      OPTIONAL { ?person wdt:P21 ?gender. }
      OPTIONAL {
        ?w schema:about ?person; schema:isPartOf ?wiki.
        FILTER(?wiki IN (${wikiHosts}))
        BIND(REPLACE(STR(?wiki), "^https://([a-z]+)\\.wikipedia\\.org/$", "$1") AS ?site)
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    GROUP BY ?person ?personLabel ?nat ?natLabel ?gender
  `;
}

async function fetchCountryPeople(qid, name, localCode, natLangFilter, occValues) {
  const langs = buildLangSet(localCode);
  const signals = ["P551", "P937", "P108"];
  const byPerson = new Map();
  for (const signal of signals) {
    const label = `${name} / ${signal}`;
    console.log(`  fetching ${label}…`);
    const rows = await runSparql(personQuery(qid, signal, natLangFilter, occValues, langs), label);
    if (!rows) {
      console.warn(`  [warn] skipping ${label} — no data for this signal this run.`);
      continue;
    }
    for (const r of rows) {
      const id = r.person.value.split("/").pop();
      const existing = byPerson.get(id) || {
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
      byPerson.set(id, existing);
    }
  }
  return { langs, people: Array.from(byPerson.values()) };
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
  console.log("Fetching flattened occupation subclass list…");
  const occValues = await fetchOccupationList();
  console.log(`  got ${occValues.length} occupation QIDs.\n`);

  const overview = {};
  const gaps = {};
  const failedCountries = [];

  for (const [qid, name, localCode, natLangFilter] of DIASPORA_COUNTRIES) {
    console.log(`Country: ${name}`);
    const { langs, people } = await fetchCountryPeople(qid, name, localCode, natLangFilter, occValues);
    if (!people.length) {
      console.warn(`  [warn] no data collected for ${name} — check warnings above.`);
      failedCountries.push(name);
    }
    const { overview: ov, gaps: gp } = summarize(qid, name, localCode, langs, people);
    overview[qid] = ov;
    gaps[qid] = gp;
    console.log(`  -> ${ov.total} people, ${ov.covered} covered.\n`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    failedCountries,
    overview,
    gaps,
  };

  await writeFile(OUT_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Done. Wrote ${OUT_PATH}`);
  if (failedCountries.length) {
    console.warn(
      `Note: ${failedCountries.join(", ")} came back empty this run — re-run the script, WDQS may have been under load.`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
