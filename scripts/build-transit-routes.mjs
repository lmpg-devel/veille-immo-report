import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache", "gtfs");
const RESULTS_PATH = path.join(ROOT, "results.json");
const OUTPUT_PATH = path.join(ROOT, "data", "transit-routes.json");
const OSM_RAIL_CACHE_PATH = path.join(CACHE_DIR, "osm-railways.json");
const OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const ROUTE_REFERENCES = [
  { key: "bourse", label: "Bourse", lat: 50.8478282, lon: 4.3491201 },
  { key: "decoster", label: "Travail", lat: 50.8230517, lon: 4.3297564 }
];

const FEEDS = {
  sncb: {
    key: "sncb",
    label: "SNCB",
    kind: "train",
    url: "https://gtfs.flatturtle.cloud/sncb-nmbs/sncb-nmbs-gtfs_2026-06-10.zip"
  },
  stib: {
    key: "stib",
    label: "STIB",
    kind: "stib",
    url: "https://gtfs.flatturtle.cloud/stib-mivb/stib-mivb-gtfs_2026-06-19.zip"
  },
  delijn: {
    key: "delijn",
    label: "De Lijn",
    kind: "delijn",
    url: "https://gtfs.flatturtle.cloud/delijn/delijn-gtfs_2026-06-06.zip"
  },
  tec: {
    key: "tec",
    label: "TEC",
    kind: "tec",
    url: "https://gtfs.flatturtle.cloud/tec/tec-gtfs_2024-04-05.zip"
  }
};

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) {
      args[match[1]] = match[2];
    } else if (arg.startsWith("--")) {
      args[arg.slice(2)] = true;
    }
  });
  return args;
}

const args = parseArgs(process.argv);
const feedKeys = String(args.feeds || "sncb,stib,delijn,tec")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter((value) => FEEDS[value]);
const maxListings = Number.isFinite(Number(args.maxListings || args["max-listings"]))
  ? Number(args.maxListings || args["max-listings"])
  : Infinity;

function csvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"") {
        if (line[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === ",") {
      values.push(current);
      current = "";
    } else if (char === "\"") {
      quoted = true;
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function rowObject(header, values) {
  const row = {};
  header.forEach((name, index) => {
    row[name] = values[index] == null ? "" : values[index];
  });
  return row;
}

async function readCsvRows(filePath, onRow) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let rowIndex = 0;
  for await (const line of rl) {
    if (line.trim() === "") {
      continue;
    }
    if (!header) {
      header = csvLine(line).map((name) => name.replace(/^\uFEFF/, ""));
      continue;
    }
    rowIndex += 1;
    await onRow(rowObject(header, csvLine(line)), rowIndex);
  }
}

function listingUrlKey(url) {
  const raw = String(url || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw, "https://lmpg-devel.github.io/veille-immo-report/");
    return (parsed.origin + parsed.pathname).toLowerCase();
  } catch {
    return raw.split(/[?#]/)[0].toLowerCase();
  }
}

function listingKey(listing) {
  return listingUrlKey(listing && listing.url) || String(listing && listing.id || "").trim().toLowerCase();
}

function numberValue(value) {
  const number = Number(String(value == null ? "" : value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const radius = 6371;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inBbox(lat, lon, bbox) {
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

function computeBbox(listings) {
  if (args.bbox) {
    const parts = String(args.bbox).split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
    }
  }
  const points = ROUTE_REFERENCES.concat(listings.map((listing) => ({
    lat: Number(listing.latitude),
    lon: Number(listing.longitude)
  }))).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  const margin = 0.055;
  return {
    south: Math.max(49.9, Math.min(...points.map((point) => point.lat)) - margin),
    west: Math.max(2.4, Math.min(...points.map((point) => point.lon)) - margin),
    north: Math.min(51.8, Math.max(...points.map((point) => point.lat)) + margin),
    east: Math.min(6.5, Math.max(...points.map((point) => point.lon)) + margin)
  };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function downloadFile(url, filePath) {
  if (fileExists(filePath) && !args.refresh) {
    return;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  await ensureDir(path.dirname(filePath));
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(filePath, buffer);
}

async function fetchOverpass(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const url = `${endpoint}?data=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Overpass indisponible");
}

async function loadRailwayOsm(bbox) {
  if (fileExists(OSM_RAIL_CACHE_PATH) && !args.refresh) {
    const cached = JSON.parse(await fsp.readFile(OSM_RAIL_CACHE_PATH, "utf8"));
    if (cached && Array.isArray(cached.elements)) {
      return cached;
    }
  }
  const query = [
    "[out:json][timeout:90];",
    "way[\"railway\"=\"rail\"](",
    [bbox.south, bbox.west, bbox.north, bbox.east].join(","),
    ");",
    "out tags geom;"
  ].join("");
  const data = await fetchOverpass(query);
  await ensureDir(path.dirname(OSM_RAIL_CACHE_PATH));
  await fsp.writeFile(OSM_RAIL_CACHE_PATH, JSON.stringify(data));
  return data;
}

function expandArchive(zipPath, outDir) {
  if (fileExists(path.join(outDir, "stops.txt")) && !args.refresh) {
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(outDir)} -Force`
  ].join(" ");
  childProcess.execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdio: "pipe"
  });
}

function feedZipPath(feed) {
  return path.join(CACHE_DIR, `${feed.key}.zip`);
}

function feedExtractDir(feed) {
  return path.join(CACHE_DIR, feed.key);
}

function routeKind(feed, route) {
  if (feed.key === "sncb") {
    return "train";
  }
  if (feed.key === "stib") {
    return "stib";
  }
  if (feed.key === "delijn") {
    return "delijn";
  }
  if (feed.key === "tec") {
    return "tec";
  }
  const type = Number(route && route.route_type);
  if (type === 2) {
    return "train";
  }
  return feed.kind || "other";
}

function routeLabel(feed, route) {
  const shortName = String(route && route.route_short_name || "").trim();
  const longName = String(route && route.route_long_name || "").trim();
  return [feed.label, shortName || longName].filter(Boolean).join(" ");
}

async function loadStops(feed, dir, bbox) {
  const stops = new Map();
  const rawToPrefixed = new Map();
  await readCsvRows(path.join(dir, "stops.txt"), (row) => {
    const lat = numberValue(row.stop_lat);
    const lon = numberValue(row.stop_lon);
    if (lat == null || lon == null || !inBbox(lat, lon, bbox)) {
      return;
    }
    const rawId = String(row.stop_id || "").trim();
    if (!rawId) {
      return;
    }
    const id = `${feed.key}:${rawId}`;
    const stop = {
      id,
      rawId,
      feed: feed.key,
      kind: feed.kind,
      name: String(row.stop_name || rawId).trim(),
      lat,
      lon
    };
    stops.set(id, stop);
    rawToPrefixed.set(rawId, id);
  });
  return { stops, rawToPrefixed };
}

async function loadRoutes(feed, dir) {
  const routes = new Map();
  await readCsvRows(path.join(dir, "routes.txt"), (row) => {
    const id = String(row.route_id || "").trim();
    if (!id) {
      return;
    }
    routes.set(id, {
      id,
      kind: routeKind(feed, row),
      label: routeLabel(feed, row),
      shortName: String(row.route_short_name || "").trim(),
      longName: String(row.route_long_name || "").trim()
    });
  });
  return routes;
}

async function loadTrips(dir, routes) {
  const trips = new Map();
  await readCsvRows(path.join(dir, "trips.txt"), (row) => {
    const tripId = String(row.trip_id || "").trim();
    const routeId = String(row.route_id || "").trim();
    if (!tripId || !routes.has(routeId)) {
      return;
    }
    trips.set(tripId, {
      routeId,
      shapeId: String(row.shape_id || "").trim()
    });
  });
  return trips;
}

async function loadRelevantStopTimes(dir, trips, rawToPrefixed) {
  const byTrip = new Map();
  await readCsvRows(path.join(dir, "stop_times.txt"), (row) => {
    const tripId = String(row.trip_id || "").trim();
    if (!trips.has(tripId)) {
      return;
    }
    const stopId = rawToPrefixed.get(String(row.stop_id || "").trim());
    if (!stopId) {
      return;
    }
    const seq = numberValue(row.stop_sequence);
    if (seq == null) {
      return;
    }
    if (!byTrip.has(tripId)) {
      byTrip.set(tripId, []);
    }
    byTrip.get(tripId).push({
      stopId,
      seq,
      dist: numberValue(row.shape_dist_traveled)
    });
  });
  return byTrip;
}

function addOrImproveEdge(edgeMap, edge) {
  if (edge.from === edge.to) {
    return;
  }
  const key = `${edge.from}|${edge.to}|${edge.routeId}|${edge.shapeId || ""}`;
  const existing = edgeMap.get(key);
  if (!existing || edge.stopCount < existing.stopCount) {
    edgeMap.set(key, edge);
  }
}

function buildFeedEdges(feed, stops, routes, trips, byTrip) {
  const edgeMap = new Map();
  const usedShapeIds = new Set();
  for (const [tripId, rows] of byTrip.entries()) {
    if (rows.length < 2) {
      continue;
    }
    const trip = trips.get(tripId);
    const route = routes.get(trip.routeId);
    if (!route) {
      continue;
    }
    rows.sort((a, b) => a.seq - b.seq);
    for (let index = 1; index < rows.length; index += 1) {
      const fromRow = rows[index - 1];
      const toRow = rows[index];
      const fromStop = stops.get(fromRow.stopId);
      const toStop = stops.get(toRow.stopId);
      if (!fromStop || !toStop) {
        continue;
      }
      const distanceKm = haversineKm(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon);
      const stopCount = Math.max(1, Math.round(Math.abs(toRow.seq - fromRow.seq)));
      if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 24 || stopCount > 35) {
        continue;
      }
      if (trip.shapeId) {
        usedShapeIds.add(trip.shapeId);
      }
      addOrImproveEdge(edgeMap, {
        from: fromRow.stopId,
        to: toRow.stopId,
        routeId: trip.routeId,
        shapeId: trip.shapeId,
        kind: route.kind,
        label: route.label,
        feed: feed.key,
        stopCount,
        fromDist: fromRow.dist,
        toDist: toRow.dist
      });
    }
  }
  return { edges: Array.from(edgeMap.values()), usedShapeIds };
}

async function loadShapes(dir, usedShapeIds) {
  const shapes = new Map();
  const filePath = path.join(dir, "shapes.txt");
  if (!fileExists(filePath) || !usedShapeIds.size) {
    return shapes;
  }
  await readCsvRows(filePath, (row) => {
    const shapeId = String(row.shape_id || "").trim();
    if (!usedShapeIds.has(shapeId)) {
      return;
    }
    const lat = numberValue(row.shape_pt_lat);
    const lon = numberValue(row.shape_pt_lon);
    const seq = numberValue(row.shape_pt_sequence);
    if (lat == null || lon == null || seq == null) {
      return;
    }
    if (!shapes.has(shapeId)) {
      shapes.set(shapeId, []);
    }
    shapes.get(shapeId).push({
      lat,
      lon,
      seq,
      dist: numberValue(row.shape_dist_traveled)
    });
  });
  for (const points of shapes.values()) {
    points.sort((a, b) => a.seq - b.seq);
  }
  return shapes;
}

function nearestShapeIndex(points, stop) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = haversineKm(point.lat, point.lon, stop.lat, stop.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function thinPoints(points) {
  if (points.length <= 2) {
    return points;
  }
  const thinned = [points[0]];
  let last = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    if (haversineKm(last[0], last[1], current[0], current[1]) >= 0.08) {
      thinned.push(current);
      last = current;
    }
  }
  thinned.push(points[points.length - 1]);
  return thinned;
}

function buildRailGraph(osm) {
  const nodes = new Map();
  const edgeKeys = new Set();
  const graph = {
    nodes,
    edgeCount: 0,
    pathCache: new Map(),
    nearestCache: new Map()
  };
  function getNode(key, lat, lon) {
    if (!nodes.has(key)) {
      nodes.set(key, { key, lat, lon, edges: [] });
    }
    return nodes.get(key);
  }
  function addEdge(a, b) {
    if (!a || !b || a.key === b.key) {
      return;
    }
    const key = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (!Number.isFinite(km) || km <= 0 || km > 5) {
      return;
    }
    a.edges.push({ to: b.key, km });
    b.edges.push({ to: a.key, km });
    graph.edgeCount += 2;
  }
  (Array.isArray(osm && osm.elements) ? osm.elements : []).forEach((element) => {
    const geometry = Array.isArray(element.geometry) ? element.geometry : [];
    if (geometry.length < 2) {
      return;
    }
    const nodeIds = Array.isArray(element.nodes) ? element.nodes : [];
    let previous = null;
    geometry.forEach((point, index) => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return;
      }
      const key = nodeIds[index] != null
        ? `n${nodeIds[index]}`
        : `${lat.toFixed(6)},${lon.toFixed(6)}`;
      const node = getNode(key, lat, lon);
      if (previous) {
        addEdge(previous, node);
      }
      previous = node;
    });
  });
  return graph;
}

function nearestRailNode(railGraph, stop, maxKm = 1.5) {
  if (!railGraph || !railGraph.nodes || !stop) {
    return null;
  }
  if (railGraph.nearestCache.has(stop.id)) {
    return railGraph.nearestCache.get(stop.id);
  }
  let best = null;
  let bestKm = Infinity;
  for (const node of railGraph.nodes.values()) {
    const km = haversineKm(stop.lat, stop.lon, node.lat, node.lon);
    if (km < bestKm) {
      best = node;
      bestKm = km;
    }
  }
  const result = best && bestKm <= maxKm ? { node: best, distanceKm: bestKm } : null;
  railGraph.nearestCache.set(stop.id, result);
  return result;
}

function shortestRailPath(railGraph, startKey, endKey) {
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ key: startKey, priority: 0 });
  while (heap.items.length) {
    const current = heap.pop();
    if (!current || current.priority !== distances.get(current.key)) {
      continue;
    }
    if (current.key === endKey) {
      break;
    }
    const node = railGraph.nodes.get(current.key);
    if (!node) {
      continue;
    }
    node.edges.forEach((edge) => {
      const nextDistance = current.priority + edge.km;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, current.key);
        heap.push({ key: edge.to, priority: nextDistance });
      }
    });
  }
  if (!Number.isFinite(distances.get(endKey))) {
    return null;
  }
  const keys = [];
  let current = endKey;
  while (current !== startKey) {
    keys.push(current);
    current = previous.get(current);
    if (!current) {
      return null;
    }
  }
  keys.push(startKey);
  keys.reverse();
  return {
    distanceKm: distances.get(endKey),
    points: keys.map((key) => {
      const node = railGraph.nodes.get(key);
      return [node.lat, node.lon];
    })
  };
}

