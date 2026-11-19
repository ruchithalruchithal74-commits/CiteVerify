import { extractText } from 'unpdf';
import type { BibliographyEntry, DetectedCitation } from '../src/types.ts';

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ text: string; fileType: 'PDF' | 'TXT' }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    const uint8 = new Uint8Array(buffer);
    const result = await extractText(uint8, { mergePages: true });
    const rawText = Array.isArray(result.text)
      ? result.text.join('\n')
      : String(result.text || '');
    const cleaned = normalizeWhitespace(rawText);
    if (!cleaned || cleaned.length < 30) {
      throw new Error(
        'The uploaded PDF did not yield extractable text. Scanned image-only PDFs without embedded text layers cannot be parsed.'
      );
    }
    return { text: cleaned, fileType: 'PDF' };
  }

  if (lower.endsWith('.txt') || mimeType.startsWith('text/')) {
    const rawText = buffer.toString('utf-8');
    const cleaned = normalizeWhitespace(rawText);
    if (!cleaned || cleaned.length < 20) {
      throw new Error('The uploaded TXT file is empty or too short for analysis.');
    }
    return { text: cleaned, fileType: 'TXT' };
  }

  throw new Error('Unsupported file format. Please upload a PDF or TXT document.');
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitBodyAndBibliography(fullText: string): {
  bodyText: string;
  bibliographySection: string;
} {
  const headingRegex =
    /(?:^|\n)\s*(?:references|bibliography|works cited|literature cited)\s*(?:\n|:)/i;
  const match = headingRegex.exec(fullText);
  if (!match || match.index === undefined) {
    return { bodyText: fullText, bibliographySection: '' };
  }
  return {
    bodyText: fullText.slice(0, match.index).trim(),
    bibliographySection: fullText.slice(match.index).trim(),
  };
}

