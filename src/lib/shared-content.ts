/**
 * Fetch community.opensocial.sharedContent records from ATProto accounts.
 * For each shared document, fetches the full standard.site document and
 * resolves the author's Bluesky profile.
 */

import { getProfile, type AtProfile } from './atproto';
import { parseEvent, type CommunityEvent, type RawEvent } from './events';

const COLLECTION = 'community.opensocial.sharedContent';

export interface SharedPost {
  title: string;
  excerpt: string;
  author: AtProfile;
  date: string;
  href: string;
  sharedBy: string;
  community: string;  // Handle of the account that shared this content
  tags: string[];
}

interface RawSharedContent {
  $type: string;
  title: string;
  path?: string;
  type: string;
  sharedAt: string;
  sharedBy: string;
  documentUri: string;
  documentCid: string;
  // Event-specific fields (present when type='event')
  startsAt?: string;
  endsAt?: string;
  location?: string;
  mode?: string;
}

interface RawDocument {
  title?: string;
  description?: string;
  textContent?: string;
  publishedAt?: string;
  path?: string;
  site?: string;
  tags?: string[];
}

/**
 * Resolve a handle to DID using the public API.
 */
async function resolveHandle(handle: string): Promise<string> {
  if (handle.startsWith('did:')) return handle;
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  );
  if (!res.ok) throw new Error(`Failed to resolve handle ${handle}: ${res.status}`);
  const data = await res.json();
  return data.did;
}

/**
 * Look up the PDS endpoint for a DID.
 */
async function resolvePds(did: string): Promise<string> {
  if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length);
    const res = await fetch(`https://${domain}/.well-known/did.json`);
    if (!res.ok) throw new Error(`Failed to resolve did:web ${did}`);
    const doc = await res.json();
    const svc = doc.service?.find(
      (s: { id: string; serviceEndpoint: string }) =>
        s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`
    );
    if (!svc) throw new Error(`No PDS for ${did}`);
    return svc.serviceEndpoint;
  }
  const res = await fetch(`https://plc.directory/${did}`);
  if (!res.ok) throw new Error(`Failed to resolve PDS for ${did}`);
  const doc = await res.json();
  const svc = doc.service?.find(
    (s: { id: string; serviceEndpoint: string }) => s.id === '#atproto_pds'
  );
  if (!svc) throw new Error(`No PDS for ${did}`);
  return svc.serviceEndpoint;
}

/**
 * Fetch a single ATProto record by AT-URI.
 */
async function fetchRecord(atUri: string): Promise<RawDocument | null> {
  const match = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, repo, collection, rkey] = match;

  try {
    const pds = await resolvePds(repo);
    const params = new URLSearchParams({ repo, collection, rkey });
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.value as RawDocument;
  } catch {
    return null;
  }
}

/**
 * Extract an excerpt from text content.
 */
function makeExcerpt(text: string | undefined, maxLen = 150): string {
  if (!text) return '';
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, '')       // heading markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold
    .replace(/\*([^*]+)\*/g, '$1')      // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/[`~]/g, '')               // code/strikethrough markers
    .replace(/^[-*>]\s+/gm, '')         // list items, blockquotes
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

/**
 * Fetch shared content records from a single account.
 */
async function fetchSharedFromAccount(handleOrDid: string): Promise<RawSharedContent[]> {
  const did = await resolveHandle(handleOrDid);
  const pds = await resolvePds(did);

  const records: RawSharedContent[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      repo: did,
      collection: COLLECTION,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) break;

    const data = await res.json();
    for (const r of data.records as Array<{ uri: string; value: RawSharedContent }>) {
      if (r.value.documentUri) {
        records.push(r.value);
      }
    }
    cursor = data.cursor;
  } while (cursor);

  return records;
}

/**
 * Fetch shared content from multiple accounts, resolve documents and authors.
 * Returns posts sorted by sharedAt descending.
 */
