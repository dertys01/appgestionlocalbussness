import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// La clé anon est publique par nature, mais la garder en dur ici figeait le
// projet Supabase dans le code : le pointer ailleurs, ou faire tourner une
// seconde branche (staging, preview Vercel) exigeait une modification source.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY doivent être définies (voir .env.local.example).'
  );
}

let clientInstance: ReturnType<typeof createSupabaseClient> | null = null;

export function createClient() {
  if (!clientInstance) {
    clientInstance = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return clientInstance;
}
