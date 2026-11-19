export type VerificationVerdict =
  | 'Supported'
  | 'Partially Supported'
  | 'Unsupported'
  | 'Contradictory'
  | 'Potentially Outdated'
  | 'Human Review';

export type NLILabel =
  | 'ENTAILMENT'
  | 'CONTRADICTION'
  | 'NEUTRAL'
  | 'NOT_EVALUATED';

export type EvidenceDnaStatus = 'Pass' | 'Caution' | 'Fail' | 'Unavailable';

export interface EvidenceDnaDimension {
  status: EvidenceDnaStatus;
  summary: string;
  detail: string;
}

export interface EvidenceDna {
  sourceAuthenticity: EvidenceDnaDimension;
  semanticAlignment: EvidenceDnaDimension;
  numericalIntegrity: EvidenceDnaDimension;
  contextIntegrity: EvidenceDnaDimension;
  temporalValidity: EvidenceDnaDimension;
}

export type CitationFlag =
  | 'Missing Citation'
  | 'Incorrect DOI'
  | 'Missing Publication'
  | 'Author Mismatch'
  | 'Year Mismatch'
  | 'Unrelated Citation'
  | 'Duplicate Reference';

export interface BibliographyEntry {
  index?: number;
  rawText: string;
  title?: string;
  authors: string[];
  year?: number;
  doi?: string;
  isDuplicate?: boolean;
  duplicateOf?: string;
}

export interface DetectedCitation {
  rawText: string;
  format: 'numbered' | 'author-year' | 'et-al' | 'doi';
  position: number;
  matchedBibEntry?: BibliographyEntry;
}

export interface ResearchSourceRecord {
  verified: boolean;
  openAlexFound: boolean;
  crossrefFound: boolean;
  openAlexId?: string;
  title?: string;
  authors: string[];
  year?: number;
  doi?: string;
  journal?: string;
  sourceUrl?: string;
  abstractText?: string;
  relevantPassage?: string;
  passageSource:
    | 'OpenAlex Abstract'
    | 'Crossref Abstract'
    | 'Europe PMC Abstract'
    | 'Semantic Scholar Abstract'
    | 'Illustrative Demo Corpus'
    | 'Unavailable';
  findings?: string;
  limitations?: string;
  experimentalConditions?: string;
  citedByCount?: number;
  isIllustrativeDemo?: boolean;
  retrievalNote?: string;
}

export interface NLIResult {
  label: NLILabel;
  confidence: number | null;
  premise: string;
  hypothesis: string;
  explanation: string;
  performed: boolean;
  error?: string;
}

export interface NumericalCheckResult {
  hasNumbers: boolean;
  status: 'Match' | 'Mismatch' | 'Unverifiable' | 'Not Applicable';
  claimedValues: string[];
  reportedValues: string[];
  differenceSummary?: string;
  explanation: string;
}

export interface ContextTrapResult {
  detected: boolean;
  status: 'Aligned' | 'Context Mismatch' | 'Unverifiable';
  originalContext?: string;
  submittedContext?: string;
  changedPhrases: string[];
  explanation: string;
}

export type HumanReviewDecision =
  | 'Pending'
  | 'Reviewed'
  | 'Accepted'
  | 'Rejected';

export interface ReviewHistoryItem {
  id: string;
  timestamp: string;
  action: string;
  decision: HumanReviewDecision;
  comment?: string;
  reviewer: string;
}

export interface HumanReviewRecord {
  decision: HumanReviewDecision;
  comments: string;
  lastUpdated?: string;
  history: ReviewHistoryItem[];
}

export interface ClaimAnalysis {
  id: string;
  claimText: string;
  section: string;
  matchedCitation: string;
  citationFormat: 'numbered' | 'author-year' | 'et-al' | 'doi' | 'missing';
  citationFlags: CitationFlag[];
  bibliographyEntry?: BibliographyEntry;
  source: ResearchSourceRecord;
  nli: NLIResult;
  numericalCheck: NumericalCheckResult;
  contextTrap: ContextTrapResult;
  evidenceDna: EvidenceDna;
  verdict: VerificationVerdict;
  confidenceIndicator: 'High' | 'Moderate' | 'Low' | 'Indeterminate';
  confidenceExplanation: string;
  reason: string;
  expectedDemoOutcome?: string;
  humanReview: HumanReviewRecord;
}

export interface CitationAuditItem {
  citationText: string;
  format: string;
  flags: CitationFlag[];
  bibliographyText?: string;
  resolvedTitle?: string;
  doi?: string;
  verified: boolean;
}

export interface DocumentSummaryStats {
  totalClaims: number;
  citationsFound: number;
  verifiedSources: number;
  supportedClaims: number;
  partiallySupportedClaims: number;
  unsupportedClaims: number;
  contradictoryClaims: number;
  potentiallyOutdatedClaims: number;
  claimsNeedingReview: number;
  numericalMismatches: number;
  contextTrapsDetected: number;
  citationIssuesCount: number;
}

export interface TimelineBucket {
  year: string;
  sources: number;
  verified: number;
}

export interface DocumentReport {
  reportId: string;
  filename: string;
  fileSizeBytes: number;
  fileType: 'PDF' | 'TXT' | 'SAMPLE';
  uploadedAt: string;
  isSampleDemo: boolean;
  extractedTextPreview: string;
  totalCharacters: number;
  bibliographyEntries: BibliographyEntry[];
  detectedCitations: DetectedCitation[];
  citationAudit: CitationAuditItem[];
  claims: ClaimAnalysis[];
  summaryStats: DocumentSummaryStats;
  timelineData: TimelineBucket[];
  pipelineWarnings: string[];
}

export interface PipelineProgressEvent {
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  stageName: string;
  detail: string;
  percent: number;
}
