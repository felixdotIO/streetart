import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { emptyRatingDraft, initialProposals, initialRatings, loadPlatforms } from "./data";
import { hasSupabaseConfig, supabase } from "./supabase";
import type {
  AppSource,
  LeaderboardEntry,
  NameProposal,
  Platform,
  PlatformStats,
  PrideVote,
  RatingInput,
  RatingRecord,
  SubmissionReaction,
} from "./types";

type SubmissionMeta = {
  reaction: SubmissionReaction;
  platformId: string;
};

type CommunityState = {
  ratings: RatingRecord[];
  proposals: NameProposal[];
  source: AppSource["community"];
};

type RatingRow = {
  id: string;
  platform_id: string;
  vibe: number;
  refuel: number;
  seating: number;
  pride: PrideVote;
  umbrella: boolean;
  comment: string | null;
  created_at: string;
  device_id: string;
};

type ProposalRow = {
  id: string;
  platform_id: string;
  name: string;
  votes: number;
  created_at: string;
  device_id: string | null;
};

type GleisStore = {
  deviceId: string;
  platforms: Platform[];
  ratings: RatingRecord[];
  proposals: NameProposal[];
  draft: RatingInput;
  isHydrated: boolean;
  bootError?: string;
  source: AppSource;
  setDraft: (draft: RatingInput) => void;
  getPlatform: (platformId: string) => Platform | undefined;
  getPlatformStats: (platformId: string) => PlatformStats;
  getStationPlatforms: (stationName: string) => Platform[];
  submitRating: (platformId: string, input: RatingInput) => Promise<SubmissionReaction>;
  submitProposal: (platformId: string, name: string) => Promise<void>;
  voteProposal: (proposalId: string, delta: 1 | -1) => Promise<void>;
  getLatestReaction: (submissionId: string) => SubmissionMeta | undefined;
  leaderboard: {
    bestVibe: LeaderboardEntry[];
    shameCorner: LeaderboardEntry[];
    controversial: LeaderboardEntry[];
    bestNames: LeaderboardEntry[];
  };
};

const STORAGE_KEY = "gleisbewertung-state-v2";
const DEVICE_KEY = "gleisbewertung-device-id";
const reactionStore = new Map<string, SubmissionMeta>();

const GleisContext = createContext<GleisStore | null>(null);

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapRatingRow(row: RatingRow): RatingRecord {
  return {
    id: row.id,
    platformId: row.platform_id,
    vibe: row.vibe,
    refuel: row.refuel,
    seating: row.seating,
    pride: row.pride,
    umbrella: row.umbrella,
    comment: row.comment ?? "",
    createdAt: row.created_at,
    deviceId: row.device_id,
  };
}

function mapProposalRow(row: ProposalRow): NameProposal {
  return {
    id: row.id,
    platformId: row.platform_id,
    name: row.name,
    votes: row.votes,
    createdAt: row.created_at,
    deviceId: row.device_id ?? undefined,
  };
}

function getPlatformStatsFor(
  platformId: string,
  ratings: RatingRecord[],
  proposals: NameProposal[],
): PlatformStats {
  const platformRatings = ratings.filter((rating) => rating.platformId === platformId);
  const platformProposals = proposals
    .filter((proposal) => proposal.platformId === platformId)
    .sort((left, right) => right.votes - left.votes);

  const prideSplit = platformRatings.reduce<Record<PrideVote, number>>(
    (split, rating) => {
      split[rating.pride] += 1;
      return split;
    },
    { yes: 0, complicated: 0, no: 0 },
  );

  const totalRatings = platformRatings.length;
  const majority = totalRatings
    ? Math.max(prideSplit.yes, prideSplit.complicated, prideSplit.no)
    : 0;
  const controversialIndex = totalRatings ? 1 - majority / totalRatings : 0;

  return {
    totalRatings,
    averageVibe: average(platformRatings.map((rating) => rating.vibe)),
    averageRefuel: average(platformRatings.map((rating) => rating.refuel)),
    averageSeating: average(platformRatings.map((rating) => rating.seating)),
    seatingPositivePercent: totalRatings
      ? (platformRatings.filter((rating) => rating.seating >= 4).length / totalRatings) * 100
      : 0,
    prideSplit,
    umbrellaYesPercent: totalRatings
      ? (platformRatings.filter((rating) => rating.umbrella).length / totalRatings) * 100
      : 0,
    topComments: platformRatings.filter((rating) => rating.comment).slice(-3).reverse(),
    topProposal: platformProposals[0],
    controversialIndex,
  };
}

