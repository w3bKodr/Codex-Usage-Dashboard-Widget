export type AccountState = {
  connected: boolean;
  email?: string | null;
  plan?: string | null;
};

export type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number | null;
  windowDurationMins?: number | null;
  limitId?: string | null;
  limitName?: string | null;
};

export type DashboardSnapshot = {
  account: AccountState;
  fiveHour?: UsageWindow | null;
  weekly?: UsageWindow | null;
  tokensToday?: number | null;
  tokenBucketDate?: string | null;
  lifetimeTokens?: number | null;
  creditsBalance?: string | null;
  creditsUnlimited?: boolean;
  fetchedAt: number;
};

export type LoginStart = {
  loginId: string;
  authUrl: string;
};

export type WidgetSettings = {
  opacity: number;
  backgroundColor: string;
  startWithWindows: boolean;
  desktopMode: boolean;
};

export type UsageSample = {
  capturedAt: number;
  usedPercent: number;
  resetAt: number | null;
  windowKind?: "fiveHour" | "weekly";
};
