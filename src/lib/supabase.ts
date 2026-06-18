import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Значения берутся из env (.env.local / Vercel), а если их нет — из запасных
// констант ниже. Anon-ключ Supabase ПУБЛИЧНЫЙ по дизайну (он попадает в любой
// клиентский бандл), данные защищены политиками RLS — поэтому держать его в
// коде безопасно. Благодаря этому вход работает и локально, и на Vercel без
// ручной настройки переменных окружения.
const FALLBACK_URL = 'https://ghtuoknkfajqsbyciiyu.supabase.co';
const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdodHVva25rZmFqcXNieWNpaXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MTI1NzksImV4cCI6MjA5NzA4ODU3OX0.rhBkPSOWIE9i6rrCeAHKtFVn2fHKHT8Zr5N48SZKE_w';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || FALLBACK_URL;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || FALLBACK_ANON_KEY;

// Настроен ли Supabase (на всякий случай — вдруг кто-то подставит плейсхолдеры).
export const isSupabaseConfigured = Boolean(
  url && anonKey && !url.includes('ТВОЙ') && !anonKey.includes('твой'),
);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url, anonKey)
  : null;
