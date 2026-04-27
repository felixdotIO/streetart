import * as L from "leaflet";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { sbbApiUrl } from "./data";
import { ImageMapPage } from "./ImageMapPage";
import { useGleis } from "./store";
import type { NameProposal, Platform, RatingInput } from "./types";

type StationSummary = {
  name: string;
  city: string;
  platformCount: number;
  contestedPlatforms: number;
  totalVotes: number;
  averageVibe: number;
  center?: {
    lat: number;
    lng: number;
  };
};

type ViewMode = "map" | "list";

function scoreLabel(value: number) {
  return value ? value.toFixed(1) : "New";
}

function cityFromStationName(stationName: string) {
  const normalized = stationName.replace(" Bahnhof", "").replace(" Station", "").trim();
  const firstToken = normalized.split(/[\s-]/)[0];
  return firstToken || stationName;
}

function comparePlatformNumbers(left: Platform, right: Platform) {
  return left.platform.localeCompare(right.platform, "de-CH", { numeric: true });
}

function platformDisplayName(platform: Platform, proposalName?: string) {
  return proposalName?.trim() || `Gleis ${platform.platform}`;
}

function buildOverallRatingInput(value: number): RatingInput {
  return {
    vibe: value,
    refuel: value,
    seating: value,
    pride: value >= 4 ? "yes" : value <= 2 ? "no" : "complicated",
    umbrella: value <= 2,
    comment: "",
  };
}

function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">{children}</div>;
}

function PageHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <header className="subpage-topbar">
      <Link to="/" className="subpage-brand">
        <span className="brand-mark">RG</span>
        <span className="brand-copy">
          <strong>Regleis</strong>
        </span>
      </Link>
      <div className="subpage-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {body ? <p className="lead">{body}</p> : null}
      </div>
      <div className="subpage-actions">
        <Link to="/" className="secondary-button">
          Explore
        </Link>
      </div>
    </header>
  );
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <div className="platform-badge">
      <div className="platform-badge-copy">
        <span>{platform.stationName}</span>
        <strong>Gleis {platform.platform}</strong>
      </div>
      <div className="platform-number">{platform.platform}</div>
    </div>
  );
}

function PlatformCard({ platform }: { platform: Platform }) {
  const { getPlatformStats } = useGleis();
  const stats = getPlatformStats(platform.id);
  const nickname = platformDisplayName(platform, stats.topProposal?.name);

  return (
    <article className="platform-card">
      <PlatformBadge platform={platform} />
      <h3>{nickname}</h3>
      <div className="platform-scoreline">
        <span>Vibe {scoreLabel(stats.averageVibe)}</span>
        <span>Seating {scoreLabel(stats.averageSeating)}</span>
        <span>Refuel {scoreLabel(stats.averageRefuel)}</span>
      </div>
      <div className="platform-actions">
        <Link to={`/gleis/${platform.id}`} className="text-link">
          Open card
        </Link>
        <Link to={`/gleis/${platform.id}/rate`} className="primary-button">
          Rate
        </Link>
      </div>
    </article>
  );
}

