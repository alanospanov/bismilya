import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Ключи берутся из .env.local (локально) и из Vercel → Settings → Environment Variables (на проде).
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Настроен ли Supabase (ключи вставлены и это не плейсхолдеры из .env.example).
export const isSupabaseConfigured = Boolean(
  url && anonKey && !url.includes('ТВОЙ') && !anonKey.includes('твой'),
);

// Если ключей нет — НЕ роняем приложение (раньше тут бросалось исключение и был
// белый экран). Возвращаем null; вход по почте/Google будет недоступен, а игра
// и режим гостя продолжат работать.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : null;
