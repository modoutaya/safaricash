// Auth feature Zod schemas.
// Phone + credentials validation lives here so the LoginForm, useLogin
// hook, and /re-auth Edge Function share the same regex + length floor.
// Senegal is the only market at MVP; future WAEMU expansion extends this
// module instead of copying regexes across call sites.

import { z } from "zod";

export const SENEGAL_PHONE_REGEX = /^\+221[0-9]{9}$/;

/** Zod schema for a fully-normalized Senegal mobile in E.164 format. */
export const PhoneSchema = z
  .string()
  .regex(SENEGAL_PHONE_REGEX, "Numéro invalide")
  .describe("E.164 Senegal mobile, e.g. +221777915898");

export type Phone = z.infer<typeof PhoneSchema>;

/** Zod schema for the collector password. Minimum 6 characters mirrors
 *  Supabase Auth's server-side floor — nothing stronger at MVP per
 *  Story 1.5b AC #13 (password complexity deferred). */
export const PasswordSchema = z
  .string()
  .min(6, "Mot de passe trop court")
  .describe("Collector password (≥ 6 chars)");

export type Password = z.infer<typeof PasswordSchema>;

/** Composed credentials schema consumed by LoginForm + useLogin. */
export const CredentialsSchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema,
});

export type Credentials = z.infer<typeof CredentialsSchema>;

// Story 1.6 — useIdleTimeout hook contract.
export interface IdleTimeoutConfig {
  /** Idle window in ms before onExpired fires (production: 30 * 60_000). */
  idleMs: number;
  /** Absolute session lifetime in ms since first sign-in (production: 30 * 24 * 60 * 60_000). */
  absoluteLifetimeMs: number;
  /** Called on idle expiry OR absolute-lifetime overflow. Production = () => supabase.auth.signOut(). */
  onExpired: () => void | Promise<void>;
}
