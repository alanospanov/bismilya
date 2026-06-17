import { Space3D } from './components/Space3D';

// Главный экран — 3D-пространство с коллизией.
// (Вход/база из стартового шаблона временно отключены: пространству Supabase не нужен.
//  Файлы Auth.tsx / Entries.tsx / supabase.ts остались в проекте — подключишь позже, когда настроишь ключи.)
export default function App() {
  return <Space3D />;
}