function railEdgeGeometry(edge, stops, railGraph) {
  if (!railGraph || !railGraph.nodes || !railGraph.nodes.size) {
    return [];
  }
  const fromStop = stops.get(edge.from);
  const toStop = stops.get(edge.to);
  if (!fromStop || !toStop) {
    return [];
  }
  const cacheKey = `${edge.from}|${edge.to}`;
  const reverseCacheKey = `${edge.to}|${edge.from}`;
  if (railGraph.pathCache.has(cacheKey)) {
    return railGraph.pathCache.get(cacheKey);
  }
  if (railGraph.pathCache.has(reverseCacheKey)) {
    const reversed = railGraph.pathCache.get(reverseCacheKey).slice().reverse();
    railGraph.pathCache.set(cacheKey, reversed);
    return reversed;
  }
  const start = nearestRailNode(railGraph, fromStop);
  const end = nearestRailNode(railGraph, toStop);
  if (!start || !end) {
    railGraph.pathCache.set(cacheKey, []);
    return [];
  }
  const path = shortestRailPath(railGraph, start.node.key, end.node.key);
  if (!path || !Array.isArray(path.points) || path.points.length < 2) {
    railGraph.pathCache.set(cacheKey, []);
    return [];
  }
  const directKm = haversineKm(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon);
  if (Number.isFinite(directKm) && path.distanceKm > Math.max(12, directKm * 3.8)) {
    railGraph.pathCache.set(cacheKey, []);
    return [];
  }
  const points = thinPoints(path.points);
  railGraph.pathCache.set(cacheKey, points);
  return points;
}

