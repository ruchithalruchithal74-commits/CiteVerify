/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { AnalysisDashboardPage } from './components/AnalysisDashboardPage.tsx';
import { ClaimInvestigationPage } from './components/ClaimInvestigationPage.tsx';
import { DocumentUploadPage } from './components/DocumentUploadPage.tsx';
import { EvidenceExplorerPage } from './components/EvidenceExplorerPage.tsx';
import { LandingPage } from './components/LandingPage.tsx';
import { VerificationReportPage } from './components/VerificationReportPage.tsx';
import { WorkspaceShell, type WorkspacePage } from './components/WorkspaceShell.tsx';
import type { DocumentReport, VerificationVerdict } from './types.ts';
import { exportVerificationReportPdf } from './utils/pdfReport.ts';

export default function App() {
  const [view, setView] = useState<'landing' | 'workspace'>('landing');
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage>('upload');
  const [reports, setReports] = useState<DocumentReport[]>([]);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [claimFilter, setClaimFilter] = useState<VerificationVerdict | 'All'>('All');
  const [focusedClaimId, setFocusedClaimId] = useState<string | null>(null);
  const [autoTriggerSample, setAutoTriggerSample] = useState(false);

  useEffect(() => {
    fetch('/api/reports')
      .then((res) => (res.ok ? res.json() : { reports: [] }))
      .then((data) => {
        if (Array.isArray(data.reports) && data.reports.length > 0) {
          setReports(data.reports);
          setActiveReportId(data.reports[0].reportId);
        }
      })
      .catch(() => {
        // Non-blocking initial history fetch
      });
  }, []);

  const activeReport =
    reports.find((r) => r.reportId === activeReportId) || null;

  const handleVerificationComplete = (newReport: DocumentReport) => {
    setReports((prev) => [
      newReport,
      ...prev.filter((r) => r.reportId !== newReport.reportId),
    ]);
    setActiveReportId(newReport.reportId);
    setClaimFilter('All');
    setWorkspacePage('dashboard');
  };

  const handleReviewUpdated = (updated: DocumentReport) => {
    setReports((prev) =>
      prev.map((r) => (r.reportId === updated.reportId ? updated : r))
    );
  };

  const handleLaunchSample = () => {
    setView('workspace');
    setWorkspacePage('upload');
    setAutoTriggerSample(true);
  };

  if (view === 'landing') {
    return (
      <LandingPage
        onNavigateUpload={() => {
          setView('workspace');
          setWorkspacePage('upload');
        }}
        onRunSampleDemo={handleLaunchSample}
        onNavigateDashboard={() => {
          setView('workspace');
          setWorkspacePage(activeReport ? 'dashboard' : 'upload');
        }}
        hasExistingReport={Boolean(activeReport)}
      />
    );
  }

  return (
    <WorkspaceShell
      activePage={workspacePage}
      onSelectPage={(page) => setWorkspacePage(page)}
      onGoHome={() => setView('landing')}
      activeReport={activeReport}
      reports={reports}
      onSelectReport={(id) => {
        setActiveReportId(id);
        setFocusedClaimId(null);
      }}
      onExportPdf={() => {
        if (activeReport) exportVerificationReportPdf(activeReport);
      }}
    >
      {workspacePage === 'upload' && (
        <DocumentUploadPage
          onVerificationComplete={handleVerificationComplete}
          autoTriggerSample={autoTriggerSample}
          onSampleTriggerHandled={() => setAutoTriggerSample(false)}
        />
      )}

      {workspacePage === 'dashboard' && (
        <AnalysisDashboardPage
          report={activeReport}
          reports={reports}
          onGoUpload={() => setWorkspacePage('upload')}
          onRunSample={handleLaunchSample}
          onInspectClaims={(filter = 'All') => {
            setClaimFilter(filter);
            setWorkspacePage('claims');
          }}
          onSelectReport={(id) => setActiveReportId(id)}
        />
      )}

      {workspacePage === 'claims' && (
        <ClaimInvestigationPage
          report={activeReport}
          initialFilter={claimFilter}
          onGoUpload={() => setWorkspacePage('upload')}
          onInspectEvidence={(claimId) => {
            setFocusedClaimId(claimId);
            setWorkspacePage('evidence');
          }}
          onReviewUpdated={handleReviewUpdated}
        />
      )}

      {workspacePage === 'evidence' && (
        <EvidenceExplorerPage
          report={activeReport}
          focusedClaimId={focusedClaimId}
          onGoUpload={() => setWorkspacePage('upload')}
        />
      )}

      {workspacePage === 'report' && (
        <VerificationReportPage
          report={activeReport}
          onExportPdf={() => {
            if (activeReport) exportVerificationReportPdf(activeReport);
          }}
          onGoUpload={() => setWorkspacePage('upload')}
        />
      )}
    </WorkspaceShell>
  );
}
