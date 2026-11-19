import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import type { HumanReviewDecision } from './src/types.ts';
import { extractDocumentText } from './server/extractors.ts';
import {
  getAllReports,
  getReportById,
  runVerificationPipeline,
  saveReport,
} from './server/pipeline.ts';
import { lookupOriginalResearch } from './server/researchApi.ts';
import {
  SAMPLE_EXPECTED_MATRIX,
  SAMPLE_PAPER_METADATA,
  SAMPLE_PAPER_TEXT,
} from './server/samplePaper.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '4mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    ),
  });
});

app.get('/api/sample-paper', (_req, res) => {
  res.json({
    ...SAMPLE_PAPER_METADATA,
    fileSizeBytes: Buffer.byteLength(SAMPLE_PAPER_TEXT, 'utf-8'),
    text: SAMPLE_PAPER_TEXT,
    expectedMatrix: SAMPLE_EXPECTED_MATRIX,
  });
});

app.get('/api/reports', (_req, res) => {
  res.json({ reports: getAllReports() });
});

app.get('/api/reports/:id', (req, res) => {
  const report = getReportById(req.params.id);
  if (!report) {
    res.status(404).json({ error: 'Verification report not found.' });
    return;
  }
  res.json({ report });
});

// Preview uploaded PDF or TXT text before starting verification
app.post('/api/extract-preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No document file uploaded.' });
      return;
    }
    const { text, fileType } = await extractDocumentText(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    res.json({
      filename: req.file.originalname,
      fileSizeBytes: req.file.size,
      fileType,
      totalCharacters: text.length,
      previewText: text.slice(0, 8000),
    });
  } catch (err: any) {
    res.status(400).json({
      error: err?.message || 'Failed to extract document text.',
    });
  }
});

// Streaming SSE verification endpoint (supports both uploaded file and sample paper)
app.post('/api/verify-stream', upload.single('file'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const useSample = req.body?.mode === 'sample';
    let text = '';
    let filename = '';
    let fileSizeBytes = 0;
    let fileType: 'PDF' | 'TXT' | 'SAMPLE' = 'TXT';

    if (useSample) {
      text = SAMPLE_PAPER_TEXT;
      filename = SAMPLE_PAPER_METADATA.filename;
      fileSizeBytes = Buffer.byteLength(SAMPLE_PAPER_TEXT, 'utf-8');
      fileType = 'SAMPLE';
    } else if (req.file) {
      const extracted = await extractDocumentText(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      text = extracted.text;
      filename = req.file.originalname;
      fileSizeBytes = req.file.size;
      fileType = extracted.fileType;
    } else if (typeof req.body?.rawText === 'string' && req.body.rawText.trim()) {
      text = req.body.rawText.trim();
      filename = req.body.filename || 'Pasted_Manuscript.txt';
      fileSizeBytes = Buffer.byteLength(text, 'utf-8');
      fileType = 'TXT';
    } else {
      sendEvent('error', {
        error: 'Please upload a PDF/TXT file or launch Sample Demonstration Mode.',
      });
      res.end();
      return;
    }

    const report = await runVerificationPipeline({
      text,
      filename,
      fileSizeBytes,
      fileType,
      isSampleDemo: useSample,
      onProgress: (ev) => sendEvent('progress', ev),
    });

    sendEvent('complete', { report });
    res.end();
  } catch (err: any) {
    sendEvent('error', {
      error: err?.message || 'Verification pipeline encountered an unexpected error.',
    });
    res.end();
  }
});

// Human Review endpoint: Mark as reviewed, Accept finding, Reject finding, Add comments
app.patch('/api/reports/:reportId/claims/:claimId/review', (req, res) => {
  const report = getReportById(req.params.reportId);
  if (!report) {
    res.status(404).json({ error: 'Report not found.' });
    return;
  }

  const claim = report.claims.find((c) => c.id === req.params.claimId);
  if (!claim) {
    res.status(404).json({ error: 'Claim not found in report.' });
    return;
  }

  const { decision, comments, reviewer } = req.body as {
    decision?: HumanReviewDecision;
    comments?: string;
    reviewer?: string;
  };

  const validDecisions: HumanReviewDecision[] = [
    'Pending',
    'Reviewed',
    'Accepted',
    'Rejected',
  ];
  const nextDecision: HumanReviewDecision =
    decision && validDecisions.includes(decision)
      ? decision
      : claim.humanReview.decision;

  const timestamp = new Date().toISOString();
  const reviewerName = (reviewer || 'Academic Reviewer').trim();
  const nextComments =
    typeof comments === 'string' ? comments.trim() : claim.humanReview.comments;

  claim.humanReview = {
    decision: nextDecision,
    comments: nextComments,
    lastUpdated: timestamp,
    history: [
      {
        id: `REV-${Date.now()}`,
        timestamp,
        action:
          decision && decision !== claim.humanReview.decision
            ? `Status set to ${nextDecision}`
            : 'Reviewer comment updated',
        decision: nextDecision,
        comment: nextComments || undefined,
        reviewer: reviewerName,
      },
      ...claim.humanReview.history,
    ],
  };

  saveReport(report);
  res.json({ claim, report });
});

// Live Evidence Explorer lookup endpoint (queries OpenAlex + Crossref directly)
app.post('/api/sources/lookup', async (req, res) => {
  try {
    const { doi, title, author, year } = req.body as {
      doi?: string;
      title?: string;
      author?: string;
      year?: number;
    };
    if (!doi && !title) {
      res.status(400).json({ error: 'Provide a DOI or publication title to look up.' });
      return;
    }
    const result = await lookupOriginalResearch({
      doi,
      title,
      authors: author ? [author] : undefined,
      year: year ? Number(year) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      error: err?.message || 'Live OpenAlex/Crossref lookup failed.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CiteVerify server listening on http://localhost:${PORT}`);
  });
}

startServer();
