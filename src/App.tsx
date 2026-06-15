import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { Auth } from './components/Auth';
import { Entries } from './components/Entries';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1) текущая сессия при загрузке
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    // 2) подписка на вход/выход
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return <main className="container"><p>Загрузка…</p></main>;

  return (
    <main className="container">
      <header className="header">
        <h1>Мой проект 🚀</h1>
        {session && (
          <button className="ghost" onClick={() => supabase.auth.signOut()}>
            Выйти
          </button>
        )}
      </header>

      {/* Нет сессии → показываем вход. Есть → показываем приложение. */}
      {!session ? <Auth /> : <Entries userEmail={session.user.email ?? ''} />}
    </main>
  );
}