function edgeGeometry(edge, stops, shapesByFeed, railGraph) {
  const fromStop = stops.get(edge.from);
  const toStop = stops.get(edge.to);
  if (!fromStop || !toStop) {
    return [];
  }
  const shape = edge.shapeId ? shapesByFeed.get(`${edge.feed}:${edge.shapeId}`) : null;
  if (!shape || shape.length < 2) {
    if (edge.kind === "train") {
      return railEdgeGeometry(edge, stops, railGraph);
    }
    return [[fromStop.lat, fromStop.lon], [toStop.lat, toStop.lon]];
  }

  let startIndex = -1;
  let endIndex = -1;
  if (Number.isFinite(edge.fromDist) && Number.isFinite(edge.toDist) && shape.some((point) => Number.isFinite(point.dist))) {
    const fromDist = edge.fromDist;
    const toDist = edge.toDist;
    const min = Math.min(fromDist, toDist);
    const max = Math.max(fromDist, toDist);
    let bestStart = Infinity;
    let bestEnd = Infinity;
    shape.forEach((point, index) => {
      if (!Number.isFinite(point.dist)) {
        return;
      }
      const s = Math.abs(point.dist - fromDist);
      const e = Math.abs(point.dist - toDist);
      if (s < bestStart) {
        bestStart = s;
        startIndex = index;
      }
      if (e < bestEnd) {
        bestEnd = e;
        endIndex = index;
      }
    });
    if (startIndex >= 0 && endIndex >= 0 && startIndex !== endIndex) {
      const sliceStart = Math.min(startIndex, endIndex);
      const sliceEnd = Math.max(startIndex, endIndex);
      const distanceSlice = shape.slice(sliceStart, sliceEnd + 1).filter((point) => {
        return !Number.isFinite(point.dist) || (point.dist >= min && point.dist <= max);
      });
      const points = (distanceSlice.length >= 2 ? distanceSlice : shape.slice(sliceStart, sliceEnd + 1))
        .map((point) => [point.lat, point.lon]);
      return thinPoints(startIndex <= endIndex ? points : points.reverse());
    }
  }

  startIndex = nearestShapeIndex(shape, fromStop);
  endIndex = nearestShapeIndex(shape, toStop);
  if (startIndex < 0 || endIndex < 0 || startIndex === endIndex) {
    return [[fromStop.lat, fromStop.lon], [toStop.lat, toStop.lon]];
  }
  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  const points = shape.slice(first, last + 1).map((point) => [point.lat, point.lon]);
  return thinPoints(startIndex <= endIndex ? points : points.reverse());
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) {
        break;
      }
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) {
      return null;
    }
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) {
          break;
        }
        let child = left;
        if (right < this.items.length && this.items[right].priority < this.items[left].priority) {
          child = right;
        }
        if (this.items[child].priority >= last.priority) {
          break;
        }
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function buildGraph(edges) {
  const adjacency = new Map();
  edges.forEach((edge) => {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from).push(edge);
  });
  return adjacency;
}

