import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  GREENLEAF_CASE_ID,
  OperatorApiError,
  nextOperatorAction,
  operatorApi,
  type CaseOperatorView,
  type HelpArticle,
  type HelpTopic,
  type LocalOperatorSession,
  type OperatorAction,
  type OperatorQueueCase,
  type OperatorReceipt,
} from './api.js'
import { formatCaseTime, formatTimeRange, humanize, shortDigest } from './format.js'
import { canonicalReferenceHref } from './references.js'
import { authorityMessage } from './authority.js'
import './styles.css'

type LoadState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'working'

const orientationKey = 'trashpal.operator-orientation.seen'

/**
 * Design plan: this is a dispatcher workbench for one consequential choice,
 * not an analytics dashboard. The decision tape makes the case's known facts,
 * uncertainty, recommended recovery, and human authority visible in the same
 * reading order used to approve a work order. Everything else stays quiet.
 */
export default function App() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [session, setSession] = useState<LocalOperatorSession | null>(null)
  const [queue, setQueue] = useState<readonly OperatorQueueCase[]>([])
  const [caseView, setCaseView] = useState<CaseOperatorView | null>(null)
  const [receipt, setReceipt] = useState<OperatorReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showOrientation, setShowOrientation] = useState(() => localStorage.getItem(orientationKey) !== 'true')
  const [showHelp, setShowHelp] = useState(false)
  const [helpArticle, setHelpArticle] = useState<HelpArticle | null>(null)
  const [helpTopic, setHelpTopic] = useState<HelpTopic>('overview')
  const [helpLoading, setHelpLoading] = useState(false)
  const [helpError, setHelpError] = useState<string | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const loadWorkspace = async (caseId = GREENLEAF_CASE_ID) => {
    setLoadState('loading')
    setError(null)
    try {
      const activeSession = await operatorApi.startLocalSession()
      const cases = await operatorApi.listCases()
      const response = await operatorApi.getCase(caseId)
      setSession(activeSession)
      setQueue(cases)
      setCaseView(response.case)
      if (response.case.operation && response.case.receiptAvailable) {
        const receiptResponse = await operatorApi.getReceipt(response.case.operation.id)
        setCaseView(receiptResponse.case)
        setReceipt(receiptResponse.receipt)
      } else {
        setReceipt(null)
      }
      setLoadState('ready')
    } catch (caught) {
      setLoadState('error')
      setError(errorMessage(caught))
    }
  }

  useEffect(() => {
    void loadWorkspace()
  }, [])

  const operatorAction = caseView ? nextOperatorAction(caseView) : null
  const actionLabel = caseView ? labelForAction(operatorAction, caseView.nextAction.label) : null

  const runAction = async () => {
    if (!caseView || !operatorAction) return
    setActionState('working')
    setError(null)
    setNotice(null)
    try {
      const response = await executeAction(caseView, operatorAction)
      if (!response) return
      setCaseView(response.case)
      if ('receipt' in response && response.receipt) setReceipt(response.receipt)
      setNotice(noticeForAction(operatorAction, response.case))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setActionState('idle')
    }
  }

  const loadHelp = async (topic: HelpTopic) => {
    setHelpLoading(true)
    setHelpTopic(topic)
    setHelpError(null)
    try {
      setHelpArticle(await operatorApi.contextualHelp(topic))
    } catch (caught) {
      setHelpArticle(null)
      setHelpError(errorMessage(caught))
    } finally {
      setHelpLoading(false)
    }
  }

  const restoreFocus = () => {
    const preferred = returnFocusRef.current
    requestAnimationFrame(() => {
      if (preferred?.isConnected) {
        preferred.focus()
        return
      }
      document.getElementById('case-title')?.focus()
    })
  }

  const openHelp = async (invoker?: HTMLElement | null, preserveReturnFocus = false) => {
    if (invoker) returnFocusRef.current = invoker
    else if (!preserveReturnFocus && document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement
    setShowHelp(true)
    await loadHelp(helpTopicForAction(operatorAction))
  }

  const hideOrientation = (restore = true) => {
    localStorage.setItem(orientationKey, 'true')
    setShowOrientation(false)
    if (restore) restoreFocus()
  }

  const dismissOrientation = () => hideOrientation()

  const openOrientation = (invoker: HTMLElement) => {
    returnFocusRef.current = invoker
    setShowOrientation(true)
  }

  const closeHelp = () => {
    setShowHelp(false)
    restoreFocus()
  }

  if (loadState === 'loading') return <LoadingScreen />
  if (loadState === 'error' || !caseView) {
    return <ErrorScreen error={error ?? 'The workspace could not be loaded.'} onRetry={() => void loadWorkspace()} />
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#case-workspace">Skip to case workspace</a>
      <header className="app-header">
        <a className="brand" href="#case-workspace" aria-label="TrashPal operations workspace">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>TrashPal</span>
          <span className="brand-subtitle">Operations</span>
        </a>
        <div className="header-actions">
          <span className="session-label">{session?.actor.label ?? 'Dispatcher'}</span>
          <button className="quiet-button" type="button" aria-label="Learn how this workspace works" onClick={(event) => openOrientation(event.currentTarget)}>How it works</button>
          <button className="help-button" type="button" onClick={(event) => void openHelp(event.currentTarget)}>Help</button>
        </div>
      </header>

      <nav className="case-queue" aria-label="Exception queue">
        <div><p className="eyebrow">Exception queue</p><strong>{queue.length || 3} local scenarios</strong></div>
        <div className="case-queue__items">
          {queue.map((item) => <button key={item.id} type="button" className={item.id === caseView.case.id ? 'case-queue__item is-selected' : 'case-queue__item'} onClick={() => void loadWorkspace(item.id)} disabled={actionState === 'working'}>
            <span>{item.title}</span><small>{item.priority}</small>
          </button>)}
        </div>
      </nav>

      <section className="case-head" aria-labelledby="case-title">
        <div>
          <p className="eyebrow">Service exception · {caseView.case.serviceType}</p>
          <h1 id="case-title" tabIndex={-1}>{caseView.case.title}</h1>
          <p className="case-summary">{caseView.summary.whatHappened}</p>
        </div>
        <dl className="case-facts" aria-label="Case details">
          <div>
            <dt>Priority</dt>
            <dd><span className="priority-chip">{caseView.case.priority}</span></dd>
          </div>
          <div>
            <dt>Window ends</dt>
            <dd>{formatCaseTime(caseView.case.serviceWindowEndsAt, caseView.case.timeZone)}</dd>
          </div>
          <div>
            <dt>Case</dt>
            <dd className="mono">{caseView.case.id}</dd>
          </div>
        </dl>
      </section>

      <div className="workspace" id="case-workspace" tabIndex={-1}>
        <section className="decision-region" aria-labelledby="decision-title">
          <div className="region-heading">
            <div>
              <p className="eyebrow">Decision brief</p>
              <h2 id="decision-title">Recovery review</h2>
            </div>
            <p>Pal prepares the work. You approve the exact recovery.</p>
          </div>

          <ol className="decision-tape" aria-label="Recovery decision">
            <DecisionStep kind="known" title={knownStepTitle(caseView.summary.phase)}>
              <EvidenceSummary phase={caseView.summary.phase} checked={caseView.summary.whatPalChecked} evidence={caseView.evidence} />
            </DecisionStep>
            <DecisionStep kind="needs" title="Needs confirmation">
              <Unknowns item={caseView.summary.whatIsUnknown} />
            </DecisionStep>
            <DecisionStep kind="recommended" title={caseView.summary.phase === 'historical_decision' ? 'Prior recovery decision' : 'Recommended recovery'}>
              <ProposalSummary proposal={caseView.proposal} phase={caseView.summary.phase} nextAction={caseView.nextAction.kind} timeZone={caseView.case.timeZone} />
            </DecisionStep>
            <DecisionStep kind="authority" title="Your authority">
              <AuthoritySummary view={caseView} />
            </DecisionStep>
          </ol>

          <ActionPanel
            view={caseView}
            action={operatorAction}
            label={actionLabel}
            pending={actionState === 'working'}
            onAction={() => void runAction()}
            onHelp={() => void openHelp()}
          />

          {notice ? <p className="notice" role="status">{notice}</p> : null}
          {error ? <p className="inline-error" role="alert">{error}</p> : null}

          {caseView.palRun ? <PalRunSummary run={caseView.palRun} /> : null}
          <ActivityStream activity={caseView.activity} timeZone={caseView.case.timeZone} />
        </section>

        <aside className="evidence-rail" aria-label="Evidence and record">
          <EvidenceRail evidence={caseView.evidence} />
          <OperationRecord view={caseView} receipt={receipt} />
        </aside>
      </div>

      <footer className="app-footer">
        <span>Pal can prepare a recovery from case-scoped evidence. It cannot send work without the required approval.</span>
        <button type="button" className="footer-help" onClick={(event) => void openHelp(event.currentTarget)}>Read the recovery guide</button>
      </footer>

      {showOrientation ? <OrientationDialog onClose={dismissOrientation} onHelp={() => { hideOrientation(false); void openHelp(undefined, true) }} /> : null}
      {showHelp ? <HelpDrawer article={helpArticle} error={helpError} loading={helpLoading} topic={helpTopic} onSelectTopic={(topic) => void loadHelp(topic)} onClose={closeHelp} /> : null}
    </main>
  )
}