function buildReaction(
  platform: Platform,
  before: PlatformStats,
  after: PlatformStats,
  submissionId: string,
  input: RatingInput,
): SubmissionReaction {
  if (before.totalRatings === 0) {
    return {
      submissionId,
      platformId: platform.id,
      headline: `You're the first person to rate Gleis ${platform.platform} ${platform.stationName}.`,
      detail: "It has been standing there all this time, waiting for a verdict.",
      statLabel: "Historic first",
      statValue: "1 rating",
    };
  }

  const prideVotes = after.prideSplit[input.pride];
  const pridePercent = Math.round((prideVotes / after.totalRatings) * 100);

  if (input.pride === "no" && pridePercent >= 60) {
    return {
      submissionId,
      platformId: platform.id,
      headline: `You and ${prideVotes - 1} other people agree: Gleis ${platform.platform} ${platform.stationName} is not proud of itself.`,
      detail: "The consensus is not cruel. It is merely observant.",
      statLabel: "Community alignment",
      statValue: `${pridePercent}% said no`,
    };
  }

  const goodSeatingShare = Math.round(after.seatingPositivePercent);
  if (
    (input.seating >= 4 && goodSeatingShare <= 45) ||
    (input.seating <= 2 && goodSeatingShare >= 55)
  ) {
    return {
      submissionId,
      platformId: platform.id,
      headline: "Controversial take.",
      detail: `${goodSeatingShare}% of people think this Gleis has good seating. You disagreed with the crowd and, frankly, the crowd noticed.`,
      statLabel: "Seating split",
      statValue: `${goodSeatingShare}% positive`,
    };
  }

  if (after.totalRatings % 25 === 0) {
    return {
      submissionId,
      platformId: platform.id,
      headline: `You just filed rating number ${after.totalRatings} for Gleis ${platform.platform} ${platform.stationName}.`,
      detail: "A quarter-century of opinions is not infrastructure policy, but it is close.",
      statLabel: "Milestone",
      statValue: `${after.totalRatings} total ratings`,
    };
  }

  const umbrellaPercent = Math.round(after.umbrellaYesPercent);
  return {
    submissionId,
    platformId: platform.id,
    headline: `Filed. Gleis ${platform.platform} ${platform.stationName} has absorbed your opinion.`,
    detail: `${umbrellaPercent}% of voters believe an umbrella is required. Swiss democracy continues at platform level.`,
    statLabel: "Total ratings",
    statValue: `${after.totalRatings}`,
  };
}

function buildLeaderboard(
  allPlatforms: Platform[],
  ratings: RatingRecord[],
  proposals: NameProposal[],
) {
  const withStats = allPlatforms.map((platform) => ({
    platform,
    stats: getPlatformStatsFor(platform.id, ratings, proposals),
  }));

  const bestVibe = withStats
    .filter(({ stats }) => stats.totalRatings > 0)
    .sort((left, right) => right.stats.averageVibe - left.stats.averageVibe)
    .slice(0, 4)
    .map(({ platform, stats }) => ({
      platform,
      title: stats.topProposal?.name ?? "Unnamed",
      value: `${stats.averageVibe.toFixed(1)} vibe`,
      caption: `${stats.totalRatings} ratings`,
    }));

  const shameCorner = withStats
    .filter(({ stats }) => stats.totalRatings > 0)
    .sort((left, right) => left.stats.averageVibe - right.stats.averageVibe)
    .slice(0, 4)
    .map(({ platform, stats }) => ({
      platform,
      title: stats.topProposal?.name ?? "Unnamed",
      value: `${stats.averageVibe.toFixed(1)} vibe`,
      caption: `${stats.totalRatings} ratings`,
    }));

  const controversial = withStats
    .filter(({ stats }) => stats.totalRatings > 0)
    .sort((left, right) => right.stats.controversialIndex - left.stats.controversialIndex)
    .slice(0, 4)
    .map(({ platform, stats }) => ({
      platform,
      title: stats.topProposal?.name ?? "Unnamed",
      value: `${Math.round(stats.controversialIndex * 100)} disagreement`,
      caption: `${stats.prideSplit.yes}/${stats.prideSplit.complicated}/${stats.prideSplit.no}`,
    }));

  const bestNames = withStats
    .filter(({ stats }) => stats.topProposal)
    .sort(
      (left, right) =>
        (right.stats.topProposal?.votes ?? 0) - (left.stats.topProposal?.votes ?? 0),
    )
    .slice(0, 4)
    .map(({ platform, stats }) => ({
      platform,
      title: stats.topProposal?.name ?? "Unnamed",
      value: `${stats.topProposal?.votes ?? 0} votes`,
      caption: `${platform.stationName} Gleis ${platform.platform}`,
    }));

  return {
    bestVibe,
    shameCorner,
    controversial,
    bestNames,
  };
}

