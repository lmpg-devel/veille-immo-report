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
  const newListings = currentListings.filter((listing) => {
    const key = listingKey(listing);
    return Boolean(key && !previousKeys.has(key));
  });
  const ids = newListings.map(listingKey);

  current.newListings = {
    criterion: "absent-rapport-quotidien-precedent",
    baselineGeneratedAt: previous.generatedAt || null,
    baselineCount: previousListings.length,
    count: ids.length,
    ids,
    bySource: sourceCounts(newListings)
  };

  const outputPath = args.out || args.current;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(current, null, 2), "utf8");
  console.log(JSON.stringify(current.newListings, null, 2));
}

run();
