import { useState, type ChangeEvent } from 'react';
import { ChatPane } from './components/ChatPane.js';
import type { CitationRange } from './components/CitationChip.js';
import { SourcePane } from './components/SourcePane.js';

export function App() {
  const [repoSource, setRepoSource] = useState('');
  const [selectedCitation, setSelectedCitation] = useState<CitationRange | null>(null);

  function handleRepoSourceChange(event: ChangeEvent<HTMLInputElement>): void {
    setRepoSource(event.target.value);
  }

  return (
    <div className="flex h-dvh flex-col bg-white text-gray-900">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
        <h1 className="text-lg font-semibold">Code Documentation Assistant</h1>
        <input
          className="ml-auto w-64 rounded border border-gray-300 px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-accent"
          value={repoSource}
          onChange={handleRepoSourceChange}
          placeholder="repo source (e.g. ./tmp/hono)"
          aria-label="repo source"
        />
      </header>
      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <ChatPane repoSource={repoSource} onCitationSelect={setSelectedCitation} />
        </div>
        <div className="w-96 flex-shrink-0 overflow-hidden border-l border-gray-200">
          <SourcePane repoSource={repoSource} selection={selectedCitation} />
        </div>
      </main>
    </div>
  );
}