export async function fetchSharedContent(
  accounts: string[]
): Promise<SharedPost[]> {
  // Fetch shared content records from all accounts in parallel
  const results = await Promise.allSettled(
    accounts.map(a => fetchSharedFromAccount(a))
  );

  const allRecords: Array<RawSharedContent & { _community: string }> = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const recs = (results[i] as PromiseFulfilledResult<RawSharedContent[]>).value;
      allRecords.push(...recs.map(r => ({ ...r, _community: accounts[i] })));
    } else {
      console.warn(`Failed to fetch shared content from ${accounts[i]}:`,
        (results[i] as PromiseRejectedResult).reason);
    }
  }

  // Deduplicate by documentUri, filter to documents only
  const seen = new Set<string>();
  const unique = allRecords.filter(r => {
    if (r.type !== 'document') return false;
    if (seen.has(r.documentUri)) return false;
    seen.add(r.documentUri);
    return true;
  });

  // Fetch documents and author profiles in parallel
  const posts: SharedPost[] = [];

  // Batch into chunks to avoid overwhelming PDSes
  const BATCH_SIZE = 10;
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const resolved = await Promise.allSettled(
      batch.map(async (record) => {
        const [doc, authorProfile] = await Promise.all([
          fetchRecord(record.documentUri),
          getProfile(record.sharedBy),
        ]);

        if (!doc || !doc.title) return null;

        // Build the URL for the post
        let href = '';
        if (doc.path && doc.site) {
          if (doc.site.startsWith('https://') || doc.site.startsWith('http://')) {
            // site is already a URL — use it directly as the base
            href = `${doc.site.replace(/\/$/, '')}${doc.path}`;
          } else {
            // site is an AT-URI — try to resolve the publication URL
            const pubDoc = await fetchRecord(doc.site);
            const baseUrl = (pubDoc as unknown as { url?: string })?.url;
            if (baseUrl) {
              href = `${baseUrl.replace(/\/$/, '')}${doc.path}`;
            }
          }
        }
        if (!href && doc.path) {
          href = `https://blog.atmosphere.community${doc.path}`;
        }
        if (!href) {
          // Link to Leaflet as fallback reader
          const match = record.documentUri.match(/^at:\/\/([^/]+)\/[^/]+\/(.+)$/);
          if (match) {
            href = `https://leaflet.pub/profile/${match[1]}/${match[2]}`;
          }
        }

        return {
          title: doc.title,
          excerpt: makeExcerpt(doc.textContent ?? doc.description),
          author: authorProfile,
          date: doc.publishedAt ?? record.sharedAt,
          href,
          sharedBy: record.sharedBy,
          community: record._community,
          tags: doc.tags ?? [],
        } satisfies SharedPost;
      })
    );

    for (const result of resolved) {
      if (result.status === 'fulfilled' && result.value) {
        posts.push(result.value);
      }
    }
  }

  // Sort by date descending (newest first)
  return posts.sort((a, b) => {
    const da = new Date(a.date).getTime() || 0;
    const db = new Date(b.date).getTime() || 0;
    return db - da;
  });
}

/**
 * Fetch shared events from multiple accounts.
 * Resolves the full event record from each documentUri, then parses it
 * into CommunityEvent objects using the same logic as direct event fetching.
 */
export async function fetchSharedEvents(
  accounts: string[]
): Promise<CommunityEvent[]> {
  const results = await Promise.allSettled(
    accounts.map(a => fetchSharedFromAccount(a))
  );

  const allRecords: Array<RawSharedContent & { _community: string }> = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const recs = (results[i] as PromiseFulfilledResult<RawSharedContent[]>).value;
      allRecords.push(...recs.map(r => ({ ...r, _community: accounts[i] })));
    } else {
      console.warn(`Failed to fetch shared events from ${accounts[i]}:`,
        (results[i] as PromiseRejectedResult).reason);
    }
  }

  // Deduplicate by documentUri, filter to events only
  const seen = new Set<string>();
  const unique = allRecords.filter(r => {
    if (r.type !== 'event') return false;
    if (seen.has(r.documentUri)) return false;
    seen.add(r.documentUri);
    return true;
  });

  const events: CommunityEvent[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const resolved = await Promise.allSettled(
      batch.map(async (record) => {
        // Fetch the full event record to get uris, description, etc.
        const fullEvent = await fetchRecord(record.documentUri) as RawEvent | null;

        if (fullEvent) {
          return parseEvent(fullEvent, record._community, record.documentUri);
        }

        // Fallback: build a CommunityEvent from the shared content metadata
        let mode: CommunityEvent['mode'] = 'in_person';
        if (record.mode === 'virtual') mode = 'online';
        else if (record.mode === 'hybrid') mode = 'hybrid';

        // Build a fallback href from the documentUri
        let href = '';
        const match = record.documentUri.match(/at:\/\/([^/]+)\/[^/]+\/(.+)/);
        if (match) {
          href = `https://smokesignal.events/${match[1]}/${match[2]}`;
        }

        return {
          name: record.title,
          date: record.startsAt ?? record.sharedAt,
          endDate: record.endsAt,
          location: record.location,
          mode,
          description: undefined,
          href,
          source: record._community,
        } satisfies CommunityEvent;
      })
    );

    for (const result of resolved) {
      if (result.status === 'fulfilled' && result.value) {
        events.push(result.value);
      }
    }
  }

  return events;
}
