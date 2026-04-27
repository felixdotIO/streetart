import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

type Pos = { x: number; y: number };
type Size = { w: number; h: number };

interface OsmNode { type: "node"; id: number; lat: number; lon: number }
interface OsmWay  { type: "way";  id: number; nodes: number[] }
type OverpassEl = OsmNode | OsmWay;


// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchStreets(bounds: L.LatLngBounds): Promise<OverpassEl[]> {
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
  const q = `[out:json][timeout:30];(way["highway"](${s},${w},${n},${e}););out body;>;out skel qt;`;
  const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return (await res.json()).elements;
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

// Clips a way to only the nodes that are (a) inside the image bounds and
// (b) on actual content pixels (brightness below threshold).
// Both geographic boundary crossings and bright/transparent pixels break the run.
// Returns clipped segments plus the average brightness of included nodes.
const CONTENT_THRESHOLD = 0.85; // pixels brighter than this are treated as background

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
      current.push([lat, lon]);
      bSum += b; bCount++;
    } else {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
  }
  if (current.length >= 2) segments.push(current);

  return { segments, b: bCount > 0 ? bSum / bCount : 1 };
}

function streetStyle(b: number, isOutline: boolean): L.PolylineOptions {
  const dark = 1 - b;
  return {
    color: "#ffffff",
    opacity: isOutline ? 0.15 + dark * 0.80 : 0.12 + dark * 0.55,
    weight:  isOutline ? 0.5  + dark * 2.5  : 0.3  + dark * 1.2,
    interactive: false,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImageMapPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<L.Map | null>(null);
  const rendererRef     = useRef<L.Canvas | null>(null);
  const layerRef        = useRef<L.LayerGroup | null>(null);
  const abortRef        = useRef(false);
  const finishRef       = useRef(false);

  // Per-draw-session undo stack
  const sessionsRef = useRef<L.Polyline[][]>([]);
  const pixelsRef   = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);

  // Stable overlay position refs (avoid stale closures)
  const posRef  = useRef<Pos>({ x: 0, y: 0 });
  const sizeRef = useRef<Size>({ w: 300, h: 300 });

  const [imageUrl,       setImageUrl]       = useState<string | null>(null);
  const [pos,            setPos]            = useState<Pos>({ x: 0, y: 0 });
  const [size,           setSize]           = useState<Size>({ w: 300, h: 300 });
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [status,         setStatus]         = useState<string | null>(null);
  const [isDrawing,      setIsDrawing]      = useState(false);
  const [drawn,          setDrawn]          = useState(0);
  const [sessionCount,   setSessionCount]   = useState(0);
  const [isPrinted,      setIsPrinted]      = useState(false);

  useEffect(() => { posRef.current  = pos;  }, [pos]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // ── Map init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, { center: [47.3769, 8.5417], zoom: 14, zoomControl: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd", maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    rendererRef.current = L.canvas({ padding: 0.5 });
    layerRef.current    = L.layerGroup().addTo(map);
    mapRef.current      = map;
    return () => {
      abortRef.current = true;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Upload ────────────────────────────────────────────────────────────────────
  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(URL.createObjectURL(file));
    pixelsRef.current = null;
    sessionsRef.current.forEach(s => s.forEach(p => layerRef.current?.removeLayer(p)));
    sessionsRef.current = [];
    setIsPrinted(false);
    setDrawn(0); setSessionCount(0); setStatus(null);
    if (mapContainerRef.current) {
      const { width, height } = mapContainerRef.current.getBoundingClientRect();
      const w = Math.min(340, width * 0.38);
      const p = { x: width / 2 - w / 2, y: height / 2 - w / 2 };
      const s = { w, h: w };
      setPos(p); setSize(s);
      posRef.current = p; sizeRef.current = s;
    }
  };


  // ── Draw ──────────────────────────────────────────────────────────────────────
  const handleDraw = async () => {
    const map = mapRef.current;
    if (!map || !imageUrl || isDrawing) return;

    abortRef.current  = false;
    finishRef.current = false;
    setIsDrawing(true);
    setStatus("Fetching streets…");

    try {
      // Compute bounds from current overlay screen position → lat/lng
      const { x, y } = posRef.current;
      const { w, h } = sizeRef.current;
      const sw     = map.containerPointToLatLng(L.point(x,     y + h));
      const ne     = map.containerPointToLatLng(L.point(x + w, y    ));
      const bounds = L.latLngBounds(sw, ne);

      const elements = await fetchStreets(bounds);
      if (abortRef.current) return;

      const nodes = new Map<number, [number, number]>();
      for (const el of elements) {
        if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
      }

      if (!pixelsRef.current) pixelsRef.current = await loadPixels(imageUrl);
      const px = pixelsRef.current;
      if (abortRef.current) return;

      const south = bounds.getSouth(), west = bounds.getWest();
      const latR  = bounds.getNorth() - south;
      const lngR  = bounds.getEast()  - west;

      // WayData holds clipped segments (each a run of in-bounds nodes) + avg brightness
      type WayData = { segments: [number, number][][]; b: number };
      const surroundings: WayData[] = [];
      const fill:         WayData[] = [];

      for (const el of elements) {
        if (el.type !== "way") continue;

        const allCoords: [number, number][] = [];
        for (const id of el.nodes) {
          const n = nodes.get(id);
          if (n) allCoords.push(n);
        }
        if (allCoords.length < 2) continue;

        // Clip to content: drops out-of-bounds nodes AND bright/transparent pixels
        const { segments, b } = clipToContent(allCoords, south, west, latR, lngR, px.data, px.w, px.h);
        if (segments.length === 0) continue; // nothing to draw

        (b < 0.45 ? surroundings : fill).push({ segments, b });
      }

      surroundings.sort((a, b) => a.b - b.b);
      fill.sort((a, b) => a.b - b.b);

      const total = surroundings.length + fill.length;
      setStatus(`Drawing ${total} streets…`);

      const renderer    = rendererRef.current!;
      const layer       = layerRef.current!;
      const newSession: L.Polyline[] = [];

      // Draw 3 ways per rAF tick — streets appear visibly one by one.
      // If finishRef is set, flushes all remaining ways synchronously in one go.
      const drawGroup = (ways: WayData[], isOutline: boolean): Promise<void> =>
        new Promise(resolve => {
          let i = 0;
          const step = () => {
            if (abortRef.current) { resolve(); return; }
            if (finishRef.current) {
              for (; i < ways.length; i++) {
                const { segments, b } = ways[i];
                const style = { ...streetStyle(b, isOutline), renderer };
                for (const seg of segments) {
                  const poly = L.polyline(seg, style);
                  poly.addTo(layer);
                  newSession.push(poly);
                }
              }
              setDrawn(ways.length);
              resolve();
              return;
            }
            const end = Math.min(i + 3, ways.length);
            for (; i < end; i++) {
              const { segments, b } = ways[i];
              const style = { ...streetStyle(b, isOutline), renderer };
              for (const seg of segments) {
                const poly = L.polyline(seg, style);
                poly.addTo(layer);
                newSession.push(poly);
              }
            }
            setDrawn(i);
            if (i < ways.length) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });

      await drawGroup(surroundings, true);
      if (!abortRef.current && !finishRef.current) {
        await new Promise<void>(r => setTimeout(r, 300));
      }
      await drawGroup(fill, false);

      // Commit whatever was drawn — whether animation completed or user hit Finish
      if (!abortRef.current) {
        sessionsRef.current.push(newSession);
        setSessionCount(sessionsRef.current.length);
        setStatus(null);
        setIsPrinted(true);
      }
    } catch (err) {
      if (!abortRef.current) setStatus(`Error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      if (!abortRef.current) setIsDrawing(false);
    }
  };

  // ── Undo ──────────────────────────────────────────────────────────────────────
  const handleUndo = () => {
    const last = sessionsRef.current.pop();
    if (!last) return;
    last.forEach(p => layerRef.current?.removeLayer(p));
    const count = sessionsRef.current.length;
    setSessionCount(count);
    setDrawn(0);
    if (count === 0) setIsPrinted(false);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────────
  const handleReset = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    sessionsRef.current.forEach(s => s.forEach(p => layerRef.current?.removeLayer(p)));
    sessionsRef.current = [];
    pixelsRef.current = null;
    setImageUrl(null);
    setIsPrinted(false);
    setDrawn(0); setSessionCount(0); setStatus(null);
  };

  // ── Drag / resize ─────────────────────────────────────────────────────────────
  const ixRef = useRef<
    | { kind: "move";   mx0: number; my0: number; pos0: Pos  }
    | { kind: "resize"; mx0: number; my0: number; sz0:  Size }
    | null
  >(null);

  const disableMap = () => {
    mapRef.current?.dragging.disable();
    mapRef.current?.scrollWheelZoom.disable();
    mapRef.current?.doubleClickZoom.disable();
  };
  const enableMap = () => {
    mapRef.current?.dragging.enable();
    mapRef.current?.scrollWheelZoom.enable();
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
        const s = { w: Math.max(80, ix.sz0.w + dx), h: Math.max(80, ix.sz0.h + dy) };
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

      <div className="imap-panel">
        <div className="imap-header">
          <span className="imap-brand">Outline Map</span>
          <p className="imap-how">Place an image on the map — real streets trace its shape.</p>
        </div>

        {/* Before / during drawing */}
        {!isPrinted && (
          <>
            {!isDrawing && (
              <label className="imap-upload-btn">
                {imageUrl ? "Change image" : "Upload image"}
                <input type="file" accept="image/*" onChange={handleUpload} hidden />
              </label>
            )}

            {imageUrl && !isDrawing && (
              <button className="imap-draw-btn" onClick={handleDraw}>
                Draw streets
              </button>
            )}

            {isDrawing && (
              <button className="imap-finish-btn" onClick={() => { finishRef.current = true; }}>
                Finish
              </button>
            )}
          </>
        )}

        {/* After drawing: upload new image + undo */}
        {isPrinted && (
          <>
            <label className="imap-upload-btn">
              Upload image
              <input type="file" accept="image/*" onChange={handleUpload} hidden />
            </label>
            <button className="imap-undo-btn" onClick={handleUndo}>
              Undo last drawing
            </button>
            <button className="imap-reset-btn" onClick={handleReset}>Clear all</button>
          </>
        )}

        {/* Status — only while actively fetching/drawing, not after */}
        {status && <div className="imap-status">{status}</div>}
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
