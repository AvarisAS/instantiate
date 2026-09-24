import { execFileSync } from 'node:child_process';

/**
 * Where this code lives, if it lives anywhere shared.
 *
 * A report travels — attached to a mail, dropped in a channel — and the first
 * thing a reader wants from a finding is the file it names, in the repository
 * they already have open. Knowing the remote turns every path in the report
 * into a link to the real thing.
 */
export interface Repo {
  /** Browsable base, e.g. https://github.com/org/name */
  url: string;
  /** Branch or commit the report was generated from. */
  ref: string;
  /** Path segment used to link to a file, which differs per host. */
  blobPath: string;
}

export function detectRepo(root: string): Repo | undefined {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  if (!remote) return undefined;

  const url = normalise(remote);
  if (!url) return undefined;

  // The branch name is friendlier in a link than a hash, but a detached head
  // has no branch and the hash is then the only honest answer.
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const ref = !branch || branch === 'HEAD' ? git(root, ['rev-parse', 'HEAD']) || 'HEAD' : branch;

  return { url, ref, blobPath: url.includes('bitbucket.org') ? 'src' : 'blob' };
}

/** A file's line in the remote, or nothing when the host is not one we know. */
export function fileUrl(repo: Repo, path: string, line?: number): string | undefined {
  if (!/github\.com|gitlab\.com|bitbucket\.org/.test(repo.url)) return undefined;
  const at = line && line > 1 ? `#L${line}` : '';
  return `${repo.url}/${repo.blobPath}/${repo.ref}/${path}${at}`;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // Not a repository, or no remote: neither is an error here.
  }
}

/** SSH and https forms of the same remote, reduced to something browsable. */
function normalise(remote: string): string | undefined {
  let url = remote.trim().replace(/\.git$/, '');

  // git@host:org/name  ->  https://host/org/name
  const ssh = url.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  else if (url.startsWith('ssh://')) url = url.replace(/^ssh:\/\/(?:[^@]+@)?/, 'https://');
  else if (url.startsWith('git://')) url = url.replace(/^git:\/\//, 'https://');

  // Anything that is not a URL by now is a local path, which nobody can open.
  return /^https?:\/\/[^/]+\/.+/.test(url) ? url : undefined;
}
