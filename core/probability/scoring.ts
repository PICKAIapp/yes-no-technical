// scoring.ts - Skill-based scoring system for PICKAI
export type LiquidityTier = 1 | 2 | 3;

export type PickInput = {
  userId: string;
  eventId: string;
  marketId: string;
  optionId: string;
  title?: string;
  category?: string; // 'crypto'|'macro'|'sports'|'politics'|'ent'|...
  pChosenRaw: number; // 0..1 at entry
  volumeUsd: number;
  entryAt: string; // ISO timestamp
  closesAt: string; // ISO timestamp
  // Resolution (optional)
  resolved?: boolean;
  winnerOptionId?: string;
  resolvedAt?: string;
  // Movement inputs (optional)
  pEnd?: number; // probability at scoreAt for chosen option
  // Submission tracking
  lockedAt?: string; // When submitted as part of batch
  softLockedAt?: string; // When individually confirmed
};

export type PickScore = {
  marketId: string;
  optionId: string;
  score: number;
  meta: {
    pEntry: number;
    pEnd?: number;
    rarity: number;
    liqTier: LiquidityTier;
    holdHours: number;
    mHold: number;
    mLiq: number;
    zMove: number;
    resolved?: boolean;
    correct?: boolean;
    entryAt: string;
  };
};

export type WeeklyScore = {
  userId: string;
  eventId: string;
  total: number;
  counted: PickScore[];
  dropped: PickScore[];
  avgRarity: number;
  correctPicks: number;
  submittedAt?: string;
};

// Scoring constants
export const SCORING = {
  EPS: 0.02,
  BASE_WIN: 40,
  BASE_LOSS_CAP: -15,
  W_RAR: 60, // Rarity weight
  RAR_CAP: Math.log(1 / 0.05), // Cap rarity at 5%
  W_MOVE: 15, // Price movement weight
  H_CAP: 12, // Hours to full hold multiplier
  MIN_HOLD: 2, // Minimum hold hours
  LIQ_T1: 500_000, // Tier 1 threshold
  LIQ_T2: 5_000_000, // Tier 2 threshold
  TOP_M: 6, // Count best 6 picks
  CAT_CAP: 3, // Max picks per category
  PARTIAL_UNRESOLVED: true, // Score unresolved markets partially
  MIN_PICKS: 6, // Minimum picks to submit
  MAX_PICKS: 10, // Maximum picks allowed
} as const;

// Helper functions
export const clamp01 = (p: number, eps = SCORING.EPS): number =>
  Math.max(eps, Math.min(1 - eps, p));

export const liqTier = (v: number): LiquidityTier =>
  v >= SCORING.LIQ_T2 ? 3 : v >= SCORING.LIQ_T1 ? 2 : 1;

export const holdMultiplier = (h: number): number => {
  if (h < SCORING.MIN_HOLD) return 0;
  return 0.7 + 0.3 * Math.min(1, h / SCORING.H_CAP);
};

export const hoursBetween = (aISO: string, bISO: string): number =>
  Math.max(0, (new Date(bISO).getTime() - new Date(aISO).getTime()) / 3_600_000);

// Z-score helper for price movement normalization
export function zFromDelta(delta: number, mean = 0, std = 1): number {
  return std > 0 ? (delta - mean) / std : 0;
}

// Calculate movement statistics for a set of picks
export function calculateMovementStats(picks: PickInput[]): { mean: number; std: number } {
  const movements = picks
    .filter(p => typeof p.pEnd === 'number')
    .map(p => (p.pEnd || p.pChosenRaw) - p.pChosenRaw);
  
  if (movements.length === 0) return { mean: 0, std: 1 };
  
  const mean = movements.reduce((a, b) => a + b, 0) / movements.length;
  const variance = movements.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / movements.length;
  const std = Math.sqrt(variance) || 1;
  
  return { mean, std };
}