function SwitzerlandMap({
  platforms,
  stations,
  query,
  selectedStationName,
  onSelectStation,
}: {
  platforms: Platform[];
  stations: StationSummary[];
  query: string;
  selectedStationName?: string;
  onSelectStation: (stationName: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const platformLayerRef = useRef<L.LayerGroup | null>(null);
  const stationLayerRef = useRef<L.LayerGroup | null>(null);
  const hasFittedRef = useRef(false);

  useEffect(() => {
    if (!mapRef.current || leafletMapRef.current) {
      return;
    }

    const map = L.map(mapRef.current, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: true,
      dragging: true,
      doubleClickZoom: true,
    }).setView([46.8182, 8.2275], 8);

    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }).addTo(map);

    platformLayerRef.current = L.layerGroup().addTo(map);
    stationLayerRef.current = L.layerGroup().addTo(map);
    leafletMapRef.current = map;

    return () => {
      map.remove();
      leafletMapRef.current = null;
      platformLayerRef.current = null;
      stationLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = leafletMapRef.current;
    const platformLayer = platformLayerRef.current;
    const stationLayer = stationLayerRef.current;

    if (!map || !platformLayer || !stationLayer) {
      return;
    }

    platformLayer.clearLayers();
    stationLayer.clearLayers();

    const renderer = L.canvas({ padding: 0.5 });
    const bounds = L.latLngBounds([]);

    for (const platform of platforms) {
      if (!platform.coordinates) {
        continue;
      }

      const line = L.polyline(
        [
          [platform.coordinates.start.lat, platform.coordinates.start.lng],
          [platform.coordinates.end.lat, platform.coordinates.end.lng],
        ],
        {
          color: "rgba(89, 96, 103, 0.22)",
          opacity: 0.7,
          weight: 1.1,
          renderer,
        },
      );

      line.addTo(platformLayer);
      bounds.extend(line.getBounds());
    }

    for (const station of stations) {
      if (!station.center) {
        continue;
      }

      const isSelected = station.name === selectedStationName;
      const isMatched =
        query.trim().length > 0 &&
        station.name.toLowerCase().includes(query.trim().toLowerCase());

      const marker = L.circleMarker([station.center.lat, station.center.lng], {
        radius: isSelected ? 9 : isMatched ? 7 : 5,
        color: "#6833ea",
        weight: isSelected ? 2.5 : 1.5,
        fillColor: "#6833ea",
        fillOpacity: isSelected ? 0.95 : isMatched ? 0.78 : 0.58,
      });

      marker.bindTooltip(`${station.name}<br/>${station.platformCount} platforms`, {
        direction: "top",
        offset: [0, -8],
        opacity: 1,
      });
      marker.on("click", () => onSelectStation(station.name));
      marker.addTo(stationLayer);
      bounds.extend(marker.getLatLng());
    }

    if (bounds.isValid() && !hasFittedRef.current) {
      map.fitBounds(bounds.pad(0.08));
      hasFittedRef.current = true;
      return;
    }

    const selectedStation = stations.find((station) => station.name === selectedStationName);
    if (selectedStation?.center) {
      map.flyTo([selectedStation.center.lat, selectedStation.center.lng], 11, {
        duration: 0.4,
      });
      return;
    }

    const needle = query.trim().toLowerCase();
    if (needle.length > 1) {
      const matchingStations = stations.filter(
        (station) => station.center && station.name.toLowerCase().includes(needle),
      );

      if (matchingStations.length) {
        const matchBounds = L.latLngBounds(
          matchingStations
            .filter((station): station is StationSummary & { center: { lat: number; lng: number } } =>
              Boolean(station.center),
            )
            .map((station) => [station.center.lat, station.center.lng] as [number, number]),
        );

        if (matchBounds.isValid()) {
          map.fitBounds(matchBounds.pad(0.35), { maxZoom: 11 });
        }
      }
    }
  }, [onSelectStation, platforms, query, selectedStationName, stations]);

  return <div ref={mapRef} className="real-map" />;
}

