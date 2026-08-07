import { ChatPane } from './components/ChatPane.js';

export function App() {
  return (
    <div className="flex h-dvh flex-col bg-white text-gray-900">
      <header className="border-b border-gray-200 px-4 py-3">
        <h1 className="text-lg font-semibold">Code Documentation Assistant</h1>
      </header>
      <main className="flex flex-1 overflow-hidden">
        <ChatPane repoSource="" />
      </main>
    </div>
  );
}
