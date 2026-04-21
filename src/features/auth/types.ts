// Story 1.5 — Auth feature Zod schemas.
//
// Phone validation lives here so the LoginForm, useLogin hook, and any
// future re-auth replay share the same regex. Senegal is the only Termii-
// supported market at MVP; future expansion (Mali 223, Côte d'Ivoire 225)
// would extend this module, not copy its regex across call sites.

import { z } from "zod";

export const SENEGAL_PHONE_REGEX = /^\+221[0-9]{9}$/;

/** Zod schema for a fully-normalized Senegal mobile in E.164 format. */
export const PhoneSchema = z
  .string()
  .regex(SENEGAL_PHONE_REGEX, "Numéro invalide")
  .describe("E.164 Senegal mobile, e.g. +221777915898");

export type Phone = z.infer<typeof PhoneSchema>;

/** Zod schema for the 6-digit SMS OTP. */
export const OtpSchema = z
  .string()
  .regex(/^\d{6}$/, "Code à 6 chiffres")
  .describe("6-digit OTP");

// Story 1.6 — useIdleTimeout hook contract.
export interface IdleTimeoutConfig {
  /** Idle window in ms before onExpired fires (production: 30 * 60_000). */
  idleMs: number;
  /** Absolute session lifetime in ms since first sign-in (production: 30 * 24 * 60 * 60_000). */
  absoluteLifetimeMs: number;
  /** Called on idle expiry OR absolute-lifetime overflow. Production = () => supabase.auth.signOut(). */
  onExpired: () => void | Promise<void>;
}
