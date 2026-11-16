import { execa } from 'execa';
import type { ReferenceRepository } from './workspace-reference-resolve.js';

/** Filename metadata only: never use the content-reading change/fingerprint listing here. */
export async function listReferenceRepositoryFiles(repo: ReferenceRepository): Promise<readonly string[]> {
  const { stdout } = await execa('git', ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo.repoPath,
    stripFinalNewline: false,
    // Suffix lookup is a fallback. Oversized listings fail closed via the resolver's listing-error path.
    maxBuffer: 4 * 1024 * 1024,
  });
  return [...new Set(stdout.split('\0').filter(Boolean))];
}
