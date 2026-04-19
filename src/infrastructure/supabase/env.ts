import { z } from "zod";

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url("VITE_SUPABASE_URL must be a valid URL"),
  VITE_SUPABASE_ANON_KEY: z
    .string()
    .min(20, "VITE_SUPABASE_ANON_KEY looks too short to be a real Supabase JWT"),
});

export class SupabaseEnvError extends Error {
  override readonly name = "SupabaseEnvError";
  constructor(message: string) {
    super(message);
  }
}

function loadEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse({
    VITE_SUPABASE_URL: import.meta.env["VITE_SUPABASE_URL"],
    VITE_SUPABASE_ANON_KEY: import.meta.env["VITE_SUPABASE_ANON_KEY"],
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new SupabaseEnvError(
      `SafariCash Supabase env validation failed (.env.local? .env.example?). ${issues}`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
