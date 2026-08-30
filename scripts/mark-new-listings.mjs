import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function listingKey(listing) {
  const rawUrl = String(listing && listing.url || "").trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return (parsed.origin + parsed.pathname).toLowerCase();
    } catch {
      return rawUrl.split(/[?#]/)[0].toLowerCase();
    }
  }
  return String(listing && listing.id || "").trim().toLowerCase();
}

function sourceCounts(listings) {
  return listings.reduce((counts, listing) => {
    const source = String(listing && listing.source || "Source inconnue");
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
}

function parseListingDateValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function listingPublicationInfo(listing) {
  const fields = [
    "publicationDate",
    "publishedAt",
    "publishedDate",
    "datePublished",
    "createdAt",
    "creationDate",
    "firstSeenAt",
    "firstSeen",
    "listedAt",
    "listingDate",
    "date"
  ];
  for (const field of fields) {
    const parsed = parseListingDateValue(listing?.[field]);
    if (parsed) {
      return {
        field,
        rawValue: listing[field],
        iso: new Date(parsed).toISOString(),
        time: parsed
      };
    }
  }
  return null;
}

function recentPublicationMatch(listing, now) {
  const publication = listingPublicationInfo(listing);
  if (!publication || publication.time > now || now - publication.time > 72 * 60 * 60 * 1000) {
    return null;
  }
  return publication;
}

function run() {
  const args = parseArgs(process.argv);
  if (!args.current || !args.previous) {
    throw new Error("Usage: node scripts/mark-new-listings.mjs --current results.json --previous previous-results.json [--out results.json]");
  }

  const current = JSON.parse(fs.readFileSync(args.current, "utf8"));
  const previous = JSON.parse(fs.readFileSync(args.previous, "utf8"));
  const currentListings = Array.isArray(current.listings) ? current.listings : [];
  const previousListings = Array.isArray(previous.listings) ? previous.listings : [];
  const previousKeys = new Set(previousListings.map(listingKey).filter(Boolean));
  const now = Date.parse(current.generatedAt || "") || Date.now();
  const newListings = currentListings.filter((listing) => {
    const key = listingKey(listing);
    return Boolean(key && (!previousKeys.has(key) || recentPublicationMatch(listing, now)));
  });
  const ids = newListings.map(listingKey);
  const details = newListings.reduce((acc, listing) => {
    const key = listingKey(listing);
    const publication = recentPublicationMatch(listing, now);
    acc[key] = {
      reason: previousKeys.has(key) ? "publication-fiable-72h" : (publication ? "absent-rapport-quotidien-precedent-et-publication-fiable-72h" : "absent-rapport-quotidien-precedent"),
      publication: publication ? {
        field: publication.field,
        rawValue: publication.rawValue,
        iso: publication.iso,
        ageHours: Math.round(((now - publication.time) / (60 * 60 * 1000)) * 10) / 10,
        within72h: true
      } : null
    };
    return acc;
  }, {});

  current.newListings = {
    criterion: "absent-rapport-quotidien-precedent-ou-publication-fiable-72h",
    baselineGeneratedAt: previous.generatedAt || null,
    baselineCount: previousListings.length,
    count: ids.length,
    ids,
    details,
    bySource: sourceCounts(newListings)
  };
  current.sources = sourceCounts(currentListings);

  const outputPath = args.out || args.current;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(current, null, 2), "utf8");
  console.log(JSON.stringify(current.newListings, null, 2));
}

run();
