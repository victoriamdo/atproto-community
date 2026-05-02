import { Agent } from '@atproto/api';
import type { AtProfile } from './types.js';
import { resolveHandleToDid } from './identity.js';

const PUBLIC_API = 'https://public.api.bsky.app';

const profileCache = new Map<string, AtProfile>();

// Curated source accounts (community handles + the site's own account) live in a
// separate, never-evicted cache. Warmed once at server boot via prefetchSourceProfiles
// so per-record transformers in live.config.ts hit it instead of refetching.
// Kept distinct from profileCache so any future eviction policy on the general
// cache (LRU/TTL for arbitrary external authors) doesn't drop our known set.
const sourceProfileCache = new Map<string, AtProfile>();

async function fetchProfile(handleOrDid: string): Promise<AtProfile> {
  let did: string;
  try {
    did = await resolveHandleToDid(handleOrDid);
  } catch {
    did = handleOrDid;
  }

  try {
    const agent = new Agent(new URL(PUBLIC_API));
    const response = await agent.getProfile({ actor: did });
    return {
      did: response.data.did,
      handle: response.data.handle,
      displayName: response.data.displayName || undefined,
      avatar: response.data.avatar || undefined,
    };
  } catch (err) {
    console.warn(`Failed to fetch profile for ${did}:`, err);
    return {
      did,
      handle: handleOrDid.startsWith('did:') ? did : handleOrDid,
    };
  }
}

export async function prefetchSourceProfiles(handles: string[]): Promise<void> {
  const results = await Promise.allSettled(handles.map((h) => fetchProfile(h)));
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const profile = result.value;
    // Index by every key callers might pass: original handle (may differ from
    // canonical), resolved did, and resolved handle.
    sourceProfileCache.set(handles[i], profile);
    sourceProfileCache.set(profile.did, profile);
    sourceProfileCache.set(profile.handle, profile);
  });
}

export async function getProfile(handleOrDid: string): Promise<AtProfile> {
  const sourceHit = sourceProfileCache.get(handleOrDid);
  if (sourceHit) return sourceHit;

  let did: string;
  try {
    did = await resolveHandleToDid(handleOrDid);
  } catch {
    did = handleOrDid;
  }

  const sourceHitByDid = sourceProfileCache.get(did);
  if (sourceHitByDid) return sourceHitByDid;

  const cached = profileCache.get(did);
  if (cached) return cached;

  const profile = await fetchProfile(handleOrDid);
  profileCache.set(did, profile);
  return profile;
}