function PalRunSummary({ run }: { readonly run: NonNullable<CaseOperatorView['palRun']> }): ReactNode {
  return (
    <section className="pal-run" aria-labelledby="pal-run-title">
      <div><p className="eyebrow">Inspectable Pal run</p><h2 id="pal-run-title">What Pal used</h2></div>
      <p><strong>{run.skillCount} bounded skill calls.</strong> Outcome: {humanize(run.outcome)}. Reasoner: local deterministic; no model provider was contacted.</p>
      <dl><div><dt>Included context</dt><dd>{run.includedEvidence.join(', ') || 'None'}</dd></div><div><dt>Omitted context</dt><dd>{run.omittedEvidence.join(', ') || 'None'}</dd></div><div><dt>Conflicts</dt><dd>{run.conflicts.join(', ') || 'None'}</dd></div></dl>
    </section>
  )
}

function ActivityStream({
  activity,
  timeZone,
}: {
  readonly activity: CaseOperatorView['activity']
  readonly timeZone: string
}): ReactNode {
  return (
    <section className="activity-stream" aria-labelledby="activity-title">
      <div className="activity-heading">
        <div>
          <p className="eyebrow">Live lifecycle</p>
          <h2 id="activity-title">Pal&apos;s work</h2>
        </div>
        <p>Read-only events from the case and durable operation records.</p>
      </div>
      <ol className="activity-list">
        {activity.map((item) => (
          <li className={`activity-item activity-item--${item.status}`} key={item.id}>
            <span className="activity-marker" aria-hidden="true" />
            <div>
              <div className="activity-title-row">
                <h3>{item.label}</h3>
                {item.occurredAt ? <time dateTime={item.occurredAt}>{formatCaseTime(item.occurredAt, timeZone)}</time> : null}
              </div>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function LoadingScreen(): ReactNode {
  return (
    <main className="loading-screen" aria-live="polite">
      <span className="brand-mark" aria-hidden="true">T</span>
      <p>Opening the dispatcher workspace…</p>
    </main>
  )
}

function ErrorScreen({ error, onRetry }: { readonly error: string; readonly onRetry: () => void }): ReactNode {
  return (
    <main className="error-screen">
      <div className="error-card">
        <p className="eyebrow">Workspace unavailable</p>
        <h1>The case could not be opened</h1>
        <p>{error}</p>
        <p className="error-hint">Start the local API, then try again. The browser holds no session token.</p>
        <button className="primary-button" type="button" onClick={onRetry}>Try again</button>
      </div>
    </main>
  )
}

function DecisionStep({ kind, title, children }: { readonly kind: string; readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <li className={`decision-step decision-step--${kind}`}>
      <span className="tape-marker" aria-hidden="true" />
      <div className="step-content">
        <p className="step-label">{title}</p>
        {children}
      </div>
    </li>
  )
}

function knownStepTitle(phase: CaseOperatorView['summary']['phase']): string {
  if (phase === 'recovery_prepared') return 'What Pal checked'
  if (phase === 'historical_decision') return 'Historical case record'
  return 'Case information available'
}

function EvidenceSummary({ phase, checked, evidence }: {
  readonly phase: CaseOperatorView['summary']['phase']
  readonly checked: readonly string[]
  readonly evidence: readonly CaseOperatorView['evidence'][number][]
}): ReactNode {
  if (!evidence.length) return <p className="empty-copy">No evidence has been returned for this case yet.</p>
  const summary = phase === 'historical_decision'
    ? 'The prior recovery decision has expired and cannot be reused. These records explain the existing operation only; follow its current status before considering new work.'
    : phase === 'recovery_prepared'
      ? checked.join(' ')
      : 'The case record is available for review. Prepare a recovery to have Pal investigate the allowed case sources.'
  return (
    <>
      <p className="tape-summary">{summary}</p>
      <ul className="fact-list">
        {evidence.slice(0, 3).map((item) => <li key={item.id}>{item.detail}</li>)}
      </ul>
    </>
  )
}

function Unknowns({ item }: { readonly item: readonly string[] }): ReactNode {
  return item.length
    ? <ul className="unknown-list">{item.map((entry) => <li key={entry}>{entry}</li>)}</ul>
    : <p className="empty-copy">Pal did not return an unresolved case fact.</p>
}

function ProposalSummary({ proposal, phase, nextAction, timeZone }: {
  readonly proposal: CaseOperatorView['proposal']
  readonly phase: CaseOperatorView['summary']['phase']
  readonly nextAction: CaseOperatorView['nextAction']['kind']
  readonly timeZone: string
}): ReactNode {
  if (!proposal) {
    return <p className="empty-copy">{phase === 'historical_decision'
      ? historicalDecisionGuidance(nextAction)
      : 'No recovery has been prepared. Pal must gather the required evidence first.'}</p>
  }
  return (
    <div className="proposal-summary">
      <p className="proposal-title">Insert {proposal.workOrder.vehicleId} during the quoted recovery window.</p>
      <dl className="proposal-facts">
        <div><dt>Service window</dt><dd>{formatTimeRange(proposal.workOrder.serviceStart, proposal.workOrder.serviceEnd, timeZone)}</dd></div>
        <div><dt>Valid until</dt><dd>{formatCaseTime(proposal.validUntil, timeZone)}</dd></div>
      </dl>
      <p className="proposal-evidence-label">Evidence cited in this recovery</p>
      <ul className="evidence-token-list">
        {[...new Set(proposal.claims.flatMap((claim) => claim.evidenceIds))].map((evidenceId) => <li key={evidenceId}>{evidenceId}</li>)}
      </ul>
    </div>
  )
}

function historicalDecisionGuidance(action: CaseOperatorView['nextAction']['kind']): string {
  if (action === 'dispatch') return 'The prior recovery decision is expired and non-reusable. Send only the existing durable operation; do not prepare new work from this historical record.'
  if (action === 'reconcile') return 'The prior recovery decision is expired and non-reusable. Reconcile the existing operation before considering new work.'
  if (action === 'view_receipt') return 'The prior recovery decision is expired and non-reusable. Inspect the existing operation receipt before considering new work.'
  if (action === 'monitor') return 'The prior recovery decision is expired and non-reusable. Monitor the existing operation record before considering new work.'
  return 'The prior recovery decision is expired and non-reusable. Follow the existing operation record before considering new work.'
}

function AuthoritySummary({ view }: { readonly view: CaseOperatorView }): ReactNode {
  const action = nextOperatorAction(view)
  const binding = view.approval?.digest ?? view.proposal?.digest
  const message = authorityMessage(action, Boolean(view.operation))
  return (
    <div className="authority-copy">
      <p>{message}</p>
      {binding ? <p className="binding-fact">Record binding <code>{shortDigest(binding)}</code></p> : null}
    </div>
  )
}

function ActionPanel({ view, action, label, pending, onAction, onHelp }: {
  readonly view: CaseOperatorView
  readonly action: ReturnType<typeof nextOperatorAction>
  readonly label: string | null
  readonly pending: boolean
  readonly onAction: () => void
  readonly onHelp: () => void
}): ReactNode {
  if (!action || !label) {
    return (
      <section className="action-panel action-panel--complete" aria-label="Current case state">
        <div><p className="eyebrow">Current state</p><h3>{view.nextAction.label}</h3></div>
        <button className="text-button" type="button" onClick={onHelp}>Understand the record</button>
      </section>
    )
  }
  const actionMessage = action === 'prepare'
    ? 'Pal will check the allowed sources and prepare a cited recovery if the case is eligible.'
    : action === 'approve'
      ? 'Approval binds the exact work order and its evidence snapshot. A changed case needs a fresh review.'
      : action === 'reserve'
        ? 'This creates one durable operation from the approved recovery. It does not send a vehicle yet.'
        : action === 'dispatch'
          ? 'This sends the approved, reserved recovery through the dispatch connector.'
          : action === 'reconcile'
            ? 'This checks the durable operation record before any retry is considered.'
            : 'This loads the receipt linked to the durable operation.'
  return (
    <section className="action-panel" aria-label="Next action">
      <div>
        <p className="eyebrow">Next action</p>
        <h3>{label}</h3>
        <p>{actionMessage}</p>
      </div>
      <button className="primary-button" type="button" disabled={pending} onClick={onAction}>
        {pending ? 'Working…' : label}
      </button>
    </section>
  )
}

function EvidenceRail({ evidence }: { readonly evidence: readonly CaseOperatorView['evidence'][number][] }): ReactNode {
  return (
    <section className="rail-section">
      <div className="rail-heading"><p className="eyebrow">Evidence</p><h2>Case record</h2></div>
      {evidence.length ? <ul className="evidence-list">
        {evidence.map((item) => (
          <li key={item.id}>
            <span className={`evidence-status evidence-status--${item.status.toLowerCase().replaceAll(/[^a-z]/g, '')}`} aria-hidden="true" />
            <div><strong>{item.label}</strong><p>{item.detail}</p><code>{item.id}</code></div>
          </li>
        ))}
      </ul> : <p className="empty-copy rail-empty">Evidence will appear when the case record is loaded.</p>}
    </section>
  )
}

function OperationRecord({ view, receipt }: { readonly view: CaseOperatorView; readonly receipt: OperatorReceipt | null }): ReactNode {
  const { operation } = view
  return (
    <section className="rail-section operation-record">
      <div className="rail-heading"><p className="eyebrow">Operation</p><h2>Durable record</h2></div>
      {!operation ? <p className="empty-copy rail-empty">A durable operation is created only after the exact recovery is approved.</p> : (
        <dl className="record-list">
          <div><dt>State</dt><dd><span className="state-chip">{humanize(operation.state)}</span></dd></div>
          <div><dt>Operation</dt><dd><code>{operation.id}</code></dd></div>
          <div><dt>Revision</dt><dd className="mono">{operation.revision}</dd></div>
          <div><dt>Last record</dt><dd>{formatCaseTime(operation.updatedAt, view.case.timeZone)}</dd></div>
          {operation.providerAssignmentId ? <div><dt>Dispatch assignment</dt><dd><code>{operation.providerAssignmentId}</code></dd></div> : null}
        </dl>
      )}
      {receipt ? (
        <div className="receipt-card">
          <p className="eyebrow">Receipt</p>
          <strong>{humanize(receipt.state)}</strong>
          <span>Recorded {formatCaseTime(receipt.recordedAt, view.case.timeZone)}</span>
          <code>{shortDigest(receipt.digest)}</code>
          <dl className="receipt-bindings">
            <div><dt>Work order</dt><dd>{receipt.binding.workOrder.vehicleId} · {formatTimeRange(receipt.binding.workOrder.serviceStart, receipt.binding.workOrder.serviceEnd, view.case.timeZone)}</dd></div>
            <div><dt>Decision</dt><dd><code>{shortDigest(receipt.binding.proposalDigest)}</code></dd></div>
            <div><dt>Approval</dt><dd><code>{shortDigest(receipt.binding.approvalDigest)}</code></dd></div>
            <div><dt>Route quote</dt><dd><code>{shortDigest(receipt.binding.routeQuoteHash)}</code></dd></div>
            <div><dt>Evidence</dt><dd>{receipt.binding.evidenceIds.length ? receipt.binding.evidenceIds.join(', ') : `${receipt.evidenceCount} recorded evidence items`}</dd></div>
          </dl>
        </div>
      ) : view.receiptAvailable ? <p className="empty-copy rail-empty">A receipt is available from the durable operation record.</p> : null}
    </section>
  )
}

function OrientationDialog({ onClose, onHelp }: { readonly onClose: () => void; readonly onHelp: () => void }): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, onClose)
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={panelRef} className="orientation-dialog" role="dialog" aria-modal="true" aria-labelledby="orientation-title" aria-describedby="orientation-copy">
        <p className="eyebrow">Welcome to TrashPal</p>
        <h2 id="orientation-title">A focused workspace for service exceptions</h2>
        <p id="orientation-copy">Pal checks the case-scoped facts it is allowed to use and can prepare a recovery. It cannot send work on its own. As dispatcher, you inspect the evidence and approve the exact recovery when it is safe to do so.</p>
        <ol className="orientation-list">
          <li><span>1</span><div><strong>Read the decision tape</strong><p>See what is known, what needs confirmation, and what Pal recommends.</p></div></li>
          <li><span>2</span><div><strong>Review the exact work order</strong><p>Approval is bound to its quoted time, vehicle, evidence, and validity window.</p></div></li>
          <li><span>3</span><div><strong>Handle uncertainty deliberately</strong><p>When a dispatch acknowledgement is uncertain, reconcile the operation before trying anything else.</p></div></li>
        </ol>
        <div className="dialog-actions">
          <button className="text-button" type="button" onClick={onHelp}>Read the guide</button>
          <button className="primary-button" type="button" onClick={onClose}>Open case</button>
        </div>
      </section>
    </div>
  )
}

function HelpDrawer({ article, error, loading, topic, onSelectTopic, onClose }: {
  readonly article: HelpArticle | null
  readonly error: string | null
  readonly loading: boolean
  readonly topic: HelpTopic
  readonly onSelectTopic: (topic: HelpTopic) => void
  readonly onClose: () => void
}): ReactNode {
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, onClose)
  return (
    <div className="drawer-layer" role="presentation">
      <button className="drawer-scrim" type="button" aria-label="Close Help" onClick={onClose} />
      <aside ref={panelRef} className="help-drawer" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div className="drawer-heading">
          <div><p className="eyebrow">Help Center</p><h2 id="help-title">Recovery guide</h2></div>
          <button className="close-button" type="button" onClick={onClose} aria-label="Close Help">×</button>
        </div>
        <nav className="help-nav" aria-label="Help Center topics">
          {helpTopics.map((item) => <button key={item.topic} className={topic === item.topic ? 'help-nav__item is-current' : 'help-nav__item'} type="button" onClick={() => onSelectTopic(item.topic)}>{item.label}</button>)}
        </nav>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {loading ? <p className="empty-copy">Loading guidance…</p> : article ? <article className="help-article"><p className="eyebrow">{humanize(article.topic)}</p><CanonicalMarkdown article={article} onSelectTopic={onSelectTopic} /></article> : <p className="empty-copy">The Help Center article is not available. The case record remains available.</p>}
        <p className="help-boundary">Guidance explains the workflow. It does not replace the case evidence or approval record.</p>
      </aside>
    </div>
  )
}

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }

