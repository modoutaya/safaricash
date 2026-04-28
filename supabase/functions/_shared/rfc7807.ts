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
  // Story 6.2 — sms-worker drains rows belonging to ALL collectors. Running
  // it under any other JWT would constrain the drain to one collector's
  // rows and starve every other queue.
  auth_service_role_required: {
    status: 403,
    type: `${PROBLEM_BASE}/auth/service_role_required`,
    title: "Service role required",
  },
  request_invalid: {
    status: 400,
    type: `${PROBLEM_BASE}/request/invalid`,
    title: "Invalid request",
  },
  // Story 6.1 — sms-dispatch needs distinct 404 / 405 codes.
  not_found: {
    status: 404,
    type: `${PROBLEM_BASE}/request/not_found`,
    title: "Not found",
  },
  method_not_allowed: {
    status: 405,
    type: `${PROBLEM_BASE}/request/method_not_allowed`,
    title: "Method not allowed",
  },
  // Story 1.5b — password re-auth (PRD v1.3). Replaces the otp_* keys from
  // Story 1.3. The Edge Function never returns enumeration-distinguishing
  // errors: "credentials_invalid" covers both unknown phone and wrong password.
  credentials_invalid: {
    status: 401,
    type: `${PROBLEM_BASE}/credentials/invalid`,
    title: "Invalid credentials",
  },
  rate_limited: {
    status: 429,
    type: `${PROBLEM_BASE}/rate/limited`,
    title: "Too many attempts",
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