// Score a single pick
export function scoreSinglePick(
  input: PickInput,
  scoreAtISO: string,
  movementNorm?: { mean: number; std: number }
): PickScore {
  const pEntry = clamp01(input.pChosenRaw);
  const rarity = Math.min(Math.log(1 / pEntry), SCORING.RAR_CAP);
  const holdHours = hoursBetween(input.entryAt, scoreAtISO);
  
  // Check minimum hold requirement
  if (holdHours < SCORING.MIN_HOLD) {
    return {
      marketId: input.marketId,
      optionId: input.optionId,
      score: 0,
      meta: {
        pEntry,
        rarity,
        liqTier: liqTier(input.volumeUsd),
        holdHours,
        mHold: 0,
        mLiq: 1,
        zMove: 0,
        resolved: input.resolved,
        entryAt: input.entryAt,
      },
    };
  }
  
  // Calculate multipliers
  const mHold = holdMultiplier(holdHours);
  const lt = liqTier(input.volumeUsd);
  const mLiq = lt === 3 ? 1.06 : lt === 2 ? 1.03 : 1.0;
  
  // Calculate timing bonus (z-score of price movement)
  let zMove = 0;
  if (typeof input.pEnd === 'number') {
    const delta = input.pEnd - pEntry;
    const mean = movementNorm?.mean ?? 0;
    const std = movementNorm?.std ?? 1;
    zMove = zFromDelta(delta, mean, std);
  }
  
  // Calculate base score
  let base = 0;
  let correct: boolean | undefined = undefined;
  
  if (input.resolved && input.winnerOptionId) {
    correct = input.winnerOptionId === input.optionId;
    base = correct
      ? SCORING.BASE_WIN + SCORING.W_RAR * rarity + SCORING.W_MOVE * zMove
      : Math.max(SCORING.BASE_LOSS_CAP, -0.5 * SCORING.W_RAR * rarity);
  } else if (SCORING.PARTIAL_UNRESOLVED) {
    // Partial credit for unresolved markets
    base = 0.25 * SCORING.BASE_WIN + 0.4 * SCORING.W_RAR * rarity + 0.5 * SCORING.W_MOVE * zMove;
  } else {
    base = 0;
  }
  
  // Apply multipliers and round
  const score = Math.round(base * mHold * mLiq * 10) / 10;
  
  return {
    marketId: input.marketId,
    optionId: input.optionId,
    score,
    meta: {
      pEntry,
      pEnd: input.pEnd,
      rarity,
      liqTier: lt,
      holdHours,
      mHold,
      mLiq,
      zMove,
      resolved: input.resolved,
      correct,
      entryAt: input.entryAt,
    },
  };
}

// Enforce category caps
export function enforceCategoryCaps<T extends PickInput>(
  picks: T[],
  cap = SCORING.CAT_CAP
): T[] {
  const categoryCount: Record<string, number> = {};
  const sortedPicks = [...picks].sort((a, b) => 
    new Date(a.entryAt).getTime() - new Date(b.entryAt).getTime()
  );
  
  return sortedPicks.filter(p => {
    const category = p.category ?? 'other';
    categoryCount[category] = (categoryCount[category] ?? 0) + 1;
    return categoryCount[category] <= cap;
  });
}

// Compute weekly score for a user
export function computeWeeklyScore(args: {
  userId: string;
  eventId: string;
  picks: PickInput[];
  scoreAtISO: string;
  movementNorm?: { mean: number; std: number };
}): WeeklyScore {
  // Apply category caps
  const capped = enforceCategoryCaps(args.picks);
  
  // Calculate movement stats if not provided
  const movementNorm = args.movementNorm || calculateMovementStats(capped);
  
  // Score all picks
  const scored = capped.map(p => scoreSinglePick(p, args.scoreAtISO, movementNorm));
  
  // Sort by score descending
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  
  // Take best 6
  const counted = sorted.slice(0, SCORING.TOP_M);
  const dropped = sorted.slice(SCORING.TOP_M);
  
  // Calculate totals and stats
  const total = Math.round(counted.reduce((s, x) => s + x.score, 0) * 10) / 10;
  const avgRarity = counted.length > 0
    ? counted.reduce((s, x) => s + x.meta.rarity, 0) / counted.length
    : 0;
  const correctPicks = counted.filter(x => x.meta.correct === true).length;
  
  // Find submission time if available
  const submittedAt = args.picks.find(p => p.lockedAt)?.lockedAt;
  
  return {
    userId: args.userId,
    eventId: args.eventId,
    total,
    counted,
    dropped,
    avgRarity,
    correctPicks,
    submittedAt,
  };
}

// Generate week ID
export function getCurrentWeekId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  
  // Get Monday of current week
  const dayOfWeek = now.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(monday.getDate() - daysToMonday);
  
  const mondayMonth = String(monday.getMonth() + 1).padStart(2, '0');
  const mondayDay = String(monday.getDate()).padStart(2, '0');
  
  return `week-${year}-${mondayMonth}-${mondayDay}`;
}

// Format hold time for display
export function formatHoldTime(hours: number): string {
  if (hours < 1) {
    const minutes = Math.floor(hours * 60);
    return `${minutes}m`;
  } else if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  } else {
    const days = Math.floor(hours / 24);
    const remainingHours = Math.floor(hours % 24);
    return `${days}d ${remainingHours}h`;
  }
}

