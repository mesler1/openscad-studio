/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentPanel } from '../AgentPanel';
import {
  __resetAgentBridgeForTests,
  getAgentBridgeStore,
  startAgentBridgeFromUrl,
  type BridgeHost,
  type ProjectState,
} from '../../services/agentBridge';

/** A socket that records frames, so the panel is tested through the real bridge. */
class FakeSocket {
  static current: FakeSocket;
  readyState = 1;
  sent: { t: string; name?: string; data?: unknown }[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.current = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

const host = {
  getState: () => ({
    path: null,
    source: null,
    dirty: false,
    files: [],
    contentVersion: 0,
    render: null,
  }),
  onContentChanged: () => () => {},
  onRenderSettled: () => () => {},
} as unknown as BridgeHost;

/** What the server would see as approvals. */
const approvals = () =>
  FakeSocket.current.sent.filter((f) => f.t === 'event' && f.name === 'approve').map((f) => f.data);

const ESTIMATE = {
  printTimeMinutes: 70,
  filamentGrams: 4.5,
  filamentMeters: 1.5,
  layerCount: 50,
  layerHeightMm: 0.2,
  nozzleTempC: 220,
  bedTempC: 35,
};

function state(over: Partial<ProjectState> = {}): ProjectState {
  return {
    status: {
      phase: 'intake',
      next: 'plan',
      blockedBecause: 'The brief has not been confirmed.',
      pendingApproval: 'brief',
    },
    brief: { summary: 'A phone stand', function: 'Holds a phone', environment: 'Desk' },
    planSteps: [
      { id: 's1', description: 'Make the base', acceptance: 'Flat' },
      { id: 's2', description: 'Add the lip', acceptance: 'Holds' },
    ],
    planStepStatuses: [{ stepId: 's1', state: 'done' }],
    principles: [{ id: 'p1', kind: 'fit', statement: 'Fits a 9 mm phone' }],
    estimate: ESTIMATE,
    printRequest: null,
    printJob: null,
    ...over,
  };
}

const REQUEST = {
  revisionId: 'rev-1',
  revisionNumber: 3,
  fileName: 'stand-r3.gcode.3mf',
  estimate: ESTIMATE,
  requestedAt: '2026-11-10T10:00:00.000Z',
};

function show(
  projectState: ProjectState | null,
  status: 'open' | 'connecting' | 'refused' = 'open'
) {
  act(() => getAgentBridgeStore().setState({ status, projectState, notice: null }));
}

describe('AgentPanel', () => {
  it('says plainly when another Studio tab is already connected', () => {
    render(<AgentPanel />);
    show(null, 'refused');
    expect(screen.getByText(/Another Studio tab is already connected/)).toBeInTheDocument();
  });

  beforeEach(() => {
    act(() => __resetAgentBridgeForTests());
  });
  afterEach(() => {
    act(() => __resetAgentBridgeForTests());
  });

  /** Open the page the way the server's studio URL does, so a real link exists. */
  const connect = () => {
    window.history.replaceState(
      null,
      '',
      '/?agentBridge=ws%3A%2F%2F127.0.0.1%3A4321%2Fagent%3Fproject%3Dp1'
    );
    startAgentBridgeFromUrl(host, window, { WebSocketImpl: FakeSocket });
    FakeSocket.current.onopen?.({});
  };

  it('is not rendered when the tab has no agent link', () => {
    const { container } = render(<AgentPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is titled with the phase and shows the blocker and the brief summary', () => {
    connect();
    render(<AgentPanel />);
    show(state());
    expect(screen.getByText('Agent · intake')).toBeInTheDocument();
    expect(screen.getByTestId('agent-blocked')).toHaveTextContent(
      'The brief has not been confirmed.'
    );
    expect(screen.getByTestId('agent-brief-summary')).toHaveTextContent('A phone stand');
  });

  it('keeps the long content in a collapsible Details section', () => {
    connect();
    render(<AgentPanel />);
    show(state());
    expect(screen.queryByTestId('agent-details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByTestId('agent-details');
    expect(details).toHaveTextContent('Plan (1 of 2 resolved)');
    expect(details).toHaveTextContent('Make the base');
    expect(details).toHaveTextContent('(done)');
    expect(details).toHaveTextContent('Fits a 9 mm phone');
    expect(details).toHaveTextContent('About 1h 10m, 4.5 g');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.queryByTestId('agent-details')).toBeNull();
  });

  it.each([
    ['brief', 'Confirm brief'],
    ['plan', 'Approve plan'],
    ['design', 'Approve design'],
  ] as const)('the %s approval button sends exactly that approval', (what, label) => {
    connect();
    render(<AgentPanel />);
    show(state({ status: { ...state().status, pendingApproval: what } }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(approvals()).toEqual([{ what }]);
  });

  it('shows no approval button when nothing is pending', () => {
    connect();
    render(<AgentPanel />);
    show(state({ status: { ...state().status, pendingApproval: null } }));
    expect(screen.queryByRole('button', { name: /Confirm|Approve|Send to printer/ })).toBeNull();
  });

  describe('Send to printer', () => {
    const printing = (...given: [unknown?]) =>
      state({
        status: {
          phase: 'review',
          next: 'print',
          blockedBecause: null,
          pendingApproval: 'print',
        },
        printRequest: (given.length > 0 ? given[0] : REQUEST) as ProjectState['printRequest'],
      });

    it('shows revision, file and estimate, and warns that pressing starts the printer', () => {
      connect();
      render(<AgentPanel />);
      show(printing());
      const box = screen.getByTestId('agent-print-confirmation');
      expect(box).toHaveTextContent('Design revision 3');
      expect(box).toHaveTextContent('stand-r3.gcode.3mf');
      expect(box).toHaveTextContent('About 1h 10m');
      expect(box).toHaveTextContent('Pressing the button below starts the printer.');
    });

    it('stays disabled until the bed-clear box is ticked, then sends once with the revision id', () => {
      connect();
      render(<AgentPanel />);
      show(printing());
      const button = screen.getByRole('button', { name: 'Send to printer' });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(approvals()).toEqual([]);

      fireEvent.click(screen.getByLabelText('The printer bed is clear and I am ready'));
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(approvals()).toEqual([
        { what: 'gcode', revisionId: 'rev-1', requestedAt: REQUEST.requestedAt },
      ]);

      // Locked after one press, however often it is clicked.
      expect(screen.getByRole('button', { name: 'Sent' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
      expect(approvals()).toHaveLength(1);
    });

    it('unticking disables the button again', () => {
      connect();
      render(<AgentPanel />);
      show(printing());
      const box = screen.getByLabelText('The printer bed is clear and I am ready');
      fireEvent.click(box);
      fireEvent.click(box);
      expect(screen.getByRole('button', { name: 'Send to printer' })).toBeDisabled();
    });

    it('starts fresh (unticked, unlocked) for a new request, per requestedAt', () => {
      connect();
      render(<AgentPanel />);
      show(printing());
      fireEvent.click(screen.getByLabelText('The printer bed is clear and I am ready'));
      fireEvent.click(screen.getByRole('button', { name: 'Send to printer' }));
      expect(screen.getByRole('button', { name: 'Sent' })).toBeDisabled();

      show(printing({ ...REQUEST, requestedAt: '2026-11-10T10:05:00.000Z' }));
      expect(screen.getByRole('button', { name: 'Send to printer' })).toBeDisabled();
      expect(screen.getByLabelText('The printer bed is clear and I am ready')).not.toBeChecked();
      fireEvent.click(screen.getByLabelText('The printer bed is clear and I am ready'));
      fireEvent.click(screen.getByRole('button', { name: 'Send to printer' }));
      expect(approvals()).toHaveLength(2);
    });

    it.each([
      ['absent', undefined],
      ['null', null],
      ['malformed', { revisionId: 'r', fileName: 5 }],
      ['without an estimate', { ...REQUEST, estimate: undefined }],
    ])('treats a %s print request as no print request', (_name, request) => {
      connect();
      render(<AgentPanel />);
      show(printing(request));
      expect(screen.queryByTestId('agent-print-confirmation')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send to printer' })).toBeNull();
    });

    it('works against a server that never sends the print fields at all', () => {
      const old = state();
      delete old.printRequest;
      delete old.printJob;
      connect();
      render(<AgentPanel />);
      show(old);
      expect(screen.getByRole('button', { name: 'Confirm brief' })).toBeInTheDocument();
    });

    it('shows how the job is going, and why it failed', () => {
      connect();
      render(<AgentPanel />);
      show(state({ printJob: { state: 'failed', message: 'Printer offline', at: 'x' } }));
      expect(screen.getByTestId('agent-print-job')).toHaveTextContent(
        'The print did not start. Printer offline'
      );
    });
  });

  it('says when it is still connecting or waiting for the agent', () => {
    connect();
    render(<AgentPanel />);
    show(null, 'connecting');
    expect(screen.getByText('Connecting to the agent...')).toBeInTheDocument();
    show(null, 'open');
    expect(screen.getByText('Waiting for the agent...')).toBeInTheDocument();
  });

  it('collapses to its title bar', () => {
    connect();
    render(<AgentPanel />);
    show(state());
    fireEvent.click(screen.getByRole('button', { name: /Agent · intake/ }));
    expect(screen.queryByRole('button', { name: 'Confirm brief' })).toBeNull();
    expect(screen.getByText('Agent · intake')).toBeInTheDocument();
  });
});
