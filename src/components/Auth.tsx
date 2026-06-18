import { useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

// Страница входа: регистрация/вход по почте, вход как гость, вход через Google.
// Email и Google работают через Supabase (нужны ключи); гость — локально, без бэкенда.
export function Auth({ onGuest }: { onGuest: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const noBackend = 'Вход по почте/Google недоступен: не настроены ключи Supabase. Можно войти как гость.';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isSupabaseConfigured || !supabase) { setMessage(noBackend); return; }
    setBusy(true); setMessage('');
    try {
      const { error } =
        mode === 'signup'
          ? await supabase.auth.signUp({ email, password })
          : await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(error.message);
      else if (mode === 'signup') setMessage('Готово! Проверь почту для подтверждения, затем войди.');
      // при успешном входе сессия поднимется и App переключится на игру (onAuthStateChange)
    } catch {
      setMessage('Что-то пошло не так. Попробуй ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    if (!isSupabaseConfigured || !supabase) { setMessage(noBackend); return; }
    setBusy(true); setMessage('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) { setMessage(error.message); setBusy(false); }
    // при успехе браузер уходит на страницу Google → возвращается с сессией
  }

  // ── стили ──
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15,
    fontFamily: 'monospace', background: 'rgba(255,255,255,0.06)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: 10, outline: 'none',
  };
  const btnBase: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '12px 0', fontSize: 16,
    fontWeight: 'bold', fontFamily: 'monospace', borderRadius: 10, cursor: 'pointer', border: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 30%, #10202a 0%, #05070a 70%)',
        color: '#fff', fontFamily: 'monospace',
      }}
    >
      <div
        style={{
          width: 'min(92vw, 380px)', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: 14,
          background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,40,25,0.25)', borderRadius: 18,
          boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            textAlign: 'center', fontSize: 30, fontWeight: 'bold', letterSpacing: 4, marginBottom: 2,
            textShadow: '0 0 18px #ff2a1a, 0 0 36px #7a0000',
          }}
        >
          SPAID CAN ...
        </div>
        <div style={{ textAlign: 'center', fontSize: 16, opacity: 0.85, marginBottom: 6 }}>
          {mode === 'signin' ? 'Вход' : 'Регистрация'}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email" placeholder="почта (email)" value={email}
            onChange={(e) => setEmail(e.target.value)} required style={inputStyle}
          />
          <input
            type="password" placeholder="пароль (6+ символов)" value={password}
            onChange={(e) => setPassword(e.target.value)} minLength={6} required style={inputStyle}
          />
          <button type="submit" disabled={busy} style={{ ...btnBase, background: '#2bd24f', color: '#05140a' }}>
            {busy ? '…' : mode === 'signin' ? 'Войти' : 'Создать аккаунт'}
          </button>
        </form>

        <button
          onClick={() => { setMessage(''); setMode(mode === 'signin' ? 'signup' : 'signin'); }}
          style={{ ...btnBase, background: 'transparent', color: '#9fd0ff', fontSize: 13, padding: '2px 0' }}
        >
          {mode === 'signin' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>

        {/* разделитель */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.5, fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.25)' }} />
          или
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.25)' }} />
        </div>

        <button
          onClick={handleGoogle} disabled={busy}
          style={{ ...btnBase, background: '#fff', color: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
        >
          <span style={{ fontWeight: 'bold', fontSize: 18, color: '#4285F4' }}>G</span>
          Войти через Google
        </button>

        <button
          onClick={onGuest}
          style={{ ...btnBase, background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}
        >
          Войти как гость
        </button>

        {message && (
          <p style={{ margin: 0, marginTop: 4, fontSize: 13, color: '#ffb3a8', textAlign: 'center', lineHeight: 1.4 }}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
