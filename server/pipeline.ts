import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  BibliographyEntry,
  CitationAuditItem,
  CitationFlag,
  ClaimAnalysis,
  DocumentReport,
  DocumentSummaryStats,
  PipelineProgressEvent,
  ResearchSourceRecord,
  TimelineBucket,
} from '../src/types.ts';
import {
  evaluateClaimsBatchWithEvidence,
  extractClaimsWithLLM,
  type BatchEvaluationInput,
} from './aiEngine.ts';
import {
  detectInlineCitations,
  parseBibliographyEntries,
  splitBodyAndBibliography,
} from './extractors.ts';
import { runRuleBasedNumericalCheck } from './numberChecker.ts';
import { extractQueryHintsFromBib, lookupOriginalResearch } from './researchApi.ts';
import {
  ILLUSTRATIVE_DEMO_CORPUS,
  SAMPLE_EXPECTED_MATRIX,
} from './samplePaper.ts';

const REPORTS_FILE = path.resolve(process.cwd(), '.citeverify-reports.json');

const reportStore = new Map<string, DocumentReport>();

function loadPersistedReports() {
  try {
    if (fs.existsSync(REPORTS_FILE)) {
      const raw = fs.readFileSync(REPORTS_FILE, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (r?.reportId) reportStore.set(r.reportId, r);
        }
      }
    }
  } catch {
    // Ignore corrupt cache file on boot
  }
}