function RenameModal({
  platform,
  proposals,
  onClose,
}: {
  platform: Platform;
  proposals: NameProposal[];
  onClose: () => void;
}) {
  const { submitProposal, voteProposal } = useGleis();
  const [suggestion, setSuggestion] = useState("");
  const [busy, setBusy] = useState(false);
  const sorted = [...proposals].sort((left, right) => right.votes - left.votes);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="rename-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">Rename platform</p>
            <h2>
              {platform.stationName} Gleis {platform.platform}
            </h2>
            <p className="lead">Review the current shortlist first, then add a new proposal below.</p>
          </div>
          <button type="button" className="icon-button clean-close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-grid">
          <div className="modal-column">
            <div className="modal-section-head">
              <h3>Current suggestions</h3>
              <span>{sorted.length}</span>
            </div>
            <div className="proposal-board">
              {sorted.length ? (
                sorted.map((proposal) => (
                  <div key={proposal.id} className="proposal-card">
                    <div>
                      <strong>{proposal.name}</strong>
                      <span>{proposal.votes} votes</span>
                    </div>
                    <div className="vote-controls">
                      <button type="button" onClick={() => void voteProposal(proposal.id, 1)}>
                        +1
                      </button>
                      <button type="button" onClick={() => void voteProposal(proposal.id, -1)}>
                        -1
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-copy proposal-empty-state">
                  <strong>No suggestions yet</strong>
                  <span>Start the shortlist with the first name proposal for this platform.</span>
                </div>
              )}
            </div>
          </div>

          <div className="modal-column">
            <div className="modal-section-head">
              <h3>Add a suggestion</h3>
            </div>
            <label className="field">
              <span>New proposal</span>
              <input
                value={suggestion}
                onChange={(event) => setSuggestion(event.target.value.slice(0, 30))}
                placeholder={`Gleis ${platform.platform}, but better`}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!suggestion.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  await submitProposal(platform.id, suggestion.trim());
                  setSuggestion("");
                  setBusy(false);
                }}
              >
                Submit proposal
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickProposeModal({
  query,
  onQueryChange,
  matches,
  onChoosePlatform,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  matches: Platform[];
  onChoosePlatform: (platform: Platform) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="quick-propose-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">Propose name</p>
            <h2>Pick a platform first</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="field">
          <span>Search station or platform</span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Bern, Gleis 7, Lausanne"
          />
        </label>
        <div className="quick-propose-results">
          {matches.length ? (
            matches.map((platform) => (
              <button
                key={platform.id}
                type="button"
                className="quick-propose-row"
                onClick={() => onChoosePlatform(platform)}
              >
                <span className="mono-label">Gleis {platform.platform}</span>
                <strong>{platform.stationName}</strong>
                <span>{cityFromStationName(platform.stationName)}</span>
              </button>
            ))
          ) : (
            <p className="empty-copy">Search a station or a track number to start naming.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function HomePage() {
  const { platforms, proposals, source, bootError, getPlatformStats, submitRating } = useGleis();
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [query, setQuery] = useState("");
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedPlatformId, setSelectedPlatformId] = useState("");
  const [quickProposeOpen, setQuickProposeOpen] = useState(false);
  const [activeCity, setActiveCity] = useState("");
  const [activeStation, setActiveStation] = useState("");
  const [expandedCities, setExpandedCities] = useState<Record<string, boolean>>({});
  const [inlineVoteBusyId, setInlineVoteBusyId] = useState("");
  const navigate = useNavigate();

  const stationSummaries = useMemo<StationSummary[]>(() => {
    const grouped = new Map<
      string,
      StationSummary & {
        coordinateLatTotal: number;
        coordinateLngTotal: number;
        coordinateCount: number;
      }
    >();

    for (const platform of platforms) {
      const stats = getPlatformStats(platform.id);
      const platformCenter = platform.coordinates
        ? {
            lat: (platform.coordinates.start.lat + platform.coordinates.end.lat) / 2,
            lng: (platform.coordinates.start.lng + platform.coordinates.end.lng) / 2,
          }
        : undefined;
      const platformProposals = proposals.filter((proposal) => proposal.platformId === platform.id);
      const existing = grouped.get(platform.stationName);

      if (existing) {
        existing.platformCount += 1;
        existing.contestedPlatforms += platformProposals.length ? 1 : 0;
        existing.totalVotes += platformProposals.reduce((sum, proposal) => sum + proposal.votes, 0);
        if (stats.totalRatings > 0) {
          existing.averageVibe += stats.averageVibe;
        }
        if (platformCenter) {
          existing.coordinateLatTotal += platformCenter.lat;
          existing.coordinateLngTotal += platformCenter.lng;
          existing.coordinateCount += 1;
        }
        continue;
      }

      grouped.set(platform.stationName, {
        name: platform.stationName,
        city: cityFromStationName(platform.stationName),
        platformCount: 1,
        contestedPlatforms: platformProposals.length ? 1 : 0,
        totalVotes: platformProposals.reduce((sum, proposal) => sum + proposal.votes, 0),
        averageVibe: stats.totalRatings > 0 ? stats.averageVibe : 0,
        center: undefined,
        coordinateLatTotal: platformCenter?.lat ?? 0,
        coordinateLngTotal: platformCenter?.lng ?? 0,
        coordinateCount: platformCenter ? 1 : 0,
      });
    }

    return Array.from(grouped.values())
      .map((station) => ({
        name: station.name,
        city: station.city,
        platformCount: station.platformCount,
        contestedPlatforms: station.contestedPlatforms,
        totalVotes: station.totalVotes,
        averageVibe: station.averageVibe / Math.max(station.platformCount, 1),
        center: station.coordinateCount
          ? {
              lat: station.coordinateLatTotal / station.coordinateCount,
              lng: station.coordinateLngTotal / station.coordinateCount,
            }
          : undefined,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "de-CH"));
  }, [getPlatformStats, platforms, proposals]);

  const stationMap = useMemo(
    () => new Map(stationSummaries.map((station) => [station.name, station])),
    [stationSummaries],
  );
  const normalizedQuery = query.trim().toLowerCase();

  const stationMatches = useMemo(() => {
    if (!normalizedQuery) {
      return stationSummaries.slice(0, 8);
    }

    return stationSummaries
      .filter((station) => {
        const platformMatch = platforms.some(
          (platform) =>
            platform.stationName === station.name &&
            (`gleis ${platform.platform}`.toLowerCase().includes(normalizedQuery) ||
              platform.platform.toLowerCase().includes(normalizedQuery)),
        );

        return (
          station.name.toLowerCase().includes(normalizedQuery) ||
          station.city.toLowerCase().includes(normalizedQuery) ||
          platformMatch
        );
      })
      .slice(0, 8);
  }, [normalizedQuery, platforms, stationSummaries]);

  const cityMatches = useMemo(() => {
    const uniqueCities = Array.from(new Set(stationSummaries.map((station) => station.city))).sort(
      (left, right) => left.localeCompare(right, "de-CH"),
    );

    if (!normalizedQuery) {
      return uniqueCities.slice(0, 6);
    }

    return uniqueCities.filter((city) => city.toLowerCase().includes(normalizedQuery)).slice(0, 6);
  }, [normalizedQuery, stationSummaries]);

  const platformMatches = useMemo(() => {
    const sortedPlatforms = [...platforms].sort(
      (left, right) =>
        left.stationName.localeCompare(right.stationName, "de-CH") || comparePlatformNumbers(left, right),
    );

    if (!normalizedQuery) {
      return selectedStationName
        ? sortedPlatforms.filter((platform) => platform.stationName === selectedStationName).slice(0, 8)
        : sortedPlatforms.slice(0, 8);
    }

    return sortedPlatforms
      .filter((platform) => {
        const stats = getPlatformStats(platform.id);
        return (
          platform.stationName.toLowerCase().includes(normalizedQuery) ||
          cityFromStationName(platform.stationName).toLowerCase().includes(normalizedQuery) ||
          platform.platform.toLowerCase().includes(normalizedQuery) ||
          `gleis ${platform.platform}`.toLowerCase().includes(normalizedQuery) ||
          stats.topProposal?.name.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, 10);
  }, [getPlatformStats, normalizedQuery, platforms, selectedStationName]);

  const groupedListData = useMemo(() => {
    const filtered = normalizedQuery
      ? platforms.filter((platform) => {
          const stats = getPlatformStats(platform.id);
          return (
            platform.stationName.toLowerCase().includes(normalizedQuery) ||
            cityFromStationName(platform.stationName).toLowerCase().includes(normalizedQuery) ||
            platform.platform.toLowerCase().includes(normalizedQuery) ||
            `gleis ${platform.platform}`.toLowerCase().includes(normalizedQuery) ||
            stats.topProposal?.name.toLowerCase().includes(normalizedQuery)
          );
        })
      : platforms;

    const cityMap = new Map<string, Map<string, Platform[]>>();
    for (const platform of filtered) {
      const city = cityFromStationName(platform.stationName);
      const stations = cityMap.get(city) ?? new Map<string, Platform[]>();
      const stationPlatforms = stations.get(platform.stationName) ?? [];
      stationPlatforms.push(platform);
      stations.set(platform.stationName, stationPlatforms);
      cityMap.set(city, stations);
    }

    return Array.from(cityMap.entries())
      .map(([city, stations]) => ({
        city,
        stations: Array.from(stations.entries())
          .map(([stationName, stationPlatforms]) => ({
            name: stationName,
            summary: stationMap.get(stationName),
            platforms: [...stationPlatforms].sort(comparePlatformNumbers),
          }))
          .sort((left, right) => left.name.localeCompare(right.name, "de-CH")),
      }))
      .sort((left, right) => left.city.localeCompare(right.city, "de-CH"));
  }, [getPlatformStats, normalizedQuery, platforms, stationMap]);

  useEffect(() => {
    if (!groupedListData.length) {
      setActiveCity("");
      setActiveStation("");
      return;
    }

    if (!activeCity || !groupedListData.some((group) => group.city === activeCity)) {
      setActiveCity(groupedListData[0].city);
    }
  }, [activeCity, groupedListData]);

  const stationsForActiveCity = useMemo(() => {
    return groupedListData.find((group) => group.city === activeCity)?.stations ?? [];
  }, [activeCity, groupedListData]);

  useEffect(() => {
    if (!stationsForActiveCity.length) {
      setActiveStation("");
      return;
    }

    if (!activeStation || !stationsForActiveCity.some((station) => station.name === activeStation)) {
      setActiveStation(stationsForActiveCity[0].name);
    }
  }, [activeStation, stationsForActiveCity]);

  const selectedStation = selectedStationName ? stationMap.get(selectedStationName) : undefined;
  const selectedPlatforms = selectedStation
    ? [...platforms]
        .filter((platform) => platform.stationName === selectedStation.name)
        .sort(comparePlatformNumbers)
    : [];
  const selectedPlatform = platforms.find((platform) => platform.id === selectedPlatformId);
  const activeStationRecord = stationsForActiveCity.find((station) => station.name === activeStation);
  const topMovers = [...platforms]
    .sort((left, right) => {
      const rightStats = getPlatformStats(right.id);
      const leftStats = getPlatformStats(left.id);

      return (
        (rightStats.topProposal?.votes ?? 0) - (leftStats.topProposal?.votes ?? 0) ||
        rightStats.totalRatings - leftStats.totalRatings ||
        left.stationName.localeCompare(right.stationName, "de-CH") ||
        comparePlatformNumbers(left, right)
      );
    })
    .slice(0, 6);

  const platformStatus =
    platforms.length === 0
      ? "SBB unavailable"
      : source.platforms === "sbb-live"
        ? "SBB live"
        : source.platforms === "sbb-cache"
          ? "SBB cache"
          : "No map data";

  return (
    <AppShell>
      <section className="workspace-shell">
        <header className="workspace-topbar">
          <Link to="/" className="workspace-brand">
            <span className="brand-wordmark">Regleis</span>
          </Link>

          <div className="view-toggle" role="tablist" aria-label="View mode">
            <button
              type="button"
              className={viewMode === "map" ? "toggle-button active" : "toggle-button"}
              onClick={() => setViewMode("map")}
            >
              Map
            </button>
            <button
              type="button"
              className={viewMode === "list" ? "toggle-button active" : "toggle-button"}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>

          <div className="workspace-search">
            <label className="search-input-shell">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search city, station, platform"
              />
            </label>

            {query.trim() ? (
              <div className="search-dropdown">
                {cityMatches.length ? (
                  <div className="search-group">
                    <span className="search-group-label">Cities</span>
                    {cityMatches.map((city) => (
                      <button
                        key={city}
                        type="button"
                        className="search-result"
                        onClick={() => {
                          setViewMode("list");
                          setActiveCity(city);
                          setSelectedStationName("");
                          setQuery("");
                        }}
                      >
                        <strong>{city}</strong>
                        <span>City view</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {stationMatches.length ? (
                  <div className="search-group">
                    <span className="search-group-label">Stations</span>
                    {stationMatches.map((station) => (
                      <button
                        key={station.name}
                        type="button"
                        className="search-result"
                        onClick={() => {
                          setViewMode("map");
                          setSelectedStationName(station.name);
                          setQuery("");
                        }}
                      >
                        <strong>{station.name}</strong>
                        <span>{station.platformCount} platforms</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {platformMatches.length ? (
                  <div className="search-group">
                    <span className="search-group-label">Platforms</span>
                    {platformMatches.map((platform) => (
                      <button
                        key={platform.id}
                        type="button"
                        className="search-result"
                        onClick={() => {
                          setViewMode("map");
                          setSelectedStationName(platform.stationName);
                          setSelectedPlatformId(platform.id);
                          setQuery("");
                        }}
                      >
                        <strong>
                          {platform.stationName} · Gleis {platform.platform}
                        </strong>
                        <span>{platformDisplayName(platform, getPlatformStats(platform.id).topProposal?.name)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <button type="button" className="primary-button workspace-cta" onClick={() => setQuickProposeOpen(true)}>
            Propose Name
          </button>
        </header>

        {viewMode === "map" ? (
          <section className="movers-section workspace-movers">
            <div className="section-title-row">
              <div>
                <h2>Top movers</h2>
              </div>
            </div>

            <div className="movers-grid">
              {topMovers.map((platform) => {
                const stats = getPlatformStats(platform.id);

                return (
                <button
                  key={platform.id}
                  type="button"
                  className="mover-card"
                  onClick={() => {
                    setViewMode("map");
                    setSelectedStationName(platform.stationName);
                    setSelectedPlatformId(platform.id);
                  }}
                >
                  <span className="stamp-badge">TRENDING</span>
                  <strong>{platformDisplayName(platform, stats.topProposal?.name)}</strong>
                  <span>
                    {platform.stationName} · Gleis {platform.platform}
                  </span>
                </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="workspace-stage">
          {viewMode === "map" ? (
            <div className="map-stage">
              {platforms.length ? (
                <SwitzerlandMap
                  platforms={platforms}
                  stations={stationSummaries}
                  query={query}
                  selectedStationName={selectedStationName}
                  onSelectStation={setSelectedStationName}
                />
              ) : (
                <div className="workspace-map-empty">
                  <p className="eyebrow">Map unavailable</p>
                  <h2>SBB platform geometry did not load.</h2>
                  <p>{bootError ?? "Reload when the SBB dataset is reachable."}</p>
                </div>
              )}

              <div className="workspace-map-overlay">
                <span>{platformStatus}</span>
                <strong>{platforms.length} live platform records</strong>
              </div>

              {selectedStation ? (
                <aside className="station-sidepanel">
                  <div className="station-sidepanel-head">
                    <div>
                      <h2>{selectedStation.name}</h2>
                      <p className="lead">Choose a platform to rate or rename.</p>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setSelectedStationName("")}
                    >
                      Close
                    </button>
                  </div>

                  <div className="station-sidepanel-section">
                    <div className="section-title-row">
                      <div>
                        <h3>Platforms</h3>
                      </div>
                    </div>

                    <div className="station-platform-list">
                      {selectedPlatforms.map((platform) => {
                        const stats = getPlatformStats(platform.id);
                        const roundedScore = Math.round(stats.averageVibe);
                        return (
                          <div key={platform.id} className="station-platform-row">
                            <button
                              type="button"
                              className="station-platform-main"
                              onClick={() => navigate(`/gleis/${platform.id}`)}
                            >
                              <span className="station-platform-track">Gleis {platform.platform}</span>
                              <strong>{platformDisplayName(platform, stats.topProposal?.name)}</strong>
                              <span>{stats.topProposal?.votes ?? 0} votes</span>
                              <div className="sidebar-vote-row">
                                {[1, 2, 3, 4, 5].map((score) => (
                                  <button
                                    key={score}
                                    type="button"
                                    className={score <= roundedScore ? "sidebar-star active" : "sidebar-star"}
                                    disabled={inlineVoteBusyId === platform.id}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setInlineVoteBusyId(platform.id);
                                      void submitRating(platform.id, buildOverallRatingInput(score)).finally(() =>
                                        setInlineVoteBusyId(""),
                                      );
                                    }}
                                    aria-label={`Vote ${score} stars for Gleis ${platform.platform}`}
                                  >
                                    ★
                                  </button>
                                ))}
                              </div>
                            </button>
                            <button
                              type="button"
                              className="secondary-button compact-button"
                              onClick={() => navigate(`/gleis/${platform.id}/rate`)}
                            >
                              Vote
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </aside>
              ) : null}
            </div>
          ) : (
            <div className="list-stage">
              <section className="list-table-shell">
                <div className="list-table-header">
                  <div>
                    <p className="eyebrow">Stations</p>
                    <h2>Station directory</h2>
                    <p className="lead">
                      Open a city to browse every station and track inside it.
                    </p>
                  </div>
                  <div className="list-table-filters">
                    <span>{groupedListData.length} cities</span>
                  </div>
                </div>

                <div className="station-table-wrap">
                  {groupedListData.length ? (
                    <div className="city-groups">
                      {groupedListData.map((group) => {
                        const isExpanded = expandedCities[group.city] ?? false;

                        return (
                          <section key={group.city} className="city-group">
                            <button
                              type="button"
                              className="city-group-header"
                              onClick={() =>
                                setExpandedCities((current) => ({
                                  ...current,
                                  [group.city]: !isExpanded,
                                }))
                              }
                            >
                              <span className="city-group-copy">
                                <strong>{group.city}</strong>
                                <span>{group.stations.length} stations</span>
                              </span>
                              <span className="city-group-toggle" aria-hidden="true">
                                {isExpanded ? "−" : "+"}
                              </span>
                            </button>

                            {isExpanded ? (
                              <div className="city-group-body">
                                {group.stations.map((station) => {
                                  const featuredPlatform = station.platforms[0];
                                  const featuredStats = featuredPlatform
                                    ? getPlatformStats(featuredPlatform.id)
                                    : undefined;

                                  if (!featuredPlatform || !featuredStats) {
                                    return null;
                                  }

                                  return (
                                    <Fragment key={station.name}>
                                      <div className="station-row">
                                        <button
                                          type="button"
                                          className="station-cell"
                                          onClick={() => {
                                            setViewMode("map");
                                            setSelectedStationName(station.name);
                                          }}
                                        >
                                          <span className="station-cell-icon">↗</span>
                                          <span className="station-cell-copy">
                                            <strong>{station.name}</strong>
                                            <span>{group.city}</span>
                                          </span>
                                        </button>
                                        <span className="track-count-chip">{station.platforms.length} tracks</span>
                                        <span
                                          className={
                                            featuredStats.topProposal
                                              ? "top-name-chip"
                                              : "top-name-chip top-name-chip-muted"
                                          }
                                        >
                                          {platformDisplayName(featuredPlatform, featuredStats.topProposal?.name)}
                                        </span>
                                        <div className="station-row-action">
                                          <button
                                            type="button"
                                            className="secondary-button"
                                            onClick={() => {
                                              setViewMode("map");
                                              setSelectedStationName(station.name);
                                            }}
                                          >
                                            Open
                                          </button>
                                        </div>
                                      </div>

                                      <div className="station-tracks-list">
                                        {station.platforms.map((platform) => {
                                          const stats = getPlatformStats(platform.id);

                                          return (
                                            <div key={platform.id} className="station-track-card">
                                              <div className="station-track-copy">
                                                <span className="mono-label">Track {platform.platform}</span>
                                                <strong>{platformDisplayName(platform, stats.topProposal?.name)}</strong>
                                              </div>
                                              <div className="station-track-meta">
                                                <span className="track-votes-chip">
                                                  {stats.topProposal?.votes ?? 0} votes
                                                </span>
                                              </div>
                                              <div className="station-track-actions">
                                                <button
                                                  type="button"
                                                  className="secondary-button"
                                                  onClick={() => navigate(`/gleis/${platform.id}`)}
                                                >
                                                  Open
                                                </button>
                                                <button
                                                  type="button"
                                                  className="primary-button"
                                                  onClick={() => setSelectedPlatformId(platform.id)}
                                                >
                                                  Vote/Propose
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </Fragment>
                                  );
                                })}
                              </div>
                            ) : null}
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="list-table-empty">
                      <strong>No stations found</strong>
                      <span>Try a different city or station search to repopulate the table.</span>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </section>

      {quickProposeOpen ? (
        <QuickProposeModal
          query={query}
          onQueryChange={setQuery}
          matches={platformMatches}
          onChoosePlatform={(platform) => {
            setSelectedStationName(platform.stationName);
            setSelectedPlatformId(platform.id);
            setQuickProposeOpen(false);
          }}
          onClose={() => setQuickProposeOpen(false)}
        />
      ) : null}

      {selectedPlatform ? (
        <RenameModal
          platform={selectedPlatform}
          proposals={proposals.filter((proposal) => proposal.platformId === selectedPlatform.id)}
          onClose={() => setSelectedPlatformId("")}
        />
      ) : null}
    </AppShell>
  );
}

function StationPage() {
  const { stationName = "" } = useParams();
  const { getStationPlatforms } = useGleis();
  const decodedName = decodeURIComponent(stationName);
  const stationPlatforms = getStationPlatforms(decodedName);

  if (!stationPlatforms.length) {
    return <Navigate to="/" replace />;
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Station view"
        title={decodedName}
        body="All available platforms for this station, ready for public opinion."
      />
      <section className="platform-grid">
        {stationPlatforms.map((platform) => (
          <PlatformCard key={platform.id} platform={platform} />
        ))}
      </section>
    </AppShell>
  );
}

function RatingStars({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rating-row">
      <span>How good is this platform?</span>
      <div className="star-row">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            className={score <= value ? "star active" : "star"}
            onClick={() => onChange(score)}
            disabled={disabled}
            aria-label={`Rate ${score} out of 5`}
          >
            ★
          </button>
        ))}
      </div>
    </div>
  );
}

function RatingPage() {
  const { platformId = "" } = useParams();
  const navigate = useNavigate();
  const { draft, setDraft, getPlatform, submitRating } = useGleis();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const platform = getPlatform(platformId);

  if (!platform) {
    return <Navigate to="/" replace />;
  }

  const updateDraft = <K extends keyof RatingInput>(key: K, value: RatingInput[K]) =>
    setDraft({ ...draft, [key]: value });
  const setOverallRating = (value: number) =>
    setDraft({
      ...draft,
      vibe: value,
      refuel: value,
      seating: value,
      pride: value >= 4 ? "yes" : value <= 2 ? "no" : "complicated",
      umbrella: value <= 2,
    });
  const canSubmit = draft.vibe > 0;

  return (
    <AppShell>
      <PageHeader eyebrow="Rate platform" title={`${platform.stationName} Gleis ${platform.platform}`} />

      <form
        className="card form-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canSubmit) {
            return;
          }

          try {
            setIsSubmitting(true);
            setSubmitError(undefined);
            const reaction = await submitRating(platform.id, draft);
            navigate(`/gleis/${platform.id}/reaction/${reaction.submissionId}`);
          } catch (error) {
            setSubmitError(error instanceof Error ? error.message : "Rating failed");
          } finally {
            setIsSubmitting(false);
          }
        }}
      >
        <RatingStars value={draft.vibe} onChange={setOverallRating} disabled={isSubmitting} />

        <label className="field">
          <span>Optional comment</span>
          <textarea
            value={draft.comment}
            onChange={(event) => updateDraft("comment", event.target.value)}
            rows={4}
            disabled={isSubmitting}
          />
        </label>

        {submitError ? <p className="muted">{submitError}</p> : null}
        <button type="submit" className="primary-button" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? "Submitting..." : "Save rating"}
        </button>
      </form>
    </AppShell>
  );
}

function ReactionPage() {
  const { platformId = "", submissionId = "" } = useParams();
  const { getPlatform, getLatestReaction } = useGleis();
  const platform = getPlatform(platformId);
  const reactionMeta = getLatestReaction(submissionId);

  if (!platform || !reactionMeta) {
    return <Navigate to={`/gleis/${platformId}`} replace />;
  }

  return (
    <AppShell>
      <PageHeader eyebrow="Reaction" title="Your rating landed." />
      <section className="card reaction-shell">
        <PlatformBadge platform={platform} />
        <h2>{reactionMeta.reaction.headline}</h2>
        <p className="lead">{reactionMeta.reaction.detail}</p>
        <div className="reaction-stat">
          <span>{reactionMeta.reaction.statLabel}</span>
          <strong>{reactionMeta.reaction.statValue}</strong>
        </div>
        <div className="platform-actions">
          <Link to={`/gleis/${platform.id}/names`} className="primary-button">
            Suggest a name
          </Link>
          <Link to={`/gleis/${platform.id}`} className="secondary-button">
            View platform
          </Link>
        </div>
      </section>
    </AppShell>
  );
}

function NamesPage() {
  const { platformId = "" } = useParams();
  const navigate = useNavigate();
  const { getPlatform, proposals } = useGleis();
  const platform = getPlatform(platformId);

  if (!platform) {
    return <Navigate to="/" replace />;
  }

  return (
    <AppShell>
      <PageHeader eyebrow="Name board" title={`${platform.stationName} Gleis ${platform.platform}`} />
      <RenameModal
        platform={platform}
        proposals={proposals.filter((proposal) => proposal.platformId === platform.id)}
        onClose={() => navigate(-1)}
      />
    </AppShell>
  );
}

function DetailPage() {
  const { platformId = "" } = useParams();
  const { getPlatform, getPlatformStats } = useGleis();
  const platform = getPlatform(platformId);

  if (!platform) {
    return <Navigate to="/" replace />;
  }

  const stats = getPlatformStats(platform.id);

  return (
    <AppShell>
      <PageHeader eyebrow="Platform card" title={platformDisplayName(platform, stats.topProposal?.name)} />
      <section className="card detail-hero">
        <PlatformBadge platform={platform} />
        <p className="lead">Current official label: Gleis {platform.platform}</p>
        <div className="stat-grid">
          <div>
            <span>Overall vibe</span>
            <strong>{scoreLabel(stats.averageVibe)}</strong>
          </div>
          <div>
            <span>Refuel</span>
            <strong>{scoreLabel(stats.averageRefuel)}</strong>
          </div>
          <div>
            <span>Seating</span>
            <strong>{scoreLabel(stats.averageSeating)}</strong>
          </div>
          <div>
            <span>Umbrella risk</span>
            <strong>{Math.round(stats.umbrellaYesPercent)}%</strong>
          </div>
        </div>
        <div className="platform-actions">
          <Link to={`/gleis/${platform.id}/rate`} className="primary-button">
            Rate
          </Link>
          <Link to={`/gleis/${platform.id}/names`} className="secondary-button">
            Rename
          </Link>
        </div>
      </section>
    </AppShell>
  );
}

export default function App() {
  const { isHydrated } = useGleis();

  if (!isHydrated) {
    return (
      <AppShell>
        <section className="workspace-map-empty loading-screen">
          <p className="eyebrow">Loading</p>
          <h2>Fetching Swiss station platforms.</h2>
        </section>
      </AppShell>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/image-map" element={<ImageMapPage />} />
      <Route path="/station/:stationName" element={<StationPage />} />
      <Route path="/gleis/:platformId" element={<DetailPage />} />
      <Route path="/gleis/:platformId/rate" element={<RatingPage />} />
      <Route path="/gleis/:platformId/reaction/:submissionId" element={<ReactionPage />} />
      <Route path="/gleis/:platformId/names" element={<NamesPage />} />
    </Routes>
  );
}
