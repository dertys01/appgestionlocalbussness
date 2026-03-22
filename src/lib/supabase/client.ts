import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lmygvpruffpspixrsixh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxteWd2cHJ1ZmZwc3BpeHJzaXhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjMyMzQsImV4cCI6MjA4OTY5OTIzNH0.41qxcJZZtucXBYk8JDQo9WtiS6dITqK6xzI_PiPqKwk';

let clientInstance: ReturnType<typeof createSupabaseClient> | null = null;

export function createClient() {
  if (!clientInstance) {
    clientInstance = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return clientInstance;
}
