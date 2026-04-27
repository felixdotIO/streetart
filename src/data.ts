import proj4 from "proj4";
import type { NameProposal, Platform, PrideVote, RatingInput, RatingRecord } from "./types";

const PLATFORM_CACHE_KEY = "gleisbewertung-platform-cache-v3";
const PLATFORM_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SBB_DATASET_ID = "21197_behig-haltekantesegment";

export const sbbApiUrl =
  `https://data.sbb.ch/api/v2/catalog/datasets/${SBB_DATASET_ID}/exports/json`;

export const seedPlatforms: Platform[] = [];

export const initialRatings: RatingRecord[] = [];

export const initialProposals: NameProposal[] = [];

export const emptyRatingDraft: RatingInput = {
  vibe: 0,
  refuel: 0,
  seating: 0,
  pride: "complicated",
  umbrella: false,
  comment: "",
};

type SbbRecord = {
  bezeichnung_offiziell?: string;
  bps?: string;
  kundengleisnr?: string | number;
  perron_nr?: string | number;
  geopos?: {
    lon?: number;
    lat?: number;
  };
  e?: number | string;
  n?: number | string;
  [key: string]:
    | string
    | number
    | undefined
    | {
        lon?: number;
        lat?: number;
      };
};

proj4.defs(
  "EPSG:2056",
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs",
);

function asNumber(value: number | string | undefined) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toWgs84(x: number, y: number) {
  const [lng, lat] = proj4("EPSG:2056", "EPSG:4326", [x, y]);
  return { lat, lng };
}

function normalizePlatformId(stationCode: string, platform: string) {
  return `${stationCode}-${platform}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function comparePlatforms(left: Platform, right: Platform) {
  return (
    left.stationName.localeCompare(right.stationName, "de-CH") ||
    left.stationCode.localeCompare(right.stationCode, "de-CH") ||
    left.platform.localeCompare(right.platform, "de-CH", { numeric: true })
  );
}

function parseCachedPlatforms() {
  const raw = localStorage.getItem(PLATFORM_CACHE_KEY);

  if (!raw) {
    return null;
  }

  const cached = JSON.parse(raw) as { fetchedAt: number; platforms: Platform[] };
  if (Date.now() - cached.fetchedAt > PLATFORM_CACHE_TTL_MS) {
    return null;
  }

  return cached.platforms;
}

function writePlatformCache(platforms: Platform[]) {
  localStorage.setItem(
    PLATFORM_CACHE_KEY,
    JSON.stringify({ fetchedAt: Date.now(), platforms }),
  );
}

function mapSbbRecords(records: SbbRecord[]) {
  const deduped = new Map<string, Platform>();

  for (const record of records) {
    const stationName = record.bezeichnung_offiziell?.toString().trim();
    const stationCode = (record.bps ?? record["BPS"])?.toString().trim();
    const platformValue = record.kundengleisnr ?? record.perron_nr;
    const platform = platformValue !== undefined ? String(platformValue).trim() : undefined;
    const x = asNumber(record.e);
    const y = asNumber(record.n);
    const geoposLat = record.geopos?.lat;
    const geoposLng = record.geopos?.lon;

    if (!stationName || !stationCode || !platform) {
      continue;
    }

    const id = normalizePlatformId(stationCode, platform);
    deduped.set(id, {
      id,
      stationName,
      stationCode,
      platform,
      coordinates:
        geoposLat !== undefined && geoposLng !== undefined
          ? {
              start: { lat: geoposLat, lng: geoposLng },
              end: { lat: geoposLat, lng: geoposLng },
            }
          : x !== undefined && y !== undefined
            ? {
                start: toWgs84(x, y),
                end: toWgs84(x, y),
              }
          : undefined,
    });
  }

  return Array.from(deduped.values()).sort(comparePlatforms);
}

async function fetchSbbPlatforms() {
  const response = await fetch(sbbApiUrl);

  if (!response.ok) {
    throw new Error(`SBB request failed with ${response.status}`);
  }

  const payload = (await response.json()) as SbbRecord[];
  return mapSbbRecords(payload);
}

export async function loadPlatforms() {
  const cached = parseCachedPlatforms();
  if (cached?.length) {
    return {
      platforms: cached,
      source: "sbb-cache" as const,
    };
  }

  try {
    const platforms = await fetchSbbPlatforms();
    if (platforms.length) {
      writePlatformCache(platforms);
      return {
        platforms,
        source: "sbb-live" as const,
      };
    }
    throw new Error("SBB returned no platform edges.");
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to load SBB platform edges.");
  }
}