function savePersistedReports() {
  try {
    const arr = Array.from(reportStore.values()).slice(0, 25);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch {
    // Non-fatal persistence warning
  }
}

loadPersistedReports();

export function getAllReports(): DocumentReport[] {
  return Array.from(reportStore.values()).sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

export function getReportById(id: string): DocumentReport | undefined {
  return reportStore.get(id);
}

export function saveReport(report: DocumentReport): void {
  reportStore.set(report.reportId, report);
  savePersistedReports();
}

function matchCitationToBib(
  matchedCitation: string,
  bibEntries: BibliographyEntry[]
): BibliographyEntry | undefined {
  if (!matchedCitation || matchedCitation === 'None') return undefined;

  // Numbered: [1], [1, 2]
  const numMatch = matchedCitation.match(/\[(\d+)/);
  if (numMatch) {
    const idx = Number(numMatch[1]);
    const found = bibEntries.find((b) => b.index === idx);
    if (found) return found;
  }

  // DOI
  const doiMatch = matchedCitation.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
  if (doiMatch) {
    const doiLower = doiMatch[1].toLowerCase();
    const found = bibEntries.find((b) => b.doi?.toLowerCase() === doiLower);
    if (found) return found;
  }

  // Author / Year
  const surname = matchedCitation.match(/([A-Z][a-zA-Z'-]+)/)?.[1]?.toLowerCase();
  const yearMatch = matchedCitation.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  if (surname) {
    const found = bibEntries.find(
      (b) =>
        b.rawText.toLowerCase().includes(surname) &&
        (!year || b.year === year)
    );
    if (found) return found;
  }

  return undefined;
}

function fallbackSentenceClaimExtraction(bodyText: string) {
  const sentences = bodyText
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 35 && s.length < 450);

  return sentences
    .filter(
      (s) =>
        /\[\d+\]|\([A-Z][a-zA-Z'-]+.*?\d{4}\)|\d+%|\bp\s*[<>=]|\bdemonstrated\b|\bshowed\b|\bestablished\b|\bachieve[ds]?\b|\breduce[ds]?\b/i.test(
          s
        )
    )
    .slice(0, 10)
    .map((s) => {
      const num = s.match(/\[(\d+(?:\s*[-–,]\s*\d+)*)\]/);
      const ay = s.match(/\(([A-Z][a-zA-Z'-]+.*?,\s*\d{4})\)/);
      const citation = num?.[0] || ay?.[0] || 'None';
      const fmt: 'numbered' | 'author-year' | 'missing' = num
        ? 'numbered'
        : ay
        ? 'author-year'
        : 'missing';
      return {
        claimText: s,
        section: 'Manuscript Body',
        matchedCitation: citation,
        citationFormat: fmt,
      };
    });
}

export async function runVerificationPipeline(params: {
  text: string;
  filename: string;
  fileSizeBytes: number;
  fileType: 'PDF' | 'TXT' | 'SAMPLE';
  isSampleDemo: boolean;
  onProgress?: (ev: PipelineProgressEvent) => void;
}): Promise<DocumentReport> {
  const { text, filename, fileSizeBytes, fileType, isSampleDemo, onProgress } =
    params;
  const pipelineWarnings: string[] = [];

  const emit = (
    stage: 1 | 2 | 3 | 4 | 5 | 6,
    stageName: string,
    detail: string,
    percent: number
  ) => {
    onProgress?.({ stage, stageName, detail, percent });
  };

  // Stage 1: Reading document
  emit(
    1,
    'Reading document',
    `Parsed ${text.length.toLocaleString()} characters from ${filename}`,
    12
  );

  const { bodyText, bibliographySection } = splitBodyAndBibliography(text);
  const bibliographyEntries = parseBibliographyEntries(bibliographySection);

  // Stage 2: Extracting scientific claims
  emit(
    2,
    'Extracting scientific claims',
    'Identifying atomic empirical statements and statistical assertions...',
    28
  );

  const llmClaimResult = await extractClaimsWithLLM(bodyText);
  let draftClaims = llmClaimResult.claims;

  if (llmClaimResult.error || draftClaims.length === 0) {
    if (llmClaimResult.error) {
      pipelineWarnings.push(
        `LLM Claim Extraction unavailable (${llmClaimResult.error}); used deterministic syntactic claim extraction.`
      );
    }
    draftClaims = fallbackSentenceClaimExtraction(bodyText);
  }

  // Stage 3: Detecting citations
  emit(
    3,
    'Detecting citations',
    `Scanning inline [n], (Author, Year), et al., and DOI patterns across ${bibliographyEntries.length} bibliography entries...`,
    44
  );

  const detectedCitations = detectInlineCitations(bodyText, bibliographyEntries);

  // Stage 4: Finding original research (OpenAlex + Crossref + Illustrative Demo Corpus)
  emit(
    4,
    'Finding original research',
    'Querying OpenAlex and Crossref APIs for source metadata and genuine abstracts...',
    62
  );

  const sourceCache = new Map<
    string,
    Promise<{ source: ResearchSourceRecord; flags: CitationFlag[] }>
  >();

  function resolveCitationSource(
    matchedCitation: string,
    bibEntry?: BibliographyEntry
  ): Promise<{ source: ResearchSourceRecord; flags: CitationFlag[] }> {
    const cacheKey = bibEntry?.rawText || matchedCitation;
    if (sourceCache.has(cacheKey)) {
      return sourceCache.get(cacheKey)!;
    }

    const promise = (async () => {
      // Check if this is an explicitly tagged Illustrative Demo reference (Sample Mode only)
      const demoIdMatch = bibEntry?.rawText.match(
        /\[Illustrative Demo Reference ID:\s*(CV-DEMO-\d+)\]/i
      );
      if (isSampleDemo && demoIdMatch && ILLUSTRATIVE_DEMO_CORPUS[demoIdMatch[1]]) {
        const demoSource = { ...ILLUSTRATIVE_DEMO_CORPUS[demoIdMatch[1]] };
        return { source: demoSource, flags: [] as CitationFlag[] };
      }

      const hints = extractQueryHintsFromBib(bibEntry, matchedCitation);
      const result = await lookupOriginalResearch({
        ...hints,
        rawReference: bibEntry?.rawText,
      });

      if (bibEntry?.isDuplicate && !result.flags.includes('Duplicate Reference')) {
        result.flags.push('Duplicate Reference');
      }

      return result;
    })();

    sourceCache.set(cacheKey, promise);
    return promise;
  }

  // Resolve all cited sources concurrently first
  const preparedClaims = await Promise.all(
    draftClaims.map(async (draft, i) => {
      const claimId = `CLM-${String(i + 1).padStart(3, '0')}`;
      const isMissingCitation =
        draft.citationFormat === 'missing' ||
        !draft.matchedCitation ||
        draft.matchedCitation === 'None';

      const bibEntry = isMissingCitation
        ? undefined
        : matchCitationToBib(draft.matchedCitation, bibliographyEntries);

      let source: ResearchSourceRecord;
      let citationFlags: CitationFlag[] = [];

      if (isMissingCitation) {
        citationFlags = ['Missing Citation'];
        source = {
          verified: false,
          openAlexFound: false,
          crossrefFound: false,
          authors: [],
          passageSource: 'Unavailable',
          retrievalNote: 'No citation attached to this claim.',
        };
      } else {
        const resolved = await resolveCitationSource(
          draft.matchedCitation,
          bibEntry
        );
        source = resolved.source;
        citationFlags = [...resolved.flags];
      }

      const numericalCheck = runRuleBasedNumericalCheck(
        draft.claimText,
        source.abstractText
      );

      return {
        claimId,
        draft,
        bibEntry,
        source,
        citationFlags,
        numericalCheck,
      };
    })
  );

  // Stage 5: Comparing evidence (Rule-based Numerical Check + Batched NLI + Context Trap + Evidence DNA)
  emit(
    5,
    'Comparing evidence',
    `Running NLI inference, numerical integrity, and Context Trap checks across ${preparedClaims.length} claims...`,
    80
  );

  const batchInputs: BatchEvaluationInput[] = preparedClaims.map((p) => ({
    claimId: p.claimId,
    claimText: p.draft.claimText,
    matchedCitation: p.draft.matchedCitation,
    citationFlags: p.citationFlags,
    source: p.source,
    numericalCheck: p.numericalCheck,
  }));

  const evaluationMap = await evaluateClaimsBatchWithEvidence(batchInputs);

  const claims: ClaimAnalysis[] = preparedClaims.map((p) => {
    const evaluation = evaluationMap.get(p.claimId)!;
    if (evaluation.nli.error) {
      pipelineWarnings.push(`Claim ${p.claimId} NLI error: ${evaluation.nli.error}`);
    }

    const expectedMatch = isSampleDemo
      ? SAMPLE_EXPECTED_MATRIX.find((e) =>
          p.draft.claimText.toLowerCase().includes(e.claimSubstring.toLowerCase())
        )
      : undefined;

    const finalSource: ResearchSourceRecord = {
      ...p.source,
      relevantPassage: evaluation.relevantPassage || p.source.relevantPassage,
      findings: evaluation.findings,
      limitations: evaluation.limitations,
      experimentalConditions: evaluation.experimentalConditions,
    };

    return {
      id: p.claimId,
      claimText: p.draft.claimText,
      section: p.draft.section,
      matchedCitation: p.draft.matchedCitation,
      citationFormat: p.draft.citationFormat,
      citationFlags: p.citationFlags,
      bibliographyEntry: p.bibEntry,
      source: finalSource,
      nli: evaluation.nli,
      numericalCheck: p.numericalCheck,
      contextTrap: evaluation.contextTrap,
      evidenceDna: evaluation.evidenceDna,
      verdict: evaluation.verdict,
      confidenceIndicator: evaluation.confidenceIndicator,
      confidenceExplanation: evaluation.confidenceExplanation,
      reason: evaluation.reason,
      expectedDemoOutcome: expectedMatch
        ? `${expectedMatch.caseLabel} -> Expected: ${expectedMatch.expectedVerdict} (${expectedMatch.expectedNli})`
        : undefined,
      humanReview: {
        decision: 'Pending',
        comments: '',
        history: [],
      },
    };
  });

  // Build Citation Audit summary (deduplicated)
  const uniqueDetected: typeof detectedCitations = [];
  const seenCitText = new Set<string>();
  for (const det of detectedCitations) {
    if (!seenCitText.has(det.rawText)) {
      seenCitText.add(det.rawText);
      uniqueDetected.push(det);
    }
  }
  const citationAudit: CitationAuditItem[] = await Promise.all(
    uniqueDetected.map(async (det) => {
      const resolved = await resolveCitationSource(det.rawText, det.matchedBibEntry);
      return {
        citationText: det.rawText,
        format: det.format,
        flags: resolved.flags,
        bibliographyText: det.matchedBibEntry?.rawText,
        resolvedTitle: resolved.source.title,
        doi: resolved.source.doi,
        verified: resolved.source.verified,
      };
    })
  );

  // Stage 6: Generating verification report
  emit(
    6,
    'Generating verification report',
    'Compiling Evidence DNA™ scorecards, source timeline, and audit metrics...',
    96
  );

  const uniqueVerifiedSources = new Set(
    claims
      .filter((c) => c.source.verified)
      .map((c) => c.source.doi || c.source.openAlexId || c.source.title)
  );

  const summaryStats: DocumentSummaryStats = {
    totalClaims: claims.length,
    citationsFound: detectedCitations.length,
    verifiedSources: uniqueVerifiedSources.size,
    supportedClaims: claims.filter((c) => c.verdict === 'Supported').length,
    partiallySupportedClaims: claims.filter(
      (c) => c.verdict === 'Partially Supported'
    ).length,
    unsupportedClaims: claims.filter((c) => c.verdict === 'Unsupported').length,
    contradictoryClaims: claims.filter((c) => c.verdict === 'Contradictory')
      .length,
    potentiallyOutdatedClaims: claims.filter(
      (c) => c.verdict === 'Potentially Outdated'
    ).length,
    claimsNeedingReview: claims.filter(
      (c) =>
        c.verdict === 'Human Review' ||
        c.verdict === 'Contradictory' ||
        c.verdict === 'Unsupported' ||
        c.contextTrap.detected ||
        c.numericalCheck.status === 'Mismatch'
    ).length,
    numericalMismatches: claims.filter(
      (c) => c.numericalCheck.status === 'Mismatch'
    ).length,
    contextTrapsDetected: claims.filter((c) => c.contextTrap.detected).length,
    citationIssuesCount:
      claims.filter((c) => c.citationFlags.length > 0).length +
      bibliographyEntries.filter((b) => b.isDuplicate).length,
  };

  // Build research source timeline from actual cited publication years
  const yearMap = new Map<number, { sources: Set<string>; verified: Set<string> }>();
  for (const c of claims) {
    const yr = c.source.year || c.bibliographyEntry?.year;
    if (!yr) continue;
    if (!yearMap.has(yr)) {
      yearMap.set(yr, { sources: new Set(), verified: new Set() });
    }
    const bucket = yearMap.get(yr)!;
    const srcKey = c.source.title || c.matchedCitation;
    bucket.sources.add(srcKey);
    if (c.source.verified) bucket.verified.add(srcKey);
  }
  const timelineData: TimelineBucket[] = Array.from(yearMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([yr, b]) => ({
      year: String(yr),
      sources: b.sources.size,
      verified: b.verified.size,
    }));

  const report: DocumentReport = {
    reportId: `REP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    filename,
    fileSizeBytes,
    fileType,
    uploadedAt: new Date().toISOString(),
    isSampleDemo,
    extractedTextPreview: text.slice(0, 6000),
    totalCharacters: text.length,
    bibliographyEntries,
    detectedCitations,
    citationAudit,
    claims,
    summaryStats,
    timelineData,
    pipelineWarnings: Array.from(new Set(pipelineWarnings)),
  };

  saveReport(report);
  emit(6, 'Generating verification report', 'Verification complete.', 100);
  return report;
}
