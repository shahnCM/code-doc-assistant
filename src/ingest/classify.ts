import path from 'node:path';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.md': 'markdown',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.json': 'json',
  '.toml': 'toml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'shell',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
};

export function classify(filePath: string): { extension: string; language: string } {
  const extension = path.extname(filePath).toLowerCase();
  const language = LANGUAGE_BY_EXTENSION[extension] ?? 'unknown';
  return { extension, language };
}