/**
 * This narrow renderer accepts the Markdown constructs used by docs/help. It
 * deliberately returns React text nodes rather than HTML, so Help content
 * stays docs-as-code without introducing an HTML execution surface.
 */
function CanonicalMarkdown({ article, onSelectTopic }: {
  readonly article: HelpArticle
  readonly onSelectTopic: (topic: HelpTopic) => void
}): ReactNode {
  const blocks = parseMarkdown(article.markdown)
  const includesDocumentTitle = blocks.some((block) => block.kind === 'heading' && block.level === 1)
  return (
    <>
      {includesDocumentTitle ? null : <h3>{article.title}</h3>}
      {blocks.map((block, index) => <MarkdownBlockView key={`${block.kind}-${index}`} block={block} onSelectTopic={onSelectTopic} />)}
    </>
  )
}

function MarkdownBlockView({ block, onSelectTopic }: {
  readonly block: MarkdownBlock
  readonly onSelectTopic: (topic: HelpTopic) => void
}): ReactNode {
  if (block.kind === 'heading') {
    if (block.level === 1) return <h3>{renderInlineMarkdown(block.text, onSelectTopic)}</h3>
    if (block.level === 2) return <h4>{renderInlineMarkdown(block.text, onSelectTopic)}</h4>
    return <h5>{renderInlineMarkdown(block.text, onSelectTopic)}</h5>
  }
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul'
    return <List className={block.ordered ? 'markdown-list markdown-list--ordered' : 'markdown-list'}>{block.items.map((item, index) => <li key={`${index}-${item}`}>{renderInlineMarkdown(item, onSelectTopic)}</li>)}</List>
  }
  return <p>{renderInlineMarkdown(block.text, onSelectTopic)}</p>
}

