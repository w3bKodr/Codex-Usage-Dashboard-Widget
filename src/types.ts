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

export type ResetCredit = {
  id: string;
  status: string;
  title: string;
  description?: string | null;
  grantedAt?: string | null;
  expiresAt: string;
};

export type ResetCreditsState = {
  availableCount: number;
  credits: ResetCredit[];
  fetchedAt: number;
};

export type ConsumeResetResult = {
  outcome: string;
  resetCredits: ResetCreditsState;
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
