import fs from "node:fs";

function parseArgs(argv) {
  const args = {
    current: "",
    previous: "",
    label: "results",
    minTotal: 1,
    minImmowebWhenPrevious: 25,
    maxTotalDropRatio: 0.65,
    maxImmowebDropRatio: 0.8
  };
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  for (const key of ["minTotal", "minImmowebWhenPrevious", "maxTotalDropRatio", "maxImmowebDropRatio"]) {
    args[key] = Number(args[key]);
  }
  return args;
}

function readPayload(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listingsOf(payload) {
  return Array.isArray(payload?.listings) ? payload.listings : [];
}

function countBySource(listings) {
  return listings.reduce((acc, listing) => {
    const source = String(listing?.source || "Source inconnue");
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function sourceCount(counts, matcher) {
  return Object.entries(counts).reduce((total, [source, count]) => matcher(source.toLowerCase()) ? total + count : total, 0);
}

function fail(message, context) {
  const suffix = context ? `\n${JSON.stringify(context, null, 2)}` : "";
  throw new Error(message + suffix);
}

function validate() {
  const args = parseArgs(process.argv);
  if (!args.current) {
    throw new Error("Usage: node scripts/validate-results-quality.mjs --current results.json [--previous previous-results.json] [--label maisons]");
  }

  const current = readPayload(args.current);
  const previous = args.previous && fs.existsSync(args.previous) ? readPayload(args.previous) : null;
  const currentListings = listingsOf(current);
  const previousListings = listingsOf(previous);
  const currentCounts = countBySource(currentListings);
  const previousCounts = countBySource(previousListings);
  const currentImmoweb = sourceCount(currentCounts, (source) => source.includes("immoweb"));
  const previousImmoweb = sourceCount(previousCounts, (source) => source.includes("immoweb"));
  const context = {
    label: args.label,
    current: { generatedAt: current.generatedAt || null, count: currentListings.length, bySource: currentCounts },
    previous: previous ? { generatedAt: previous.generatedAt || null, count: previousListings.length, bySource: previousCounts } : null
  };

  if (currentListings.length < args.minTotal) {
    fail(`${args.label}: collecte vide ou quasi vide refusee`, context);
  }

  if (previousListings.length > 0 && currentListings.length < previousListings.length * (1 - args.maxTotalDropRatio)) {
    fail(`${args.label}: chute totale anormale refusee`, context);
  }

  if (previousImmoweb >= args.minImmowebWhenPrevious) {
    const minimumExpected = Math.max(args.minImmowebWhenPrevious, Math.floor(previousImmoweb * (1 - args.maxImmowebDropRatio)));
    if (currentImmoweb < minimumExpected) {
      fail(`${args.label}: chute Immoweb anormale refusee`, {
        ...context,
        minimumExpectedImmoweb: minimumExpected
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    label: args.label,
    count: currentListings.length,
    bySource: currentCounts
  }, null, 2));
}

validate();