// Get a user-friendly score breakdown
export function getScoreBreakdown(score: PickScore): string {
  const parts = [];
  
  if (score.meta.resolved) {
    parts.push(score.meta.correct ? '✓ Correct' : '✗ Wrong');
  } else {
    parts.push('⏳ Pending');
  }
  
  parts.push(`Rarity: ${score.meta.rarity.toFixed(2)}`);
  parts.push(`Hold: ${formatHoldTime(score.meta.holdHours)} (${(score.meta.mHold * 100).toFixed(0)}%)`);
  parts.push(`Tier: ${score.meta.liqTier}`);
  
  if (score.meta.zMove !== 0) {
    parts.push(`Move: ${score.meta.zMove > 0 ? '+' : ''}${score.meta.zMove.toFixed(2)}σ`);
  }
  
  return parts.join(' | ');
}

// Category determination helper
export function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();
  
  // Sports
  if (lower.includes('nfl') || lower.includes('nba') || lower.includes('mlb') || 
      lower.includes('nhl') || lower.includes('soccer') || lower.includes('football') ||
      lower.includes('basketball') || lower.includes('baseball') || lower.includes('hockey') ||
      lower.includes('world series') || lower.includes('super bowl') || lower.includes('champion') || 
      lower.includes('f1') || lower.includes('formula') || lower.includes('race') || 
      lower.includes('ufc') || lower.includes('boxing') || lower.includes('tennis') ||
      lower.includes('golf') || lower.includes('olympic') || lower.includes('world cup') ||
      lower.includes('league') || lower.includes('playoff') || lower.includes('finals') ||
      lower.includes('sport') || lower.includes('us open') || lower.includes('u.s. open') ||
      lower.includes('open championship') || lower.includes('masters') || lower.includes('wimbledon')) {
    return 'sports';
  }
  
  // Politics
  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') || 
      lower.includes('president') || lower.includes('mayor') || lower.includes('senate') || 
      lower.includes('congress') || lower.includes('democrat') || lower.includes('republican') ||
      lower.includes('governor') || lower.includes('vote') || lower.includes('poll') ||
      lower.includes('campaign') || lower.includes('primary') || lower.includes('nominee')) {
    return 'politics';
  }
  
  // Crypto
  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') || 
      lower.includes('eth') || lower.includes('btc') || lower.includes('sol') ||
      lower.includes('bnb') || lower.includes('blockchain') || lower.includes('defi') ||
      lower.includes('nft') || lower.includes('token') || lower.includes('coin')) {
    return 'crypto';
  }
  
  // Economics/Finance (macro)
  if (lower.includes('fed') || lower.includes('gdp') || lower.includes('unemployment') || 
      lower.includes('inflation') || lower.includes('rate') || lower.includes('economy') ||
      lower.includes('recession') || lower.includes('stock') || lower.includes('s&p') ||
      lower.includes('nasdaq') || lower.includes('dow') || lower.includes('market') ||
      lower.includes('earnings') || lower.includes('revenue') || lower.includes('ipo')) {
    return 'economics';
  }
  
  // Entertainment
  if (lower.includes('movie') || lower.includes('film') || lower.includes('box office') ||
      lower.includes('oscar') || lower.includes('grammy') || lower.includes('emmy') ||
      lower.includes('album') || lower.includes('music') || lower.includes('concert') ||
      lower.includes('show') || lower.includes('series') || lower.includes('netflix') ||
      lower.includes('award')) {
    return 'entertainment';
  }
  
  // Tech
  if (lower.includes('spacex') || lower.includes('tesla') || lower.includes('ai') || 
      lower.includes('tech') || lower.includes('apple') || lower.includes('google') ||
      lower.includes('microsoft') || lower.includes('meta') || lower.includes('amazon') ||
      lower.includes('nvidia') || lower.includes('software') || lower.includes('hardware')) {
    return 'tech';
  }
  
  // Geopolitics
  if (lower.includes('israel') || lower.includes('ukraine') || lower.includes('russia') || 
      lower.includes('china') || lower.includes('war') || lower.includes('conflict') ||
      lower.includes('nato') || lower.includes('military') || lower.includes('treaty') ||
      lower.includes('zelensky') || lower.includes('zelenskyy') || lower.includes('putin') ||
      lower.includes('xi jinping') || lower.includes('xi jin ping') || lower.includes('taiwan') ||
      lower.includes('gaza') || lower.includes('palestine') || lower.includes('iran')) {
    return 'geopolitics';
  }
  
  // Science
  if (lower.includes('science') || lower.includes('research') || lower.includes('study') ||
      lower.includes('climate') || lower.includes('temperature') || lower.includes('covid') ||
      lower.includes('vaccine') || lower.includes('drug') || lower.includes('fda')) {
    return 'science';
  }
  
  // Default to other for uncategorized markets
  return 'other';
}
