export type Platform = {
  id: string;
  stationName: string;
  stationCode: string;
  platform: string;
  coordinates?: {
    start: {
      lat: number;
      lng: number;
    };
    end: {
      lat: number;
      lng: number;
    };
  };
};

export type PrideVote = "yes" | "complicated" | "no";

export type RatingInput = {
  vibe: number;
  refuel: number;
  seating: number;
  pride: PrideVote;
  umbrella: boolean;
  comment?: string;
};

export type RatingRecord = RatingInput & {
  id: string;
  platformId: string;
  createdAt: string;
  deviceId: string;
};

export type NameProposal = {
  id: string;
  platformId: string;
  name: string;
  votes: number;
  createdAt: string;
  deviceId?: string;
};

export type SubmissionReaction = {
  submissionId: string;
  platformId: string;
  headline: string;
  detail: string;
  statLabel: string;
  statValue: string;
};

export type LeaderboardEntry = {
  platform: Platform;
  title: string;
  value: string;
  caption: string;
};

export type PlatformStats = {
  totalRatings: number;
  averageVibe: number;
  averageRefuel: number;
  averageSeating: number;
  seatingPositivePercent: number;
  prideSplit: Record<PrideVote, number>;
  umbrellaYesPercent: number;
  topComments: RatingRecord[];
  topProposal?: NameProposal;
  controversialIndex: number;
};

export type AppSource = {
  platforms: "seed" | "sbb-cache" | "sbb-live";
  community: "local" | "supabase";
};