export function parseBibliographyEntries(bibText: string): BibliographyEntry[] {
  if (!bibText) return [];

  const lines = bibText
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 10 &&
        !/^(references|bibliography|works cited|literature cited):?$/i.test(l)
    );

  // Merge wrapped lines belonging to the same reference entry
  const entriesRaw: string[] = [];
  for (const line of lines) {
    const startsNew =
      /^\[\d+\]/.test(line) ||
      /^\d+\.\s+[A-Z]/.test(line) ||
      /^[A-Z][a-zA-Z'-]+,\s*[A-Z]/.test(line);
    if (startsNew || entriesRaw.length === 0) {
      entriesRaw.push(line);
    } else {
      entriesRaw[entriesRaw.length - 1] += ' ' + line;
    }
  }

  const seenDois = new Map<string, string>();
  const seenTitles = new Map<string, string>();

  return entriesRaw.map((raw) => {
    const indexMatch = raw.match(/^\[(\d+)\]|^(\d+)\./);
    const index = indexMatch
      ? Number(indexMatch[1] || indexMatch[2])
      : undefined;

    const doiMatch = raw.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
    const doi = doiMatch
      ? doiMatch[1].replace(/[.,;)]+$/, '')
      : undefined;

    const yearMatch = raw.match(/\b(19\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? Number(yearMatch[1]) : undefined;

    // Attempt to extract title (often quoted or between year and journal/DOI)
    let title: string | undefined;
    const quotedTitle = raw.match(/[“"]([^”"]{12,220})[”"]/);
    if (quotedTitle) {
      title = quotedTitle[1].trim();
    } else {
      // Heuristic: after (YYYY). or YYYY. take sentence before next period
      const afterYear = raw.replace(/^.*?(\(?(?:19|20)\d{2}\)?[.,;:\s]+)/, '');
      const segments = afterYear.split(/\.\s+/);
      if (segments[0] && segments[0].length > 15 && segments[0].length < 240) {
        title = segments[0].replace(/^\[?\d+\]?\s*/, '').trim();
      }
    }

    // Heuristic author surname extraction from start of entry
    const cleanedStart = raw.replace(/^\[\d+\]\s*|^\d+\.\s*/, '');
    const beforeYearOrTitle = cleanedStart
      .split(/\(\d{4}\)|\b(?:19|20)\d{2}\b|[“"]/)[0]
      .trim();
    const authorCandidates = beforeYearOrTitle
      .split(/,|&|\band\b/i)
      .map((s) => s.trim())
      .filter((s) => /^[A-Z][a-zA-Z'-]{1,30}/.test(s) && s.length < 35)
      .slice(0, 5);

    let isDuplicate = false;
    let duplicateOf: string | undefined;

    if (doi) {
      const normDoi = doi.toLowerCase();
      if (seenDois.has(normDoi)) {
        isDuplicate = true;
        duplicateOf = seenDois.get(normDoi);
      } else {
        seenDois.set(normDoi, index ? `[${index}]` : doi);
      }
    }

    if (!isDuplicate && title) {
      const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normTitle.length > 20 && seenTitles.has(normTitle)) {
        isDuplicate = true;
        duplicateOf = seenTitles.get(normTitle);
      } else if (normTitle.length > 20) {
        seenTitles.set(normTitle, index ? `[${index}]` : title.slice(0, 40));
      }
    }

    return {
      index,
      rawText: raw,
      title,
      authors: authorCandidates,
      year,
      doi,
      isDuplicate,
      duplicateOf,
    };
  });
}

export function detectInlineCitations(
  bodyText: string,
  bibEntries: BibliographyEntry[]
): DetectedCitation[] {
  const results: DetectedCitation[] = [];
  const seenKeys = new Set<string>();

  // 1. Numbered citations: [1], [1, 2], [1-3]
  const numberedRegex = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = numberedRegex.exec(bodyText)) !== null) {
    const raw = m[0];
    const firstNum = Number(m[1].match(/\d+/)?.[0]);
    const matchedBibEntry = bibEntries.find((b) => b.index === firstNum);
    const key = `num:${raw}:${m.index}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      results.push({
        rawText: raw,
        format: 'numbered',
        position: m.index,
        matchedBibEntry,
      });
    }
  }

  // 2. Author-Year parenthetical: (Smith, 2020), (Vaswani et al., 2017)
  const authorYearRegex =
    /\(([A-Z][a-zA-Z'-]+(?:\s+(?:et al\.|and\s+[A-Z][a-zA-Z'-]+|&\s+[A-Z][a-zA-Z'-]+))?,\s*(?:19|20)\d{2}[a-z]?(?:\s*;\s*[A-Z][^)]+)*)\)/g;
  while ((m = authorYearRegex.exec(bodyText)) !== null) {
    const raw = m[0];
    const surname = m[1].match(/^([A-Z][a-zA-Z'-]+)/)?.[1]?.toLowerCase();
    const yearMatch = m[1].match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : undefined;
    const matchedBibEntry = bibEntries.find(
      (b) =>
        surname &&
        b.rawText.toLowerCase().includes(surname) &&
        (!year || b.year === year)
    );
    results.push({
      rawText: raw,
      format: raw.includes('et al.') ? 'et-al' : 'author-year',
      position: m.index,
      matchedBibEntry,
    });
  }

  // 3. Inline "Author et al. (2021)" or "Author et al."
  const etAlRegex = /\b([A-Z][a-zA-Z'-]+\s+et\s+al\.(?:\s*\((?:19|20)\d{2}\))?)/g;
  while ((m = etAlRegex.exec(bodyText)) !== null) {
    const raw = m[0];
    // Skip if already captured inside parentheses
    const prevChar = bodyText[m.index - 1];
    if (prevChar === '(') continue;
    const surname = m[1].split(/\s+/)[0].toLowerCase();
    const yearMatch = raw.match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : undefined;
    const matchedBibEntry = bibEntries.find(
      (b) =>
        b.rawText.toLowerCase().includes(surname) &&
        (!year || b.year === year)
    );
    results.push({
      rawText: raw,
      format: 'et-al',
      position: m.index,
      matchedBibEntry,
    });
  }

  // 4. Inline DOIs
  const doiRegex = /\b(?:https?:\/\/doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/gi;
  while ((m = doiRegex.exec(bodyText)) !== null) {
    const doiClean = m[1].replace(/[.,;)]+$/, '');
    const matchedBibEntry = bibEntries.find(
      (b) => b.doi?.toLowerCase() === doiClean.toLowerCase()
    );
    results.push({
      rawText: m[0],
      format: 'doi',
      position: m.index,
      matchedBibEntry,
    });
  }

  return results.sort((a, b) => a.position - b.position);
}