function addTransferEdges(stops, edges) {
  const bucketSize = 0.003;
  const buckets = new Map();
  for (const stop of stops.values()) {
    const key = `${Math.floor(stop.lon / bucketSize)},${Math.floor(stop.lat / bucketSize)}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(stop);
  }
  const seen = new Set();
  let added = 0;
  for (const stop of stops.values()) {
    const x = Math.floor(stop.lon / bucketSize);
    const y = Math.floor(stop.lat / bucketSize);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = buckets.get(`${x + dx},${y + dy}`);
        if (!bucket) {
          continue;
        }
        bucket.forEach((other) => {
          if (other.id === stop.id) {
            return;
          }
          const pair = stop.id < other.id ? `${stop.id}|${other.id}` : `${other.id}|${stop.id}`;
          if (seen.has(pair)) {
            return;
          }
          seen.add(pair);
          const km = haversineKm(stop.lat, stop.lon, other.lat, other.lon);
          if (km <= 0.25) {
            edges.push({
              from: stop.id,
              to: other.id,
              kind: "walk",
              label: "Correspondance",
              feed: "walk",
              stopCount: 1,
              points: [[stop.lat, stop.lon], [other.lat, other.lon]]
            });
            edges.push({
              from: other.id,
              to: stop.id,
              kind: "walk",
              label: "Correspondance",
              feed: "walk",
              stopCount: 1,
              points: [[other.lat, other.lon], [stop.lat, stop.lon]]
            });
            added += 2;
          }
        });
      }
    }
  }
  return added;
}

function nearestStop(stops, point, maxKm = 2.0) {
  let best = null;
  let bestKm = Infinity;
  for (const stop of stops.values()) {
    const km = haversineKm(point.lat, point.lon, stop.lat, stop.lon);
    if (km < bestKm) {
      best = stop;
      bestKm = km;
    }
  }
  if (!best || bestKm > maxKm) {
    return null;
  }
  return { stop: best, distanceKm: bestKm };
}

function shortestPath(adjacency, startId, endId) {
  const distances = new Map([[startId, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ key: startId, priority: 0 });
  while (heap.items.length) {
    const current = heap.pop();
    if (!current || current.priority !== distances.get(current.key)) {
      continue;
    }
    if (current.key === endId) {
      break;
    }
    const edges = adjacency.get(current.key) || [];
    edges.forEach((edge) => {
      const weight = Math.max(1, Number(edge.stopCount || 1));
      const nextDistance = current.priority + weight;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, { from: current.key, edge });
        heap.push({ key: edge.to, priority: nextDistance });
      }
    });
  }
  if (!Number.isFinite(distances.get(endId))) {
    return null;
  }
  const edges = [];
  let current = endId;
  while (current !== startId) {
    const step = previous.get(current);
    if (!step) {
      return null;
    }
    edges.push(step.edge);
    current = step.from;
  }
  edges.reverse();
  return { stopCount: distances.get(endId), edges };
}

function compactPoint(point) {
  return [Number(point[0].toFixed(5)), Number(point[1].toFixed(5))];
}

function mergeParts(parts) {
  const merged = [];
  parts.forEach((part) => {
    const last = merged[merged.length - 1];
    if (last && last.kind === part.kind && last.label === part.label) {
      last.points = last.points.concat(part.points.slice(1));
      return;
    }
    merged.push(part);
  });
  return merged;
}

function stopConnector(type, stop, lineLabel) {
  if (!stop) {
    return null;
  }
  return {
    type,
    name: stop.name,
    feed: stop.feed,
    line: lineLabel || "",
    lat: Number(stop.lat.toFixed(5)),
    lon: Number(stop.lon.toFixed(5))
  };
}

function connectorKey(connector) {
  return [
    connector && connector.type,
    connector && connector.name,
    connector && connector.lat,
    connector && connector.lon,
    connector && connector.line
  ].join("|");
}

function addConnector(connectors, connector) {
  if (!connector) {
    return;
  }
  const key = connectorKey(connector);
  if (connectors.some((existing) => connectorKey(existing) === key)) {
    return;
  }
  connectors.push(connector);
}

function walkPart(label, fromPoint, toPoint) {
  if (!fromPoint || !toPoint) {
    return null;
  }
  const points = [
    compactPoint([fromPoint.lat, fromPoint.lon]),
    compactPoint([toPoint.lat, toPoint.lon])
  ];
  if (points[0][0] === points[1][0] && points[0][1] === points[1][1]) {
    return null;
  }
  return {
    kind: "walk",
    label,
    points
  };
}

function pathToRoute(path, originNearest, destinationNearest, stops, shapesByFeed, railGraph, originPoint, destinationPoint) {
  const parts = [];
  const connectors = [];
  let missingRequiredGeometry = false;
  let firstTransitEdge = null;
  let lastTransitEdge = null;
  let previousTransitLine = "";
  path.edges.forEach((edge) => {
    const points = edge.points || edgeGeometry(edge, stops, shapesByFeed, railGraph);
    if (!Array.isArray(points) || points.length < 2) {
      if (edge.kind !== "walk") {
        missingRequiredGeometry = true;
      }
      return;
    }
    parts.push({
      kind: edge.kind || "other",
      label: edge.label || edge.kind || "TC",
      points: points.map(compactPoint)
    });
    if (edge.kind !== "walk") {
      const currentLine = `${edge.kind}|${edge.label}`;
      const fromStop = stops.get(edge.from);
      if (!firstTransitEdge) {
        firstTransitEdge = edge;
        addConnector(connectors, stopConnector("depart", fromStop, edge.label));
      } else if (currentLine !== previousTransitLine) {
        addConnector(connectors, stopConnector("change", fromStop, edge.label));
      }
      previousTransitLine = currentLine;
      lastTransitEdge = edge;
    }
  });
  if (missingRequiredGeometry) {
    return null;
  }
  if (firstTransitEdge && originPoint && originNearest && originNearest.stop) {
    const originWalk = walkPart("Marche depart", originPoint, originNearest.stop);
    if (originWalk) {
      parts.unshift(originWalk);
    }
  }
  if (lastTransitEdge) {
    addConnector(connectors, stopConnector("arrivee", stops.get(lastTransitEdge.to), lastTransitEdge.label));
  }
  if (destinationPoint && destinationNearest && destinationNearest.stop) {
    const destinationWalk = walkPart("Marche arrivee", destinationNearest.stop, destinationPoint);
    if (destinationWalk) {
      parts.push(destinationWalk);
    }
  }
  const displayParts = mergeParts(parts).filter((part) => {
    return Array.isArray(part.points) && part.points.length >= 2;
  });
  if (!displayParts.length) {
    return null;
  }
  let transfers = -1;
  let previousLine = "";
  path.edges.forEach((edge) => {
    if (edge.kind === "walk") {
      return;
    }
    const line = `${edge.kind}|${edge.label}`;
    if (line !== previousLine) {
      transfers += 1;
      previousLine = line;
    }
  });
  return {
    available: true,
    rule: "nearest-stop-least-stops",
    stopCount: Math.round(path.stopCount),
    transfers: Math.max(0, transfers),
    originStop: {
      name: originNearest.stop.name,
      feed: originNearest.stop.feed,
      distanceM: Math.round(originNearest.distanceKm * 1000)
    },
    destinationStop: {
      name: destinationNearest.stop.name,
      feed: destinationNearest.stop.feed,
      distanceM: Math.round(destinationNearest.distanceKm * 1000)
    },
    connectors,
    parts: displayParts
  };
}

async function loadFeed(feed, bbox) {
  const zipPath = feedZipPath(feed);
  const dir = feedExtractDir(feed);
  console.log(`[gtfs] ${feed.label}: download/cache`);
  await downloadFile(feed.url, zipPath);
  console.log(`[gtfs] ${feed.label}: extract`);
  expandArchive(zipPath, dir);
  console.log(`[gtfs] ${feed.label}: stops`);
  const { stops, rawToPrefixed } = await loadStops(feed, dir, bbox);
  console.log(`[gtfs] ${feed.label}: ${stops.size} stops in bbox`);
  console.log(`[gtfs] ${feed.label}: routes`);
  const routes = await loadRoutes(feed, dir);
  console.log(`[gtfs] ${feed.label}: trips`);
  const trips = await loadTrips(dir, routes);
  console.log(`[gtfs] ${feed.label}: stop_times`);
  const stopTimes = await loadRelevantStopTimes(dir, trips, rawToPrefixed);
  console.log(`[gtfs] ${feed.label}: ${stopTimes.size} trips with regional stops`);
  const built = buildFeedEdges(feed, stops, routes, trips, stopTimes);
  console.log(`[gtfs] ${feed.label}: ${built.edges.length} edges, ${built.usedShapeIds.size} shapes`);
  console.log(`[gtfs] ${feed.label}: shapes`);
  const shapes = await loadShapes(dir, built.usedShapeIds);
  const prefixedShapes = new Map();
  for (const [shapeId, points] of shapes.entries()) {
    prefixedShapes.set(`${feed.key}:${shapeId}`, points);
  }
  return {
    stops,
    edges: built.edges,
    shapes: prefixedShapes,
    diagnostics: {
      feed: feed.key,
      label: feed.label,
      url: feed.url,
      stops: stops.size,
      edges: built.edges.length,
      shapes: shapes.size
    }
  };
}

async function main() {
  const rawPayload = JSON.parse(await fsp.readFile(RESULTS_PATH, "utf8"));
  const listings = (Array.isArray(rawPayload.listings) ? rawPayload.listings : [])
    .filter((listing) => Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude)))
    .slice(0, maxListings);
  const bbox = computeBbox(listings);
  await ensureDir(path.dirname(OUTPUT_PATH));
  await ensureDir(CACHE_DIR);
  const allStops = new Map();
  const allEdges = [];
  const allShapes = new Map();
  const diagnostics = [];
  console.log("[osm] railway graph");
  const railOsm = await loadRailwayOsm(bbox);
  const railGraph = buildRailGraph(railOsm);
  console.log(`[osm] rail ways=${Array.isArray(railOsm.elements) ? railOsm.elements.length : 0} nodes=${railGraph.nodes.size} edges=${railGraph.edgeCount}`);

  for (const key of feedKeys) {
    const feed = FEEDS[key];
    const loaded = await loadFeed(feed, bbox);
    for (const [id, stop] of loaded.stops.entries()) {
      allStops.set(id, stop);
    }
    loaded.edges.forEach((edge) => allEdges.push(edge));
    for (const [id, shape] of loaded.shapes.entries()) {
      allShapes.set(id, shape);
    }
    diagnostics.push(loaded.diagnostics);
  }

  const transferEdges = addTransferEdges(allStops, allEdges);
  const adjacency = buildGraph(allEdges);
  const referenceStops = {};
  ROUTE_REFERENCES.forEach((reference) => {
    referenceStops[reference.key] = nearestStop(allStops, reference, 2.0);
  });

  const routes = {};
  let computedRoutes = 0;
  let unavailableRoutes = 0;
  for (const listing of listings) {
    const key = listingKey(listing);
    if (!key) {
      continue;
    }
    const destination = { lat: Number(listing.latitude), lon: Number(listing.longitude) };
    const destNearest = nearestStop(allStops, destination, 2.0);
    routes[key] = {};
    for (const reference of ROUTE_REFERENCES) {
      const originNearest = referenceStops[reference.key];
      if (!originNearest || !destNearest) {
        routes[key][reference.key] = { available: false, reason: "nearest-stop-missing" };
        unavailableRoutes += 1;
        continue;
      }
      const path = shortestPath(adjacency, originNearest.stop.id, destNearest.stop.id);
      if (!path) {
        routes[key][reference.key] = {
          available: false,
          reason: "no-path",
          originStop: originNearest.stop.name,
          destinationStop: destNearest.stop.name
        };
        unavailableRoutes += 1;
        continue;
      }
      const route = pathToRoute(path, originNearest, destNearest, allStops, allShapes, railGraph, reference, destination);
      if (!route) {
        routes[key][reference.key] = { available: false, reason: "no-displayable-shape" };
        unavailableRoutes += 1;
        continue;
      }
      routes[key][reference.key] = route;
      computedRoutes += 1;
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rule: "nearest stop for origin and listing, shortest path by least stops",
    bbox,
    references: ROUTE_REFERENCES,
    routes,
    diagnostics: {
      listings: listings.length,
      stops: allStops.size,
      edges: allEdges.length,
      transferEdges,
      railWays: Array.isArray(railOsm.elements) ? railOsm.elements.length : 0,
      railNodes: railGraph.nodes.size,
      railEdges: railGraph.edgeCount,
      railPaths: railGraph.pathCache.size,
      computedRoutes,
      unavailableRoutes,
      feeds: diagnostics
    }
  };
  await fsp.writeFile(OUTPUT_PATH, JSON.stringify(output));
  console.log(`[gtfs] wrote ${OUTPUT_PATH}`);
  console.log(`[gtfs] computed ${computedRoutes}, unavailable ${unavailableRoutes}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
