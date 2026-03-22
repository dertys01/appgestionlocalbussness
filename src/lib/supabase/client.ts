import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lmygvpruffpspixrsixh.supabase.co';
const SUPABASE_ANON_KEY = 'SUPABASE_KEY_A_ROTATIONNER';

let clientInstance: ReturnType<typeof createSupabaseClient> | null = null;

export function createClient() {
  if (!clientInstance) {
    clientInstance = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return clientInstance;
}
