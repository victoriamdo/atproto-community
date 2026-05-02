// Remove this file once `@fujocoded/astro-atproto-loader` ships
// `resolveHandleToDid` (and ideally a `fetchHandle: true` source option that
// gives a TS-level guarantee `repo.handle` is set). Until then, this is the
// local copy used by the community directory.
import { DidResolver, HandleResolver, MemoryCache, getHandle } from '@atproto/identity';

const didCache = new MemoryCache();
const didResolver = new DidResolver({ didCache });
const handleResolver = new HandleResolver({});

export async function resolveHandleToDid(handleOrDid: string): Promise<string> {
  if (handleOrDid.startsWith('did:')) return handleOrDid;

  const normalized = handleOrDid.toLowerCase().replace(/^@/, '');
  const did = await handleResolver.resolve(normalized);
  if (!did) {
    throw new Error(`Could not resolve handle "${handleOrDid}" to a DID`);
  }

  const doc = await didResolver.resolve(did);
  if (!doc) {
    throw new Error(`Could not resolve DID document for "${did}"`);
  }
  const docHandle = getHandle(doc);
  if (!docHandle || docHandle.toLowerCase() !== normalized) {
    throw new Error(
      `Handle verification failed: "${handleOrDid}" does not match DID document handle "${docHandle ?? 'none'}"`,
    );
  }

  return did;
}
