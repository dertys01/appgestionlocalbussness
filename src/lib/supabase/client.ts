import { createBrowserClient } from '@supabase/ssr';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://lmygvpruffpspixrsixh.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxteWd2cHJ1ZmZwc3BpeHJzaXhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjMyMzQsImV4cCI6MjA4OTY5OTIzNH0.41qxcJZZtucXBYk8JDQo9WtiS6dITqK6xzI_PiPqKwk';

export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
