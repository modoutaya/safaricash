// RFC 7807 Problem Details builder for Edge Function errors.
// architecture.md § Communication Patterns mandates this format for all
// 4xx / 5xx responses across Edge Functions.

const PROBLEM_BASE = "https://safaricash.app/problems";

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};

export type Problem = {
  status: number;
  body: ProblemBody;
};

export const KNOWN_PROBLEMS = {
  auth_unauthenticated: {
    status: 401,
    type: `${PROBLEM_BASE}/auth/unauthenticated`,
    title: "Unauthenticated",
  },
  auth_user_not_provisioned: {
    status: 403,
    type: `${PROBLEM_BASE}/auth/user_not_provisioned`,
    title: "User not provisioned",
  },
  request_invalid: {
    status: 400,
    type: `${PROBLEM_BASE}/request/invalid`,
    title: "Invalid request",
  },
  otp_invalid: {
    status: 401,
    type: `${PROBLEM_BASE}/otp/invalid`,
    title: "Invalid OTP",
  },
  otp_expired: {
    status: 410,
    type: `${PROBLEM_BASE}/otp/expired`,
    title: "OTP expired",
  },
  otp_already_used: {
    status: 409,
    type: `${PROBLEM_BASE}/otp/already_used`,
    title: "OTP already used",
  },
  otp_locked: {
    status: 429,
    type: `${PROBLEM_BASE}/otp/locked`,
    title: "Too many attempts",
  },
  otp_resend_too_soon: {
    status: 429,
    type: `${PROBLEM_BASE}/otp/resend_too_soon`,
    title: "Resend too soon",
  },
  otp_delivery_failed: {
    status: 502,
    type: `${PROBLEM_BASE}/otp/delivery_failed`,
    title: "OTP delivery failed",
  },
  challenge_not_found: {
    status: 404,
    type: `${PROBLEM_BASE}/challenge/not_found`,
    title: "Challenge not found",
  },
  confirmation_invalid: {
    status: 403,
    type: `${PROBLEM_BASE}/confirmation/invalid`,
    title: "Confirmation token invalid or expired",
  },
  internal_unexpected: {
    status: 500,
    type: `${PROBLEM_BASE}/internal/unexpected`,
    title: "Internal server error",
  },
} as const;

export type KnownProblemKey = keyof typeof KNOWN_PROBLEMS;

export function problem(
  key: KnownProblemKey,
  detail: string,
  extra: Record<string, unknown> = {},
): Problem {
  const known = KNOWN_PROBLEMS[key];
  return {
    status: known.status,
    body: {
      type: known.type,
      title: known.title,
      status: known.status,
      detail,
      ...extra,
    },
  };
}

export function problemResponse(
  p: Problem,
  instance?: string,
  headers: HeadersInit = {},
): Response {
  const body: ProblemBody = { ...p.body };
  if (instance) body.instance = instance;
  return new Response(JSON.stringify(body), {
    status: p.status,
    headers: {
      "Content-Type": "application/problem+json",
      ...headers,
    },
  });
}
