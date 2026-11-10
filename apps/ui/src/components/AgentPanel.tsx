/**
 * Small panel (bottom-right) shown only when this tab has an agent link. It renders the
 * `project_state` the agent server pushes and carries the user's approval buttons.
 * An approval is only ever sent from a click here; the agent has no way to send one.
 */
import { useState } from 'react';
import {
  sendAgentApproval,
  useAgentBridgeStore,
  type PrintJobInfo,
  type PrintRequestInfo,
  type ProjectState,
} from '../services/agentBridge';
import { Button } from './ui';
import { formatDuration, validPrintRequest } from './agentPanelModel';

const APPROVE_LABEL = {
  brief: 'Confirm brief',
  plan: 'Approve plan',
  design: 'Approve design',
} as const;

const JOB_WORDS: Record<PrintJobInfo['state'], string> = {
  uploading: 'Uploading the file to the printer...',
  starting: 'The printer is starting the job...',
  sent: 'Sent to the printer.',
  failed: 'The print did not start.',
};

const sectionTitle = { color: 'var(--text-secondary)' } as const;

/**
 * The one approval that starts a physical machine: a box must be ticked first and the
 * button locks after one press. Mount it with `key={revisionId@requestedAt}` so a fresh
 * request starts unticked and unlocked.
 */
export function PrintConfirmation({ request }: { request: PrintRequestInfo }) {
  const [ready, setReady] = useState(false);
  const [sent, setSent] = useState(false);
  const { estimate } = request;
  const press = () => {
    if (!ready || sent) return;
    setSent(true);
    sendAgentApproval({ what: 'gcode', revisionId: request.revisionId });
  };
  return (
    <section
      aria-label="Send to printer"
      data-testid="agent-print-confirmation"
      className="rounded-md p-2 text-xs"
      style={{ border: '2px solid var(--accent-primary)', backgroundColor: 'var(--bg-primary)' }}
    >
      <div className="font-semibold">Send to printer</div>
      <div>
        Design revision <strong>{request.revisionNumber}</strong>
      </div>
      <div>File: {request.fileName}</div>
      <div>
        About <strong>{formatDuration(estimate.printTimeMinutes)}</strong>, about{' '}
        {estimate.filamentGrams.toFixed(1)} g of filament, {estimate.layerCount} layers
      </div>
      <p className="my-1">
        <strong>Pressing the button below starts the printer.</strong> It will begin heating and
        printing straight away.
      </p>
      <label className="my-1 flex items-center gap-1">
        <input
          type="checkbox"
          checked={ready}
          disabled={sent}
          onChange={(e) => setReady(e.target.checked)}
        />
        The printer bed is clear and I am ready
      </label>
      <Button variant="primary" size="sm" disabled={!ready || sent} onClick={press}>
        {sent ? 'Sent' : 'Send to printer'}
      </Button>
    </section>
  );
}

function Details({ state }: { state: ProjectState }) {
  const { brief, planSteps, planStepStatuses, principles, estimate } = state;
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="agent-details">
      {brief && (
        <div>
          <div className="font-semibold" style={sectionTitle}>
            Brief
          </div>
          <div>
            <strong>{brief.summary}</strong>
          </div>
          <div>{brief.function}</div>
          {brief.environment && <em>{brief.environment}</em>}
        </div>
      )}
      {planSteps.length > 0 && (
        <div>
          <div className="font-semibold" style={sectionTitle}>
            Plan (
            {
              planStepStatuses.filter(
                (s) => s.state !== 'pending' && planSteps.some((p) => p.id === s.stepId)
              ).length
            }{' '}
            of {planSteps.length} resolved)
          </div>
          <ol className="list-decimal pl-4">
            {planSteps.map((step) => {
              const status = planStepStatuses.find((s) => s.stepId === step.id)?.state;
              return (
                <li key={step.id}>
                  {step.description}
                  {status && status !== 'pending' && <em> ({status})</em>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {principles.length > 0 && (
        <div>
          <div className="font-semibold" style={sectionTitle}>
            Design principles
          </div>
          <ul className="list-disc pl-4">
            {principles.map((p) => (
              <li key={p.id}>
                <strong>{p.kind}:</strong> {p.statement}
              </li>
            ))}
          </ul>
        </div>
      )}
      {estimate && (
        <div>
          <div className="font-semibold" style={sectionTitle}>
            Print estimate
          </div>
          <div>
            About {formatDuration(estimate.printTimeMinutes)}, {estimate.filamentGrams.toFixed(1)} g
            of filament ({estimate.filamentMeters.toFixed(2)} m), {estimate.layerCount} layers at{' '}
            {estimate.layerHeightMm} mm
          </div>
          <div>
            Nozzle {estimate.nozzleTempC}°C, bed {estimate.bedTempC}°C
          </div>
          <em>Estimates; real print time and weight can differ.</em>
        </div>
      )}
    </div>
  );
}

export function AgentPanel() {
  const status = useAgentBridgeStore((s) => s.status);
  const state = useAgentBridgeStore((s) => s.projectState);
  const notice = useAgentBridgeStore((s) => s.notice);
  const [open, setOpen] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  if (status === 'off') return null;

  const pending = state?.status.pendingApproval ?? null;
  const printRequest = validPrintRequest(state?.printRequest);
  const printJob = state?.printJob ?? null;
  const connection =
    status === 'open'
      ? null
      : status === 'replaced'
        ? 'Another Studio tab took over this link.'
        : status === 'connecting'
          ? 'Connecting to the agent...'
          : 'Disconnected. Retrying...';

  return (
    <aside
      data-testid="agent-panel"
      aria-label="Agent"
      className="fixed bottom-3 right-3 z-[70] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-lg text-sm shadow-lg"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <Button
        variant="ghost"
        className="w-full justify-between px-3 py-2 text-left font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Agent · {state?.status.phase ?? (status === 'open' ? 'waiting' : status)}</span>
        <span aria-hidden>{open ? '–' : '+'}</span>
      </Button>
      {open && (
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-3 pb-3">
          {connection && (
            <div role="status" className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {connection}
            </div>
          )}
          {notice && (
            <div role="status" className="text-xs" data-testid="agent-notice">
              {notice}
            </div>
          )}
          {state === null ? (
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Waiting for the agent...
            </div>
          ) : (
            <>
              {state.brief && (
                <div className="text-xs" data-testid="agent-brief-summary">
                  {state.brief.summary}
                </div>
              )}
              {state.status.blockedBecause && (
                <div className="text-xs" data-testid="agent-blocked">
                  <span style={sectionTitle}>Next step blocked:</span> {state.status.blockedBecause}
                </div>
              )}
              {pending && pending !== 'print' && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => sendAgentApproval({ what: pending })}
                >
                  {APPROVE_LABEL[pending]}
                </Button>
              )}
              {pending === 'print' && printRequest && (
                <PrintConfirmation
                  key={`${printRequest.revisionId}@${printRequest.requestedAt}`}
                  request={printRequest}
                />
              )}
              {printJob && (
                <div
                  role={printJob.state === 'failed' ? 'alert' : 'status'}
                  className="text-xs"
                  data-testid="agent-print-job"
                >
                  <strong>{JOB_WORDS[printJob.state] ?? printJob.state}</strong>
                  {printJob.state === 'failed' && printJob.message ? ` ${printJob.message}` : ''}
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="self-start underline"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((v) => !v)}
              >
                Details
              </Button>
              {showDetails && <Details state={state} />}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
