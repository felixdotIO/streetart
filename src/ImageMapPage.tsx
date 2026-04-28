import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

type Pos  = { x: number; y: number };
type Size = { w: number; h: number };

interface OsmNode { type: "node"; id: number; lat: number; lon: number }
interface OsmWay  { type: "way";  id: number; nodes: number[] }
type OverpassEl = OsmNode | OsmWay;

type GJFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { dark: number; phase: "surround" | "fill" };
};
type GJCollection = { type: "FeatureCollection"; features: GJFeature[] };
type Session      = { sourceId: string; layerIds: string[] };

// ── Helpers ───────────────────────────────────────────────────────────────────

async function removeWhiteBg(src: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
          if (r > 230 && g > 230 && b > 230) d.data[i + 3] = 0;
        }
        ctx.putImageData(d, 0, 0);
        resolve(c.toDataURL());
      } catch { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function fetchStreets(s: number, w: number, n: number, e: number): Promise<OverpassEl[]> {
  const q = `[out:json][timeout:30];(way["highway"](${s},${w},${n},${e}););out body;>;out skel qt;`;
  let lastErr = "";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}?data=${encodeURIComponent(q)}`);
      if (res.ok) return (await res.json()).elements;
      lastErr = `${res.status}`;
      if (res.status !== 504 && res.status !== 429) break;
    } catch { lastErr = "network error"; }
  }
  throw new Error(`Overpass failed (${lastErr})`);
}

function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      resolve({ data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function sampleB(data: Uint8ClampedArray, iw: number, ih: number, rx: number, ry: number): number {
  const x = Math.min(iw - 1, Math.floor(rx * iw));
  const y = Math.min(ih - 1, Math.floor(ry * ih));
  const i = (y * iw + x) * 4;
  if (data[i + 3] < 13) return 1;
  return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
}

const CONTENT_THRESHOLD = 0.85;

function clipToContent(
  coords: [number, number][],
  south: number, west: number, latR: number, lngR: number,
  data: Uint8ClampedArray, iw: number, ih: number
): { segments: [number, number][][]; b: number } {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let bSum = 0, bCount = 0;
  for (const [lat, lon] of coords) {
    const rx = (lon - west) / lngR;
    const ry = 1 - (lat - south) / latR;
    const inBounds = rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1;
    const b = inBounds ? sampleB(data, iw, ih, rx, ry) : 1;
    if (inBounds && b < CONTENT_THRESHOLD) {
      current.push([lat, lon]); bSum += b; bCount++;
    } else {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
  }
  if (current.length >= 2) segments.push(current);
  return { segments, b: bCount > 0 ? bSum / bCount : 1 };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImageMapPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<maplibregl.Map | null>(null);
  const mapReadyRef     = useRef(false);
  const abortRef        = useRef(false);
  const finishRef       = useRef(false);

  const sessionsRef    = useRef<Session[]>([]);
  const pixelsRef      = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
  const sessionCounter = useRef(0);

  const posRef         = useRef<Pos>({ x: 0, y: 0 });
  const sizeRef        = useRef<Size>({ w: 300, h: 300 });
  const aspectRatioRef = useRef(1);

  const [imageUrl,  setImageUrl]  = useState<string | null>(null);
  const [pos,       setPos]       = useState<Pos>({ x: 0, y: 0 });
  const [size,      setSize]      = useState<Size>({ w: 300, h: 300 });
  const [status,    setStatus]    = useState<string | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isPrinted, setIsPrinted] = useState(false);
  const [libOpen,   setLibOpen]   = useState(false);
  const [libImages, setLibImages] = useState<string[]>([]);

  const base = import.meta.env.BASE_URL;
  const LIBRARY = [
    { src: `${base}library/Type=Calendar.png`,        label: "Calendar" },
    { src: `${base}library/Type=Map.png`,             label: "Map"      },
    { src: `${base}library/Type=Promotion%20(1).png`,  label: "Sparkle"  },
  ];

  useEffect(() => {
    Promise.all(LIBRARY.map(({ src }) => removeWhiteBg(src))).then(setLibImages);
  }, []);

  type GeoResult = { display_name: string; lat: string; lon: string };
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState<GeoResult[]>([]);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { posRef.current  = pos;  }, [pos]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // ── Map init — starts flat (pitch=0) so image overlay aligns perfectly ────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [8.5417, 47.3769],
      zoom: 14,
      pitch: 0,
      bearing: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    map.once("load", () => {
      // 3D buildings — visible once the map tilts after drawing
      try {
        const sources = map.getStyle().sources as Record<string, { type: string }>;
        const vectorSrc = Object.keys(sources).find(k => sources[k].type === "vector");
        if (vectorSrc) {
          const firstSymbol = map.getStyle().layers.find(l => l.type === "symbol")?.id;
          map.addLayer({
            id: "sa-3d-buildings",
            type: "fill-extrusion",
            source: vectorSrc,
            "source-layer": "building",
            minzoom: 14,
            paint: {
              "fill-extrusion-color":   "#1e2030",
              "fill-extrusion-height":  ["coalesce", ["get", "render_height"], ["get", "height"], 8],
              "fill-extrusion-base":    ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.9,
            },
          }, firstSymbol);
        }
      } catch { /* style doesn't support building extrusion */ }

      mapReadyRef.current = true;
    });

    mapRef.current = map;
    return () => {
      abortRef.current = true;
      map.remove();
      mapRef.current = null;
      mapReadyRef.current = false;
    };
  }, []);

  // Animate camera to 3D when in view mode, back to flat when repositioning
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isPrinted || isDrawing) {
      map.easeTo({ pitch: 45, bearing: -15, duration: 1400, easing: t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t });
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  }, [isPrinted, isDrawing]);

  // ── Location search ───────────────────────────────────────────────────────────
  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`,
          { headers: { "Accept-Language": "en" } }
        );
        setSearchResults(await res.json());
      } catch {}
    }, 350);
  };

  const handleSearchSelect = (r: GeoResult) => {
    mapRef.current?.flyTo({ center: [parseFloat(r.lon), parseFloat(r.lat)], zoom: 14, duration: 1200 });
    setSearchQuery("");
    setSearchResults([]);
  };

  // ── Library select ────────────────────────────────────────────────────────────
  const handleLibrarySelect = (src: string) => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(src);
    setLibOpen(false);
    pixelsRef.current = null;
    clearSessions();
    setIsPrinted(false); setStatus(null);

    const img = new Image();
    img.onload = () => {
      const ar = img.naturalWidth / img.naturalHeight;
      aspectRatioRef.current = ar;
      if (mapContainerRef.current) {
        const { width, height } = mapContainerRef.current.getBoundingClientRect();
        const w = Math.min(320, width * 0.36);
        const h = w / ar;
        const p = { x: width / 2 - w / 2, y: height / 2 - h / 2 };
        const s = { w, h };
        posRef.current = p; sizeRef.current = s;
        setPos(p); setSize(s);
      }
    };
    img.src = src;
  };

  // ── Upload ────────────────────────────────────────────────────────────────────
  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    pixelsRef.current = null;
    clearSessions();
    setIsPrinted(false); setStatus(null);

    const img = new Image();
    img.onload = () => {
      const ar = img.naturalWidth / img.naturalHeight;
      aspectRatioRef.current = ar;
      if (mapContainerRef.current) {
        const { width, height } = mapContainerRef.current.getBoundingClientRect();
        const w = Math.min(320, width * 0.36);
        const h = w / ar;
        const p = { x: width / 2 - w / 2, y: height / 2 - h / 2 };
        const s = { w, h };
        posRef.current = p; sizeRef.current = s;
        setPos(p); setSize(s);
      }
    };
    img.src = url;
  };

  // ── Session helpers ───────────────────────────────────────────────────────────
  const clearSessions = () => {
    const map = mapRef.current;
    sessionsRef.current.forEach(({ sourceId, layerIds }) => {
      if (map) {
        layerIds.forEach(id => { try { map.removeLayer(id); } catch {} });
        try { map.removeSource(sourceId); } catch {}
      }
    });
    sessionsRef.current = [];
  };

  // ── Draw ──────────────────────────────────────────────────────────────────────
  const handleDraw = async () => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !imageUrl || isDrawing) return;

    abortRef.current  = false;
    finishRef.current = false;
    setIsDrawing(true);
    setStatus("Fetching streets…");
    // camera tilt starts via the useEffect above (isDrawing → true)

    const sessionId = `sa-session-${sessionCounter.current++}`;
    const geojson: GJCollection = { type: "FeatureCollection", features: [] };
    let sessionLayers: string[] = [];

    try {
      const { x, y } = posRef.current;
      const { w, h } = sizeRef.current;
      // Bounds must be computed at pitch=0 (before tilt animates)
      // Use the map's current unproject which accounts for actual camera state
      const sw = map.unproject([x,     y + h]);
      const ne = map.unproject([x + w, y    ]);
      const south = sw.lat, west = sw.lng, north = ne.lat, east = ne.lng;
      const latR = north - south, lngR = east - west;

      const elements = await fetchStreets(south, west, north, east);
      if (abortRef.current) return;

      const nodes = new Map<number, [number, number]>();
      for (const el of elements) if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);

      if (!pixelsRef.current) pixelsRef.current = await loadPixels(imageUrl);
      const px = pixelsRef.current;
      if (abortRef.current) return;

      type WayData = { segments: [number, number][][]; b: number };
      const surroundings: WayData[] = [], fill: WayData[] = [];

      for (const el of elements) {
        if (el.type !== "way") continue;
        const allCoords: [number, number][] = [];
        for (const id of el.nodes) { const n = nodes.get(id); if (n) allCoords.push(n); }
        if (allCoords.length < 2) continue;
        const { segments, b } = clipToContent(allCoords, south, west, latR, lngR, px.data, px.w, px.h);
        if (segments.length === 0) continue;
        (b < 0.45 ? surroundings : fill).push({ segments, b });
      }
      surroundings.sort((a, b) => a.b - b.b);
      fill.sort((a, b) => a.b - b.b);

      setStatus(`Drawing ${surroundings.length + fill.length} streets…`);

      map.addSource(sessionId, { type: "geojson", data: geojson });
      map.addLayer({
        id: `${sessionId}-surround`, type: "line", source: sessionId,
        filter: ["==", ["get", "phase"], "surround"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color":   "#ffffff",
          "line-opacity": ["interpolate", ["linear"], ["get", "dark"], 0, 0.15, 1, 0.95],
          "line-width":   ["interpolate", ["linear"], ["get", "dark"], 0, 0.5,  1, 3.0 ],
        },
      });
      map.addLayer({
        id: `${sessionId}-fill`, type: "line", source: sessionId,
        filter: ["==", ["get", "phase"], "fill"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color":   "#ffffff",
          "line-opacity": ["interpolate", ["linear"], ["get", "dark"], 0, 0.12, 1, 0.67],
          "line-width":   ["interpolate", ["linear"], ["get", "dark"], 0, 0.3,  1, 1.5 ],
        },
      });
      sessionLayers = [`${sessionId}-surround`, `${sessionId}-fill`];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const src = () => map.getSource(sessionId) as any;

      const drawGroup = (ways: WayData[], phase: "surround" | "fill"): Promise<void> =>
        new Promise(resolve => {
          let i = 0;
          const push = ({ segments, b }: WayData) => {
            const dark = 1 - b;
            for (const seg of segments)
              geojson.features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: seg.map(([lat, lon]) => [lon, lat]) },
                properties: { dark, phase },
              });
          };
          const step = () => {
            if (abortRef.current) { resolve(); return; }
            if (finishRef.current) {
              while (i < ways.length) push(ways[i++]);
              src().setData(geojson); resolve(); return;
            }
            const end = Math.min(i + 15, ways.length);
            while (i < end) push(ways[i++]);
            src().setData(geojson);
            if (i < ways.length) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });

      await drawGroup(surroundings, "surround");
      if (!abortRef.current && !finishRef.current) await new Promise<void>(r => setTimeout(r, 300));
      await drawGroup(fill, "fill");

      if (!abortRef.current) {
        sessionsRef.current.push({ sourceId: sessionId, layerIds: sessionLayers });
        setStatus(null);
        setIsPrinted(true);
      } else {
        sessionLayers.forEach(id => { try { map.removeLayer(id); } catch {} });
        try { map.removeSource(sessionId); } catch {}
      }
    } catch (err) {
      if (!abortRef.current) {
        sessionLayers.forEach(id => { try { map.removeLayer(id); } catch {} });
        try { map.removeSource(sessionId); } catch {}
        setStatus(`Error: ${err instanceof Error ? err.message : "failed"}`);
      }
    } finally {
      if (!abortRef.current) setIsDrawing(false);
    }
  };

  // ── Undo ──────────────────────────────────────────────────────────────────────
  const handleUndo = () => {
    const map = mapRef.current;
    const last = sessionsRef.current.pop();
    if (!last) return;
    if (map) {
      last.layerIds.forEach(id => { try { map.removeLayer(id); } catch {} });
      try { map.removeSource(last.sourceId); } catch {}
    }
    if (sessionsRef.current.length === 0) setIsPrinted(false);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────────
  const handleReset = () => {
    clearSessions();
    pixelsRef.current = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null); setIsPrinted(false); setStatus(null);
  };

  // ── Drag / resize ─────────────────────────────────────────────────────────────
  const ixRef = useRef<
    | { kind: "move";   mx0: number; my0: number; pos0: Pos  }
    | { kind: "resize"; mx0: number; my0: number; sz0:  Size }
    | null
  >(null);

  const disableMap = () => {
    mapRef.current?.dragPan.disable();
    mapRef.current?.scrollZoom.disable();
    mapRef.current?.doubleClickZoom.disable();
  };
  const enableMap = () => {
    mapRef.current?.dragPan.enable();
    mapRef.current?.scrollZoom.enable();
    mapRef.current?.doubleClickZoom.enable();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const ix = ixRef.current;
      if (!ix) return;
      const dx = e.clientX - ix.mx0, dy = e.clientY - ix.my0;
      if (ix.kind === "move") {
        const p = { x: ix.pos0.x + dx, y: ix.pos0.y + dy };
        setPos(p); posRef.current = p;
      } else {
        const newW = Math.max(80, ix.sz0.w + dx);
        const s = { w: newW, h: newW / aspectRatioRef.current };
        setSize(s); sizeRef.current = s;
      }
    };
    const onUp = () => { if (ixRef.current) enableMap(); ixRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, []);

  const startMove = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    disableMap();
    ixRef.current = { kind: "move", mx0: e.clientX, my0: e.clientY, pos0: posRef.current };
  };
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    disableMap();
    ixRef.current = { kind: "resize", mx0: e.clientX, my0: e.clientY, sz0: sizeRef.current };
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const showOverlay = !!imageUrl && !isPrinted && !isDrawing;

  return (
    <div className="imap-root">
      <div ref={mapContainerRef} className="imap-map" />

      <div className="imap-panels">
        {/* ── Search box ── */}
        <div className="imap-box">
          <div className="imap-header">
            <span className="imap-brand">Street Art</span>
            <p className="imap-how">Place an image — streets trace its shape. White is transparent.</p>
          </div>
          <div className="imap-search">
            <input
              className="imap-search-input"
              type="text"
              placeholder="Search location…"
              value={searchQuery}
              onChange={handleSearchInput}
              onBlur={() => setTimeout(() => setSearchResults([]), 150)}
            />
            {searchResults.length > 0 && (
              <div className="imap-search-results">
                {searchResults.map((r, i) => (
                  <button key={i} className="imap-search-result" onMouseDown={() => handleSearchSelect(r)}>
                    {r.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Upload box ── */}
        <div className="imap-box">
          {!isPrinted && (
            <>
              {!isDrawing && (
                <>
                  <label className="imap-upload-btn">
                    {imageUrl ? "Change image" : "Upload image"}
                    <input type="file" accept="image/*" onChange={handleUpload} hidden />
                  </label>
                  <div className="imap-library-row">
                    <button className="imap-library-toggle" onClick={() => setLibOpen(o => !o)}>
                      {libOpen ? "Hide templates ↑" : "Use a template ↓"}
                    </button>
                    {libOpen && (
                      <div className="imap-library">
                        {LIBRARY.map(({ src, label }, i) => (
                          <button key={src} className="imap-library-icon" onClick={() => handleLibrarySelect(libImages[i] ?? src)}>
                            {libImages[i]
                              ? <img src={libImages[i]} alt={label} />
                              : <span className="imap-library-loading" />}
                            <span className="imap-library-label">{label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
              {imageUrl && !isDrawing && (
                <button className="imap-draw-btn" onClick={handleDraw}>Draw streets</button>
              )}
              {isDrawing && (
                <button className="imap-finish-btn" onClick={() => { finishRef.current = true; }}>
                  Finish
                </button>
              )}
            </>
          )}

          {isPrinted && (
            <>
              <label className="imap-upload-btn">
                Upload image
                <input type="file" accept="image/*" onChange={handleUpload} hidden />
              </label>
              <button className="imap-undo-btn" onClick={handleUndo}>Undo last drawing</button>
              <button className="imap-reset-btn" onClick={handleReset}>Clear all</button>
            </>
          )}

          {status && <div className="imap-status">{status}</div>}
        </div>
      </div>

      {!imageUrl && <div className="imap-hint">Upload an image to place it on the map</div>}

      {showOverlay && (
        <div className="imap-overlay"
          style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
          onMouseDown={startMove}>
          <img src={imageUrl!} draggable={false} className="imap-overlay-img"
            style={{ opacity: 0.55 }} />
          <div className="imap-resize-handle" onMouseDown={startResize} />
          <div className="imap-overlay-label">drag · corner to resize</div>
        </div>
      )}
    </div>
  );
}