function parseMarkdown(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ''
    if (!line) {
      index += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const hashes = heading[1]
      const text = heading[2]
      if (hashes && text) blocks.push({ kind: 'heading', level: hashes.length, text })
      index += 1
      continue
    }
    const list = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line)
    if (list) {
      const ordered = /^\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const candidate = lines[index]?.trim() ?? ''
        const next = ordered
          ? /^\d+[.)]\s+(.+)$/.exec(candidate)
          : /^(?:[-*+]\s+)(.+)$/.exec(candidate)
        if (!next) break
        const item = next[1]
        if (item) items.push(item)
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index]?.trim() ?? ''
      if (!candidate || /^(#{1,3})\s+/.test(candidate) || /^(?:[-*+]\s+|\d+[.)]\s+)/.test(candidate)) break
      paragraph.push(candidate)
      index += 1
    }
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

function renderInlineMarkdown(text: string, onSelectTopic: (topic: HelpTopic) => void): readonly ReactNode[] {
  const nodes: ReactNode[] = []
  const link = /\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g
  let cursor = 0
  for (let match = link.exec(text); match; match = link.exec(text)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const label = match[1] ?? ''
    const topic = topicForMarkdownLink(match[2] ?? '')
    const referenceHref = canonicalReferenceHref(match[2] ?? '')
    if (topic) {
      nodes.push(<button className="markdown-link" type="button" key={`${match.index}-${topic}`} onClick={() => onSelectTopic(topic)}>{label}</button>)
    } else if (referenceHref) {
      nodes.push(<a className="markdown-reference-link" key={`${match.index}-${label}`} href={referenceHref} target="_blank" rel="noopener">{label}</a>)
    } else {
      nodes.push(<span className="markdown-reference" key={`${match.index}-${label}`}>{label}</span>)
    }
    cursor = match.index + (match[0] ?? '').length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function topicForMarkdownLink(href: string): HelpTopic | null {
  const filename = href.split('#')[0]?.split('/').at(-1)
  switch (filename) {
    case 'index.md': return 'overview'
    case 'resolve-a-missed-collection.md': return 'prepare'
    case 'review-and-approve-a-recovery.md': return 'approve'
    case 'check-an-uncertain-dispatch.md': return 'reconcile'
    case 'read-a-recovery-receipt.md': return 'receipt'
    case 'developer-reference.md': return 'developer-reference'
    default: return null
  }
}

function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, onEscape?: () => void): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    const first = focusable()[0]
    first?.focus()
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      const firstControl = controls[0]
      const lastControl = controls.at(-1)
      if (!firstControl || !lastControl) return
      if (event.shiftKey && document.activeElement === firstControl) {
        event.preventDefault()
        lastControl.focus()
      } else if (!event.shiftKey && document.activeElement === lastControl) {
        event.preventDefault()
        firstControl.focus()
      }
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [onEscape, ref])
}

