/** major.minor.patch of a version; a prerelease sorts below its release. Undefined when it is not a version. */
function versionRank(version: string | undefined): [number, number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version?.trim() ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : undefined;
}

/**
 * Whether `candidate` is a later version than `than`. The first argument is the one being asked about: this runs the
 * other way round from update-check's isNewerVersion(current, latest). A version that cannot be read is never later,
 * and anything readable is later than one that cannot be read: callers move to a later version only on evidence.
 */
export function isVersionAfter(candidate: string | undefined, than: string | undefined): boolean {
  const a = versionRank(candidate);
  const b = versionRank(than);
  if (!a) return false;
  if (!b) return true;
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index]! > b[index]!;
}