function createDeviceId() {
  return `device-${Math.random().toString(36).slice(2, 10)}`;
}

function loadLocalCommunityState(): CommunityState {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return {
      ratings: initialRatings,
      proposals: initialProposals,
      source: "local",
    };
  }

  const parsed = JSON.parse(raw) as {
    ratings: RatingRecord[];
    proposals: NameProposal[];
  };

  return {
    ratings: parsed.ratings,
    proposals: parsed.proposals,
    source: "local",
  };
}

async function loadCommunityState(): Promise<CommunityState> {
  if (!supabase || !hasSupabaseConfig) {
    return loadLocalCommunityState();
  }

  const [ratingsResponse, proposalsResponse] = await Promise.all([
    supabase
      .from("ratings")
      .select("id, platform_id, vibe, refuel, seating, pride, umbrella, comment, created_at, device_id")
      .order("created_at", { ascending: true }),
    supabase
      .from("name_proposals")
      .select("id, platform_id, name, votes, created_at, device_id")
      .order("votes", { ascending: false }),
  ]);

  if (ratingsResponse.error || proposalsResponse.error) {
    return loadLocalCommunityState();
  }

  return {
    ratings: (ratingsResponse.data ?? []).map((row) => mapRatingRow(row as RatingRow)),
    proposals: (proposalsResponse.data ?? []).map((row) => mapProposalRow(row as ProposalRow)),
    source: "supabase",
  };
}

