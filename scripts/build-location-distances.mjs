import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "veille-immo.json");
const BOUNDARIES_PATH = path.join(ROOT, "data", "location-boundaries.geojson");
const OUTPUT_PATH = path.join(ROOT, "data", "location-distances.json");
const REF_LAT = 50.85;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON = 111.32 * Math.cos(REF_LAT * Math.PI / 180);
const CELL_KM = 2;

function slugForPath(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function project(point) {
  return {
    lon: Number(point[0]),
    lat: Number(point[1]),
    x: Number(point[0]) * KM_PER_DEG_LON,
    y: Number(point[1]) * KM_PER_DEG_LAT
  };
}

function geometryRings(feature) {
  const geometry = feature && feature.geometry;
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates || [];
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).flat();
  }
  return [];
}

function featurePoints(feature) {
  return geometryRings(feature)
    .flat()
    .map(project)
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function featureSegments(feature) {
  const segments = [];
  geometryRings(feature).forEach((ring) => {
    if (!Array.isArray(ring) || ring.length < 2) {
      return;
    }
    for (let index = 1; index < ring.length; index += 1) {
      const a = project(ring[index - 1]);
      const b = project(ring[index]);
      if (Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        segments.push({
          a,
          b,
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y)
        });
      }
    }
  });
  return segments;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function cellCoord(value) {
  return Math.floor(value / CELL_KM);
}

function buildSegmentIndex(segments) {
  const cells = new Map();
  segments.forEach((segment) => {
    const minX = cellCoord(segment.minX);
    const maxX = cellCoord(segment.maxX);
    const minY = cellCoord(segment.minY);
    const maxY = cellCoord(segment.maxY);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = cellKey(x, y);
        if (!cells.has(key)) {
          cells.set(key, []);
        }
        cells.get(key).push(segment);
      }
    }
  });
  return { cells, segments };
}

function pointSegmentDistanceKm(point, segment) {
  const vx = segment.b.x - segment.a.x;
  const vy = segment.b.y - segment.a.y;
  const wx = point.x - segment.a.x;
  const wy = point.y - segment.a.y;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq)) : 0;
  const x = segment.a.x + t * vx;
  const y = segment.a.y + t * vy;
  return Math.hypot(point.x - x, point.y - y);
}

function distanceToIndexedSegments(point, index) {
  const originX = cellCoord(point.x);
  const originY = cellCoord(point.y);
  let best = Infinity;
  const seen = new Set();
  for (let radius = 0; radius <= 40; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
          continue;
        }
        const key = cellKey(originX + dx, originY + dy);
        const bucket = index.cells.get(key);
        if (!bucket) {
          continue;
        }
        bucket.forEach((segment) => {
          if (seen.has(segment)) {
            return;
          }
          seen.add(segment);
          const distance = pointSegmentDistanceKm(point, segment);
          if (distance < best) {
            best = distance;
          }
        });
      }
    }
    if (Number.isFinite(best) && radius * CELL_KM > best + CELL_KM * 2) {
      break;
    }
  }
  return best;
}

function minPointDistance(points, segmentIndex) {
  let best = Infinity;
  points.forEach((point) => {
    const distance = distanceToIndexedSegments(point, segmentIndex);
    if (distance < best) {
      best = distance;
    }
  });
  return best;
}

function isBrusselsCapitalFeature(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  return /bruxelles-capitale|brussels hoofstedelijk/i.test(String(props.displayName || ""));
}

function roundDistance(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Number(value.toFixed(2)));
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const geojson = JSON.parse(await fs.readFile(BOUNDARIES_PATH, "utf8"));
  const features = Array.isArray(geojson.features) ? geojson.features : [];
  const byKey = new Map(features.map((feature) => {
    const props = feature.properties || {};
    return [slugForPath(props.key || props.name || props.postalCode || ""), feature];
  }));
  const brusselsFeatures = features.filter(isBrusselsCapitalFeature);
  const brusselsSegments = brusselsFeatures.flatMap(featureSegments);
  const brusselsPoints = brusselsFeatures.flatMap(featurePoints);
  const brusselsIndex = buildSegmentIndex(brusselsSegments);
  const distances = {};

  (Array.isArray(config.locations) ? config.locations : []).forEach((location) => {
    const key = slugForPath(location.name || location.postalCode || "");
    const feature = byKey.get(key);
    if (!key || !feature) {
      distances[key] = {
        name: location.name || key,
        km: null,
        isBrusselsCapital: false,
        source: "missing-boundary"
      };
      return;
    }
    const isBrusselsCapital = isBrusselsCapitalFeature(feature);
    if (isBrusselsCapital) {
      distances[key] = {
        name: location.name || key,
        km: 0,
        isBrusselsCapital: true,
        source: "osm-boundary"
      };
      return;
    }
    const points = featurePoints(feature);
    const segments = featureSegments(feature);
    const ownIndex = buildSegmentIndex(segments);
    const forward = minPointDistance(points, brusselsIndex);
    const reverse = minPointDistance(brusselsPoints, ownIndex);
    const km = roundDistance(Math.min(forward, reverse));
    distances[key] = {
      name: location.name || key,
      km,
      isBrusselsCapital: false,
      source: "osm-boundary"
    };
  });

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reference: "distance minimale entre les limites communales et les limites de la Region de Bruxelles-Capitale",
    maxSupportedKm: 15,
    brusselsCapitalFeatureCount: brusselsFeatures.length,
    distances
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output));
  const selected15 = Object.values(distances).filter((item) => item.km != null && item.km <= 15).length;
  const selected0 = Object.values(distances).filter((item) => item.km === 0).length;
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Brussels features: ${brusselsFeatures.length}; within 0km: ${selected0}; within 15km: ${selected15}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