function labelForAction(action: OperatorAction | null, serverLabel: string): string {
  if (action === 'prepare') return 'Prepare reviewed recovery'
  if (action === 'approve') return 'Approve exact recovery'
  if (action === 'reserve') return 'Create dispatch request'
  if (action === 'dispatch') return 'Send approved recovery'
  if (action === 'reconcile') return 'Reconcile operation'
  return serverLabel
}

function noticeForAction(action: OperatorAction, view: CaseOperatorView): string {
  if (action === 'prepare') return view.proposal ? 'Pal prepared a cited recovery for review.' : 'Pal did not prepare a recovery from the current case record.'
  if (action === 'approve') return 'The exact recovery is approved and its durable dispatch request now exists.'
  if (action === 'reserve') return 'The approved recovery is now a durable dispatch request.'
  if (action === 'dispatch') return 'The approved recovery was sent to the dispatch connector. Its outcome remains a record, not an assumption.'
  if (action === 'reconcile') return 'The durable operation record was reconciled.'
  return view.receiptAvailable ? 'The operation receipt is available for review.' : 'The durable operation record has no receipt yet.'
}

const helpTopics: readonly { readonly topic: HelpTopic; readonly label: string }[] = [
  { topic: 'overview', label: 'Overview' },
  { topic: 'prepare', label: 'Prepare' },
  { topic: 'approve', label: 'Approve' },
  { topic: 'dispatch', label: 'Dispatch' },
  { topic: 'reconcile', label: 'Reconcile' },
  { topic: 'receipt', label: 'Receipt' },
  { topic: 'developer-reference', label: 'Developer reference' },
]

function helpTopicForAction(action: OperatorAction | null): HelpTopic {
  if (action === 'prepare') return 'prepare'
  if (action === 'approve' || action === 'reserve') return 'approve'
  if (action === 'dispatch') return 'dispatch'
  if (action === 'reconcile') return 'reconcile'
  if (action === 'view_receipt') return 'receipt'
  return 'overview'
}

async function executeAction(view: CaseOperatorView, action: OperatorAction) {
  if (action === 'prepare') return await operatorApi.prepare(view.case.id)
  if (action === 'approve' && view.proposal) return await operatorApi.approve(view.proposal.id)
  if (action === 'reserve' && view.approval) return await operatorApi.reserve(view.approval.digest)
  if (action === 'dispatch' && view.operation) return await operatorApi.dispatch(view.operation.id)
  if (action === 'reconcile' && view.operation) return await operatorApi.reconcile(view.operation.id)
  if (action === 'view_receipt' && view.operation) return await operatorApi.getReceipt(view.operation.id)
  throw new Error('The current server-owned action is missing its required record binding.')
}

function errorMessage(caught: unknown): string {
  if (caught instanceof OperatorApiError) return caught.message
  if (caught instanceof Error) return caught.message
  return 'The local service returned an unexpected response.'
}
