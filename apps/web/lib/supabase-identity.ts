import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const storageKey = "samtdi-identity";
let client: SupabaseClient | null = null;

export function identityClient() {
  if (typeof window === "undefined") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  if (!client) {
    client = createClient(url, key, {
      auth: { flowType: "pkce", storage: window.sessionStorage, storageKey, detectSessionInUrl: true },
    });
  }
  return client;
}

export async function clearIdentitySession() {
  const identity = identityClient();
  if (!identity) return;
  try {
    await identity.auth.signOut({ scope: "local" });
  } finally {
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(storageKey + "-code-verifier");
    sessionStorage.removeItem("samtdi-oauth-authorization");
  }
}
