import { useEffect, useState } from 'react';
import { Space3D } from './components/Space3D';
import { Auth } from './components/Auth';
import { supabase } from './lib/supabase';

const GUEST_KEY = 'spaidcan_guest';

// Сначала страница входа (почта / гость / Google), затем игра.
export default function App() {
  const [ready, setReady] = useState(false); // проверили ли сессию
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    // гость запомнен локально — сразу в игру
    if (localStorage.getItem(GUEST_KEY) === '1') { setAuthed(true); setReady(true); return; }
    // Supabase не настроен — остаёмся на странице входа (доступен только гость)
    if (!supabase) { setReady(true); return; }
    // есть ли активная сессия (вход по почте/Google)
    supabase.auth.getSession().then(({ data }) => {
      setAuthed(!!data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthed(!!session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const enterAsGuest = () => {
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* нет localStorage */ }
    setAuthed(true);
  };

  if (!ready) return null; // короткая пауза, пока проверяется сессия
  if (!authed) return <Auth onGuest={enterAsGuest} />;
  return <Space3D />;
}