export function GleisProvider({ children }: { children: ReactNode }) {
  const [deviceId, setDeviceId] = useState("device-loading");
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [ratings, setRatings] = useState<RatingRecord[]>(initialRatings);
  const [proposals, setProposals] = useState<NameProposal[]>(initialProposals);
  const [draft, setDraft] = useState<RatingInput>(emptyRatingDraft);
  const [isHydrated, setIsHydrated] = useState(false);
  const [bootError, setBootError] = useState<string>();
  const [source, setSource] = useState<AppSource>({
    platforms: "seed",
    community: hasSupabaseConfig ? "supabase" : "local",
  });

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const storedDeviceId = localStorage.getItem(DEVICE_KEY) ?? createDeviceId();
        localStorage.setItem(DEVICE_KEY, storedDeviceId);
        setDeviceId(storedDeviceId);

        const [platformResult, communityResult] = await Promise.all([
          loadPlatforms(),
          loadCommunityState(),
        ]);

        if (!active) {
          return;
        }

        setPlatforms(platformResult.platforms);
        setRatings(communityResult.ratings);
        setProposals(communityResult.proposals);
        setSource({
          platforms: platformResult.source,
          community: communityResult.source,
        });
      } catch (error) {
        if (!active) {
          return;
        }

        setBootError(error instanceof Error ? error.message : "Bootstrap failed");
        setPlatforms([]);
        setRatings(initialRatings);
        setProposals(initialProposals);
        setSource((current) => ({ ...current, platforms: "seed" }));
      } finally {
        if (active) {
          setIsHydrated(true);
        }
      }
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ratings, proposals }));
  }, [isHydrated, ratings, proposals]);

  const value = useMemo<GleisStore>(() => {
    const getPlatform = (platformId: string) =>
      platforms.find((platform) => platform.id === platformId);

    const getPlatformStats = (platformId: string) =>
      getPlatformStatsFor(platformId, ratings, proposals);

    const getStationPlatforms = (stationName: string) =>
      platforms.filter((platform) => platform.stationName === stationName);

    const submitRating = async (platformId: string, input: RatingInput) => {
      const platform = getPlatform(platformId);

      if (!platform) {
        throw new Error(`Unknown platform ${platformId}`);
      }

      const before = getPlatformStats(platformId);
      const submissionId = `rating-${Date.now()}`;
      const nextRecord: RatingRecord = {
        ...input,
        id: submissionId,
        platformId,
        createdAt: new Date().toISOString(),
        deviceId,
      };
      const after = getPlatformStatsFor(platformId, [...ratings, nextRecord], proposals);
      const reaction = buildReaction(platform, before, after, submissionId, input);

      if (source.community === "supabase" && supabase) {
        const { error } = await supabase.from("ratings").insert({
          id: nextRecord.id,
          platform_id: nextRecord.platformId,
          vibe: nextRecord.vibe,
          refuel: nextRecord.refuel,
          seating: nextRecord.seating,
          pride: nextRecord.pride,
          umbrella: nextRecord.umbrella,
          comment: nextRecord.comment?.trim() || null,
          created_at: nextRecord.createdAt,
          device_id: nextRecord.deviceId,
        });

        if (error) {
          throw error;
        }
      }

      reactionStore.set(submissionId, { reaction, platformId });
      setRatings((current) => [...current, nextRecord]);
      setDraft(emptyRatingDraft);
      return reaction;
    };

    const submitProposal = async (platformId: string, name: string) => {
      const trimmed = name.trim().slice(0, 30);
      if (!trimmed) {
        return;
      }

      const nextProposal: NameProposal = {
        id: `proposal-${Date.now()}`,
        platformId,
        name: trimmed,
        votes: 1,
        createdAt: new Date().toISOString(),
        deviceId,
      };

      if (source.community === "supabase" && supabase) {
        const { error } = await supabase.from("name_proposals").insert({
          id: nextProposal.id,
          platform_id: nextProposal.platformId,
          name: nextProposal.name,
          votes: nextProposal.votes,
          created_at: nextProposal.createdAt,
          device_id: nextProposal.deviceId,
        });

        if (error) {
          throw error;
        }
      }

      setProposals((current) => [nextProposal, ...current]);
    };

    const voteProposal = async (proposalId: string, delta: 1 | -1) => {
      const proposal = proposals.find((entry) => entry.id === proposalId);
      if (!proposal) {
        return;
      }

      if (source.community === "supabase" && supabase) {
        const { error } = await supabase.rpc("vote_name_proposal", {
          proposal_id_input: proposalId,
          delta_input: delta,
        });

        if (error) {
          throw error;
        }
      }

      setProposals((current) =>
        current
          .map((entry) =>
            entry.id === proposalId
              ? { ...entry, votes: Math.max(0, entry.votes + delta) }
              : entry,
          )
          .sort((left, right) => right.votes - left.votes),
      );
    };

    const getLatestReaction = (submissionId: string) => reactionStore.get(submissionId);

    return {
      deviceId,
      platforms,
      ratings,
      proposals,
      draft,
      isHydrated,
      bootError,
      source,
      setDraft,
      getPlatform,
      getPlatformStats,
      getStationPlatforms,
      submitRating,
      submitProposal,
      voteProposal,
      getLatestReaction,
      leaderboard: buildLeaderboard(platforms, ratings, proposals),
    };
  }, [bootError, deviceId, draft, isHydrated, platforms, proposals, ratings, source]);

  return <GleisContext.Provider value={value}>{children}</GleisContext.Provider>;
}

export function useGleis() {
  const context = useContext(GleisContext);

  if (!context) {
    throw new Error("useGleis must be used inside GleisProvider");
  }

  return context;
}
