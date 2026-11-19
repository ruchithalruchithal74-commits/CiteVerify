import type {
  BibliographyEntry,
  CitationFlag,
  ResearchSourceRecord,
} from '../src/types.ts';

const USER_AGENT =
  'CiteVerify/1.0 (Academic Research Integrity Platform; mailto:research@citeverify.org)';

export function reconstructOpenAlexAbstract(
  invertedIndex?: Record<string, number[]> | null
): string | undefined {
  if (!invertedIndex || typeof invertedIndex !== 'object') return undefined;
  const words: Array<{ pos: number; word: string }> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        words.push({ pos, word });
      }
    }
  }
  if (words.length === 0) return undefined;
  words.sort((a, b) => a.pos - b.pos);
  return words.map((w) => w.word).join(' ').trim();
}

function stripJatsXml(xml?: string): string | undefined {
  if (!xml) return undefined;
  const cleaned = xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 20 ? cleaned : undefined;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 9000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { __httpError: res.status, __statusText: res.statusText };
    }
    return await res.json();
  } catch (err: any) {
    return { __fetchError: err?.message || 'Network request failed' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDoi(doi?: string): string | undefined {
  if (!doi) return undefined;
  return doi
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
}

function titleSimilarity(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const tokA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  const tokB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  return overlap / Math.max(tokA.size, tokB.size);
}

export async function lookupOriginalResearch(params: {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  rawReference?: string;
}): Promise<{
  source: ResearchSourceRecord;
  flags: CitationFlag[];
}> {
  const flags: CitationFlag[] = [];
  const cleanDoi = normalizeDoi(params.doi);

  let openAlexWork: any = null;
  let crossrefWork: any = null;
  let doiLookupFailed = false;

  // 1. Prioritize DOI resolution on both OpenAlex & Crossref
  if (cleanDoi) {
    const [oaRes, crRes] = await Promise.all([
      fetchJsonWithTimeout(
        `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(cleanDoi)}`
      ),
      fetchJsonWithTimeout(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`
      ),
    ]);

    if (oaRes && !oaRes.__httpError && !oaRes.__fetchError && oaRes.id) {
      openAlexWork = oaRes;
    }
    if (
      crRes &&
      !crRes.__httpError &&
      !crRes.__fetchError &&
      crRes.message?.DOI
    ) {
      crossrefWork = crRes.message;
    }

    if (!openAlexWork && !crossrefWork) {
      doiLookupFailed = true;
      flags.push('Incorrect DOI');
    }
  }

  // 2. Fallback or cross-check by bibliographic search (title / author / year)
  const searchQuery =
    params.title ||
    params.rawReference?.replace(/^\[\d+\]\s*/, '').slice(0, 140);

  if ((!openAlexWork || !crossrefWork) && searchQuery && searchQuery.length > 8) {
    const queries: Promise<void>[] = [];

    if (!openAlexWork) {
      const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(
        searchQuery
      )}&per-page=3`;
      queries.push(
        fetchJsonWithTimeout(oaUrl).then((data) => {
          const candidates = data?.results;
          if (Array.isArray(candidates) && candidates.length > 0) {
            // Pick best title match if title exists
            const best = params.title
              ? candidates
                  .map((c: any) => ({
                    c,
                    sim: titleSimilarity(params.title, c.title),
                  }))
                  .sort((x: any, y: any) => y.sim - x.sim)[0]
              : { c: candidates[0], sim: 0.4 };
            if (best && best.sim >= 0.35) {
              openAlexWork = best.c;
            }
          }
        })
      );
    }

    if (!crossrefWork) {
      const crUrl = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(
        searchQuery
      )}&rows=3`;
      queries.push(
        fetchJsonWithTimeout(crUrl).then((data) => {
          const candidates = data?.message?.items;
          if (Array.isArray(candidates) && candidates.length > 0) {
            const best = params.title
              ? candidates
                  .map((c: any) => ({
                    c,
                    sim: titleSimilarity(
                      params.title,
                      Array.isArray(c.title) ? c.title[0] : c.title
                    ),
                  }))
                  .sort((x: any, y: any) => y.sim - x.sim)[0]
              : { c: candidates[0], sim: 0.4 };
            if (best && best.sim >= 0.35) {
              crossrefWork = best.c;
            }
          }
        })
      );
    }

    await Promise.all(queries);
  }

  // If DOI was provided, found in Crossref, and OpenAlex not yet found, resolve OpenAlex by Crossref DOI/title
  if (!openAlexWork && crossrefWork?.DOI) {
    const oaByCrDoi = await fetchJsonWithTimeout(
      `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(
        crossrefWork.DOI
      )}`
    );
    if (oaByCrDoi && !oaByCrDoi.__httpError && !oaByCrDoi.__fetchError && oaByCrDoi.id) {
      openAlexWork = oaByCrDoi;
    }
  }

  const openAlexFound = Boolean(openAlexWork);
  const crossrefFound = Boolean(crossrefWork);
  const verified = openAlexFound || crossrefFound;

  if (!verified) {
    if (!flags.includes('Incorrect DOI')) {
      flags.push('Missing Publication');
    }
    return {
      source: {
        verified: false,
        openAlexFound: false,
        crossrefFound: false,
        authors: params.authors || [],
        year: params.year,
        doi: cleanDoi,
        title: params.title,
        passageSource: 'Unavailable',
        retrievalNote: doiLookupFailed
          ? `DOI "${cleanDoi}" did not resolve in OpenAlex or Crossref.`
          : 'No matching publication record found in OpenAlex or Crossref.',
      },
      flags,
    };
  }

  // Extract metadata prioritizing OpenAlex + Crossref cross-check
  const resolvedTitle =
    openAlexWork?.title ||
    (Array.isArray(crossrefWork?.title)
      ? crossrefWork.title[0]
      : crossrefWork?.title) ||
    params.title;

  const oaAuthors: string[] = Array.isArray(openAlexWork?.authorships)
    ? openAlexWork.authorships
        .map((a: any) => a?.author?.display_name)
        .filter(Boolean)
    : [];
  const crAuthors: string[] = Array.isArray(crossrefWork?.author)
    ? crossrefWork.author
        .map((a: any) => [a.given, a.family].filter(Boolean).join(' ').trim())
        .filter(Boolean)
    : [];
  const resolvedAuthors = oaAuthors.length > 0 ? oaAuthors : crAuthors;

  const oaYear = openAlexWork?.publication_year;
  const crYear =
    crossrefWork?.published?.['date-parts']?.[0]?.[0] ||
    crossrefWork?.['published-print']?.['date-parts']?.[0]?.[0] ||
    crossrefWork?.['published-online']?.['date-parts']?.[0]?.[0];
  const resolvedYear: number | undefined = oaYear || crYear;

  const resolvedDoi =
    normalizeDoi(openAlexWork?.doi) ||
    normalizeDoi(crossrefWork?.DOI) ||
    cleanDoi;

  const resolvedJournal =
    openAlexWork?.primary_location?.source?.display_name ||
    (Array.isArray(crossrefWork?.['container-title'])
      ? crossrefWork['container-title'][0]
      : crossrefWork?.['container-title']);

  const sourceUrl =
    openAlexWork?.open_access?.oa_url ||
    openAlexWork?.primary_location?.landing_page_url ||
    (resolvedDoi ? `https://doi.org/${resolvedDoi}` : undefined) ||
    openAlexWork?.id;

  // Cross-check Author & Year against cited reference
  if (params.year && resolvedYear && Math.abs(params.year - resolvedYear) > 1) {
    flags.push('Year Mismatch');
  }

  if (
    params.authors &&
    params.authors.length > 0 &&
    resolvedAuthors.length > 0
  ) {
    const citedSurnames = params.authors
      .map((a) => a.split(/[\s,]+/).pop()?.toLowerCase() || a.toLowerCase())
      .filter((s) => s.length > 2);
    const resolvedJoined = resolvedAuthors.join(' ').toLowerCase();
    const anyAuthorMatches = citedSurnames.some((s) =>
      resolvedJoined.includes(s)
    );
    if (citedSurnames.length > 0 && !anyAuthorMatches) {
      flags.push('Author Mismatch');
    }
  }

  // Genuine Abstract Passage Retrieval (NEVER fabricated)
  const oaAbstract = reconstructOpenAlexAbstract(
    openAlexWork?.abstract_inverted_index
  );
  const crAbstract = stripJatsXml(crossrefWork?.abstract);

  let epmcAbstract: string | undefined;
  let fallbackSourceLabel:
    | 'Europe PMC Abstract'
    | 'Semantic Scholar Abstract'
    | undefined;
  if (!oaAbstract && !crAbstract && resolvedDoi) {
    const [epmcRes, s2Res] = await Promise.all([
      fetchJsonWithTimeout(
        `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(
          resolvedDoi
        )}&resultType=core&format=json`,
        20000
      ),
      fetchJsonWithTimeout(
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(
          resolvedDoi
        )}?fields=title,abstract`,
        6000
      ),
    ]);
    const firstResult = epmcRes?.resultList?.result?.[0];
    if (s2Res?.abstract) {
      epmcAbstract = stripJatsXml(s2Res.abstract);
      fallbackSourceLabel = 'Semantic Scholar Abstract';
    }
    if (firstResult?.abstractText) {
      epmcAbstract = stripJatsXml(firstResult.abstractText);
      fallbackSourceLabel = 'Europe PMC Abstract';
    }
  }

  const abstractText = oaAbstract || crAbstract || epmcAbstract;
  const passageSource = oaAbstract
    ? 'OpenAlex Abstract'
    : crAbstract
    ? 'Crossref Abstract'
    : epmcAbstract && fallbackSourceLabel
    ? fallbackSourceLabel
    : 'Unavailable';

  return {
    source: {
      verified: true,
      openAlexFound,
      crossrefFound,
      openAlexId: openAlexWork?.id,
      title: resolvedTitle,
      authors: resolvedAuthors,
      year: resolvedYear,
      doi: resolvedDoi,
      journal: resolvedJournal,
      sourceUrl,
      abstractText,
      relevantPassage: abstractText,
      passageSource,
      citedByCount: openAlexWork?.cited_by_count,
      retrievalNote: abstractText
        ? `Retrieved genuine abstract text from ${passageSource}.`
        : 'Publication metadata verified, but OpenAlex, Crossref, and Europe PMC do not expose an open abstract for this record.',
    },
    flags,
  };
}

export function extractQueryHintsFromBib(
  bib?: BibliographyEntry,
  rawCitation?: string
): { doi?: string; title?: string; authors?: string[]; year?: number } {
  if (bib) {
    return {
      doi: bib.doi,
      title: bib.title,
      authors: bib.authors,
      year: bib.year,
    };
  }
  const doiMatch = rawCitation?.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
  const yearMatch = rawCitation?.match(/\b((?:19|20)\d{2})\b/);
  const authorMatch = rawCitation?.match(/([A-Z][a-zA-Z'-]+)/);
  return {
    doi: doiMatch ? doiMatch[1] : undefined,
    authors: authorMatch ? [authorMatch[1]] : undefined,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
  };
}
