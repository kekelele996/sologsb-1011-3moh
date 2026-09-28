import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  activeRevision,
  applyRules,
  cloneModel,
  createInitialModel,
  diffText,
  markSegmentReviewed,
  mergeConfirmedSegments,
  migrateModel,
  normalizeNumbers,
  queueStats,
  resolveRevisionConflict,
  resolveSegmentRevision,
  STORAGE_KEY,
  simulateLatency,
  submitSegmentRevision,
  toSrt,
  type CaptionRevision,
  type CaptionSegment,
  type ConflictChoice,
  type ConnectionState,
  type DeskModel,
  type SegmentReviewState,
  type SegmentState,
  type ToastMessage,
} from './model';

const HISTORY_LIMIT = 80;

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
}

function stateLabel(state: SegmentState): string {
  return {
    pending: '待确认',
    confirmed: '已确认',
    duplicate: '重复片段',
    stale: '过期修改',
    ignored: '已忽略',
  }[state];
}

function connectionLabel(state: ConnectionState): string {
  return { connected: '连接稳定', degraded: '延迟波动', offline: '离线校正' }[state];
}

function reviewStateLabel(review: SegmentReviewState): string {
  return { unreviewed: '未复查', pending: '待复核', reviewed: '已复查' }[review];
}

function revisionStatusLabel(status: CaptionRevision['status']): string {
  return { pending: '待复核', approved: '复核通过', rejected: '复核驳回', conflict: '版本冲突待裁决' }[status];
}

function formatStamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

@customElement('caption-desk')
export class CaptionDesk extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      --caption-font-size: 18px;
      color: var(--cds-text-primary, #161616);
      background: var(--cds-background, #f4f4f4);
      font-family: "IBM Plex Sans", "PingFang SC", sans-serif;
    }

    * { box-sizing: border-box; }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
      background:
        linear-gradient(90deg, rgba(15,98,254,.025) 1px, transparent 1px),
        linear-gradient(rgba(15,98,254,.025) 1px, transparent 1px),
        var(--cds-background, #f4f4f4);
      background-size: 24px 24px;
    }

    .shell.dark {
      --cds-background: #161616;
      --cds-layer: #262626;
      --cds-layer-01: #262626;
      --cds-layer-02: #393939;
      --cds-field: #262626;
      --cds-text-primary: #f4f4f4;
      --cds-text-secondary: #c6c6c6;
      --cds-border-subtle: #393939;
      --cds-border-strong: #6f6f6f;
      color: #f4f4f4;
    }

    .topbar {
      min-height: 64px;
      padding: 8px 18px 8px 20px;
      display: grid;
      grid-template-columns: minmax(330px, 1fr) auto minmax(420px, 1fr);
      align-items: center;
      gap: 20px;
      background: #161616;
      color: #f4f4f4;
      border-bottom: 1px solid #393939;
      position: relative;
      z-index: 5;
    }

    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark {
      width: 38px; height: 38px; display: grid; place-items: center;
      border: 1px solid #78a9ff; color: #78a9ff; font: 600 11px/1 "IBM Plex Mono", monospace;
      clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
    }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; font-size: 15px; letter-spacing: .015em; white-space: nowrap; }
    .brand-copy span { display: block; color: #a8a8a8; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .connection-pill {
      justify-self: center; display: flex; align-items: center; gap: 10px; padding: 8px 13px;
      min-width: 260px; background: #262626; border: 1px solid #525252;
    }
    .connection-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #42be65; box-shadow: 0 0 0 4px rgba(66,190,101,.13); }
    .connection-pill.degraded .connection-dot { background: #f1c21b; box-shadow: 0 0 0 4px rgba(241,194,27,.14); }
    .connection-pill.offline .connection-dot { background: #fa4d56; box-shadow: 0 0 0 4px rgba(250,77,86,.14); }
    .connection-copy { min-width: 0; }
    .connection-copy strong { display: block; font-size: 12px; }
    .connection-copy small { display: block; color: #c6c6c6; margin-top: 2px; font-size: 10px; }

    .header-actions { justify-self: end; display: flex; align-items: center; gap: 8px; }
    .header-actions cds-button { --cds-button-primary: #0f62fe; }

    .status-strip {
      min-height: 60px; padding: 8px 20px; display: grid; grid-template-columns: 1.4fr repeat(5, minmax(96px, .55fr)) auto;
      gap: 0; align-items: stretch; background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .status-cell { padding: 7px 16px; border-right: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; flex-direction: column; justify-content: center; }
    .status-cell:first-child { padding-left: 4px; }
    .status-cell:last-child { border-right: 0; }
    .status-cell strong { font-size: 20px; font-weight: 400; line-height: 1.05; font-variant-numeric: tabular-nums; }
    .status-cell span { margin-top: 3px; color: var(--cds-text-secondary, #525252); font-size: 10px; letter-spacing: .03em; }
    .status-cell.warning strong, .status-cell.warning span { color: #b28600; }
    .status-cell.danger strong, .status-cell.danger span { color: #da1e28; }
    .status-cell.hero strong { font-size: 14px; }
    .queue-track { width: 100%; height: 3px; margin-top: 6px; background: #e0e0e0; }
    .queue-track > span { display: block; height: 100%; background: #0f62fe; transition: width .3s ease; }
    .font-controls { min-width: 190px; padding: 7px 4px 7px 18px; display: flex; align-items: center; gap: 8px; }
    .font-controls label { color: var(--cds-text-secondary, #525252); font-size: 10px; }

    .workspace {
      min-height: 0; display: grid; grid-template-columns: minmax(390px, .95fr) minmax(430px, 1.05fr) minmax(370px, .9fr);
      gap: 1px; background: var(--cds-border-subtle, #e0e0e0); overflow: hidden;
    }

    .column { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--cds-background, #f4f4f4); }
    .column-head {
      min-height: 62px; padding: 11px 14px 9px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .column-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .column-head p { margin: 4px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .column-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #8d8d8d transparent; }

    .segment-list { padding: 8px; display: flex; flex-direction: column; gap: 1px; }
    .segment-card {
      width: 100%; border: 0; border-left: 3px solid transparent; background: var(--cds-layer, #fff);
      color: inherit; text-align: left; padding: 11px 12px 10px 14px; cursor: pointer; position: relative;
    }
    .segment-card:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .segment-card.selected { border-left-color: #0f62fe; background: var(--cds-layer-selected, #edf5ff); outline: 1px solid #78a9ff; }
    .segment-card.duplicate { border-left-color: #a56eff; }
    .segment-card.stale { border-left-color: #f1c21b; background: color-mix(in srgb, #fff 92%, #f1c21b 8%); }
    .segment-card.confirmed { border-left-color: #42be65; }
    .segment-card.review-pending { border-left-color: #f1c21b; background: color-mix(in srgb, #fff 92%, #f1c21b 8%); }
    .segment-card.review-conflict { border-left-color: #fa4d56; background: color-mix(in srgb, #fff 92%, #fa4d56 8%); }
    .segment-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
    .segment-meta > span:first-child { color: var(--cds-text-secondary, #525252); font: 500 10px/1 "IBM Plex Mono", monospace; }
    .segment-state { font-size: 10px; color: #525252; }
    .segment-state.stale { color: #8d6e00; }
    .segment-state.duplicate { color: #6929c4; }
    .segment-state.confirmed { color: #198038; }
    .segment-text { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .segment-corrected { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid #42be65; color: #198038; font-size: calc(var(--caption-font-size) * .88); line-height: 1.45; }
    .segment-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .segment-foot b { color: #0f62fe; font-weight: 500; }
    .issue-note { margin-top: 8px; padding: 7px 8px; background: #fff8e1; border-left: 2px solid #f1c21b; color: #684e00; font-size: 10px; line-height: 1.45; }
    .duplicate-note { background: #f6f2ff; border-color: #a56eff; color: #491d8b; }

    .empty { padding: 48px 24px; text-align: center; color: var(--cds-text-secondary, #525252); }
    .empty strong { display: block; color: var(--cds-text-primary, #161616); margin-bottom: 6px; }
    .empty p { margin: 0; font-size: 11px; line-height: 1.5; }

    .editor-scroll { padding: 14px; overflow: auto; }
    .editor-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .editor-top { padding: 12px 14px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
    .editor-time { color: #0f62fe; font: 500 12px/1.4 "IBM Plex Mono", monospace; }
    .editor-title { margin: 4px 0 0; font-size: 12px; color: var(--cds-text-secondary, #525252); }
    .editor-status { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .editor-form { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
    .form-grid { display: grid; grid-template-columns: minmax(130px, .6fr) 1fr; gap: 12px; align-items: end; }
    .caption-input { min-height: 158px; --cds-body-compact-01-font-size: var(--caption-font-size); --cds-body-compact-02-font-size: var(--caption-font-size); }
    .edit-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .edit-toolbar > span { margin-right: 5px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .number-input { width: 110px; }
    .rule-suggestions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .rule-suggestions small { color: var(--cds-text-secondary, #525252); }
    .confirm-bar { padding: 12px 14px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer-02, #f4f4f4); }
    .confirm-hint { color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.4; }
    .confirm-hint kbd { padding: 3px 5px; border: 1px solid var(--cds-border-strong, #8d8d8d); background: var(--cds-layer, #fff); color: var(--cds-text-primary, #161616); font: 10px/1 "IBM Plex Mono", monospace; }

    .inspector { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 14px; }
    .inspector-section { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .inspector-section-head { padding: 10px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .inspector-section-head h3 { margin: 0; font-size: 12px; }
    .inspector-section-head span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-list { padding: 5px 0; }
    .rule-item { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .rule-item:last-child { border-bottom: 0; }
    .rule-item strong { display: block; font-size: 11px; }
    .rule-item p { margin: 3px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-item-actions { display: flex; gap: 3px; }
    .rule-form { padding: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rule-form cds-text-input, .rule-form cds-button { width: 100%; }
    .rule-form .full { grid-column: 1 / -1; }
    .live-timeline { padding: 6px 0; }
    .delivery-status { margin: 0 10px 10px; padding: 9px 10px; background: #edf5ff; border-left: 3px solid #0f62fe; color: #0043ce; font-size: 10px; line-height: 1.45; }

    .revision-banner { margin: 0 10px 9px; padding: 9px 11px; border-left: 3px solid #0f62fe; background: #edf5ff; color: #0043ce; font-size: 10px; line-height: 1.5; }
    .revision-banner.review-pending { border-color: #f1c21b; background: #fff8e1; color: #684e00; }
    .revision-banner.review-conflict { border-color: #fa4d56; background: #fff1f1; color: #a2191f; }
    .revision-banner.review-done { border-color: #42be65; background: #defbe6; color: #198038; }
    .revision-banner strong { display: block; font-size: 11px; margin-bottom: 3px; }

    .revision-scroll { padding: 14px; overflow: auto; }
    .revision-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); margin-bottom: 12px; }
    .revision-card-head { padding: 12px 14px 10px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .revision-card-body { padding: 13px 14px; display: flex; flex-direction: column; gap: 12px; }
    .review-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

    .review-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-size: 10px; border: 1px solid transparent; white-space: nowrap; }
    .review-badge.unreviewed { background: #f4f4f4; border-color: #c6c6c6; color: #525252; }
    .review-badge.pending { background: #fff8e1; border-color: #f1c21b; color: #684e00; }
    .review-badge.conflict { background: #fff1f1; border-color: #fa4d56; color: #a2191f; }
    .review-badge.reviewed { background: #defbe6; border-color: #42be65; color: #198038; }

    .live-box { border-left: 3px solid #42be65; background: #f4f4f4; padding: 10px 12px; }
    .live-box.live-pending { border-color: #f1c21b; background: #fff8e1; }
    .live-box h4 { margin: 0 0 6px; font-size: 10px; color: #525252; letter-spacing: .04em; }
    .live-box p { margin: 0; font-size: calc(var(--caption-font-size) * .96); line-height: 1.55; }
    .live-box footer { margin-top: 7px; font-size: 10px; color: var(--cds-text-secondary, #525252); }

    .propose-box { border-left: 3px solid #0f62fe; background: #edf5ff; padding: 10px 12px; }
    .propose-box h4 { margin: 0 0 6px; font-size: 10px; color: #0043ce; letter-spacing: .04em; }
    .propose-box p { margin: 0; font-size: calc(var(--caption-font-size) * .96); line-height: 1.55; }
    .propose-box footer { margin-top: 7px; font-size: 10px; color: #0043ce; line-height: 1.5; }
    .propose-box.offline { border-color: #8d8d8d; background: #f4f4f4; }

    .conflict-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--cds-border-subtle, #e0e0e0); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .conflict-cell { background: var(--cds-layer, #fff); padding: 10px 11px; min-width: 0; }
    .conflict-cell h4 { margin: 0 0 4px; font-size: 10px; letter-spacing: .03em; }
    .conflict-cell.current h4 { color: #198038; }
    .conflict-cell.incoming h4 { color: #a2191f; }
    .conflict-cell p { margin: 0 0 8px; font-size: calc(var(--caption-font-size) * .86); line-height: 1.55; }
    .conflict-cell small { display: block; color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.5; margin-bottom: 8px; }
    .diff-line { font-size: calc(var(--caption-font-size) * .9); line-height: 1.7; padding: 6px 8px; background: #f4f4f4; white-space: pre-wrap; word-break: break-all; }
    .diff-add { background: #defbe6; color: #198038; }
    .diff-remove { background: #fff1f1; color: #a2191f; text-decoration: line-through; }

    .revision-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; padding-top: 2px; }
    .revision-form-grid { display: grid; grid-template-columns: minmax(130px, .5fr) 1fr; gap: 12px; align-items: end; }
    .revision-history { display: flex; flex-direction: column; gap: 8px; }
    .history-item { border: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer, #fff); }
    .history-head { width: 100%; border: 0; background: transparent; color: inherit; text-align: left; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 11px; cursor: pointer; font-size: 11px; }
    .history-head:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .history-head time { color: var(--cds-text-secondary, #525252); font: 500 10px/1.4 "IBM Plex Mono", monospace; }
    .history-body { padding: 0 11px 11px; display: flex; flex-direction: column; gap: 7px; }
    .history-body .old, .history-body .next { padding: 7px 9px; font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
    .history-body .old { background: #fff1f1; border-left: 2px solid #fa4d56; color: #750e13; }
    .history-body .next { background: #defbe6; border-left: 2px solid #42be65; color: #0b5d2a; }
    .history-body .reason { font-size: 10px; color: var(--cds-text-secondary, #525252); line-height: 1.5; }
    .history-body .resolve { font-size: 10px; color: #0043ce; line-height: 1.5; }

    button.live-item { width: calc(100% - 20px); display: block; font: inherit; text-align: left; color: inherit; border: 0; cursor: pointer; }
    .live-item { padding: 8px 11px; border-left: 3px solid #42be65; margin: 0 10px 7px; background: var(--cds-layer-02, #f4f4f4); cursor: pointer; }
    .live-item:hover { outline: 1px solid #78a9ff; }
    .live-item.selected { outline: 2px solid #0f62fe; }
    .live-item.review-pending { border-left-color: #f1c21b; }
    .live-item.review-conflict { border-left-color: #fa4d56; }
    .live-item.review-done { border-left-color: #42be65; }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }
    .live-item p { margin: 5px 0 0; font-size: var(--caption-font-size); line-height: 1.45; }
    .live-item small { display: block; margin-top: 4px; color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .live-item-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }

    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; width: 380px; display: flex; flex-direction: column; gap: 8px; }
    cds-toast-notification { box-shadow: 0 8px 22px rgba(0,0,0,.18); }

    @media (max-width: 1280px) {
      .workspace { grid-template-columns: minmax(340px, .85fr) minmax(410px, 1fr) minmax(330px, .85fr); }
      .status-strip { grid-template-columns: 1.3fr repeat(5, minmax(82px, .5fr)) auto; }
      .font-controls { display: none; }
    }

    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr auto; }
      .connection-pill { grid-row: 2; grid-column: 1 / -1; justify-self: stretch; min-width: 0; }
      .workspace { grid-template-columns: 1fr; overflow: visible; }
      .column { min-height: 520px; }
      .shell { display: block; }
      .status-strip { grid-template-columns: repeat(3, 1fr); }
      .status-cell.hero { grid-column: 1 / -1; }
    }
  `;

  @state() private model: DeskModel = this.loadModel();
  @state() private dark = localStorage.getItem(`${STORAGE_KEY}-theme`) === 'dark';
  @state() private toasts: ToastMessage[] = [];
  @state() private ruleSource = '';
  @state() private ruleReplacement = '';
  @state() private ruleSpeaker = '';
  @state() private filter: 'active' | 'all' | 'attention' = 'active';
  @state() private showRuleForm = false;
  @state() private revisionText = this.model.segments.find((item) => item.id === this.model.selectedId)?.corrected ?? '';
  @state() private revisionSpeaker = this.model.segments.find((item) => item.id === this.model.selectedId)?.speaker ?? '';
  @state() private revisionReason = '';
  @state() private expandedRevisionId = '';
  @state() private revisionDraftId = this.model.selectedId;
  private past: DeskModel[] = [];
  private future: DeskModel[] = [];
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleShortcut);
    this.ticker = window.setInterval(() => {
      const next = simulateLatency(this.model);
      const changed = JSON.stringify(next.segments) !== JSON.stringify(this.model.segments) || next.connection !== this.model.connection;
      if (!changed) return;
      this.model = next;
      this.persist();
    }, 5_000);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.handleShortcut);
    if (this.ticker) window.clearInterval(this.ticker);
    super.disconnectedCallback();
  }

  protected willUpdate(_changed: Map<string, unknown>): void {
    if (_changed.has('model') && this.revisionDraftId !== this.model.selectedId) {
      this.resetRevisionDraft();
    }
  }

  private resetRevisionDraft(): void {
    const item = this.selected;
    this.revisionDraftId = this.model.selectedId;
    this.revisionText = item?.corrected ?? '';
    this.revisionSpeaker = item?.speaker ?? '';
    this.revisionReason = '';
    this.expandedRevisionId = '';
  }

  private loadModel(): DeskModel {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = migrateModel(JSON.parse(raw) as DeskModel);
        if (parsed.segments?.length) return parsed;
      }
    } catch {
      // 损坏草稿会回退到演示数据。
    }
    return createInitialModel();
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.model, updatedAt: Date.now() }));
  }

  private commit(label: string, update: (current: DeskModel) => DeskModel): void {
    const previous = cloneModel(this.model);
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    if (label) this.pushToast('info', label, '已写入浏览器本地草稿');
  }

  private automatic(next: DeskModel): void {
    this.model = next;
    this.persist();
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.pushToast('info', '没有可撤销的修改', '历史记录为空');
    this.future = [cloneModel(this.model), ...this.future].slice(0, HISTORY_LIMIT);
    this.model = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.model = next;
    this.persist();
  }

  private pushToast(kind: ToastMessage['kind'], title: string, subtitle: string): void {
    const toast = { id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, title, subtitle };
    this.toasts = [toast, ...this.toasts].slice(0, 3);
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== toast.id);
    }, 4_500);
  }

  private get selected(): CaptionSegment | undefined {
    return this.model.segments.find((item) => item.id === this.model.selectedId);
  }

  private get stats() {
    return queueStats(this.model);
  }

  private get pendingSegments(): CaptionSegment[] {
    const items = this.model.segments.filter((item) => {
      if (this.filter === 'active') return item.state === 'pending' || item.state === 'stale' || item.state === 'duplicate';
      if (this.filter === 'attention') return item.state === 'stale' || item.state === 'duplicate';
      return true;
    });
    return [...items].sort((a, b) => a.sequence - b.sequence);
  }

  private reviewCardClass(item: CaptionSegment): string {
    const revision = activeRevision(item);
    if (revision?.status === 'conflict') return 'review-conflict';
    if (item.reviewState === 'pending') return 'review-pending';
    return item.reviewState === 'reviewed' ? 'review-done' : '';
  }

  private updateSelected(patch: Partial<CaptionSegment>, label = ''): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit(label, (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, ...patch, revision: item.revision + 1 } : item),
    }));
  }

  private selectSegment(id: string): void {
    this.model = { ...this.model, selectedId: id };
    this.persist();
  }

  private navigate(direction: number): void {
    const candidates = this.pendingSegments.length ? this.pendingSegments : [...this.model.segments].sort((a, b) => a.sequence - b.sequence);
    const index = candidates.findIndex((item) => item.id === this.model.selectedId);
    const next = candidates[Math.max(0, Math.min(candidates.length - 1, index + direction))];
    if (next) this.selectSegment(next.id);
  }

  private applyTerm(ruleId: string): void {
    const selected = this.selected;
    const rule = this.model.rules.find((item) => item.id === ruleId);
    if (!selected || !rule) return;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (!expression.test(selected.corrected)) {
      this.pushToast('warning', '当前字幕没有该术语', `${rule.source} → ${rule.replacement}`);
      return;
    }
    this.commit('应用术语替换', (current) => ({
      ...current,
      rules: current.rules.map((item) => item.id === rule.id ? { ...item, usageCount: item.usageCount + 1 } : item),
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, corrected: item.corrected.replace(expression, rule.replacement), revision: item.revision + 1 } : item),
    }));
  }

  private applyInlineEdit(transform: (value: string) => string, label: string, cursorShift = 0): void {
    const selected = this.selected;
    if (!selected) return;
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    let value = selected.corrected;
    let cursor = value.length;

    if (textarea) {
      value = `${value.slice(0, textarea.selectionStart)}${transform('')}${value.slice(textarea.selectionEnd)}`;
      cursor = textarea.selectionStart + transform('').length + cursorShift;
    } else {
      value = transform(value);
    }

    this.updateSelected({ corrected: value }, label);
    this.updateComplete.then(() => {
      const nextTextarea = this.renderRoot.querySelector('cds-textarea')?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
      if (nextTextarea && textarea) {
        nextTextarea.focus();
        nextTextarea.setSelectionRange(cursor, cursor);
      }
    });
  }

  private insertPunctuation(mark: string): void {
    this.applyInlineEdit(() => mark, `插入${mark}`);
  }

  private wrapSelection(open: string, close: string): void {
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    const selected = this.selected;
    if (!textarea || !selected) return;
    const selectedText = selected.corrected.slice(textarea.selectionStart, textarea.selectionEnd) || '重点';
    const value = `${selected.corrected.slice(0, textarea.selectionStart)}${open}${selectedText}${close}${selected.corrected.slice(textarea.selectionEnd)}`;
    this.updateSelected({ corrected: value }, '添加强调标点');
  }

  private normalizeCurrentNumbers(): void {
    const selected = this.selected;
    if (!selected) return;
    const normalized = normalizeNumbers(selected.corrected);
    if (normalized === selected.corrected) {
      this.pushToast('info', '没有需要规范化的数字', '已检查全角数字和中文数字');
      return;
    }
    this.updateSelected({ corrected: normalized, numberHints: normalized }, '规范化数字');
  }

  private confirmSelected(): void {
    const selected = this.selected;
    if (!selected) {
      this.pushToast('warning', '没有可确认的片段', '请先从待确认区选择字幕');
      return;
    }
    const { text, used } = applyRules(selected.corrected, this.model);
    const offline = this.model.connection === 'offline';
    const nextOrder = this.pendingSegments.filter((item) => item.id !== selected.id);
    this.commit('确认并送入直播区', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? {
        ...item,
        corrected: text,
        state: 'confirmed',
        source: offline ? 'offline' : item.source,
        confirmedAt: Date.now(),
        staleReason: item.state === 'stale' ? item.staleReason : undefined,
        tags: used.length ? [...new Set([...item.tags, '术语已应用'])] : item.tags,
        revision: item.revision + 1,
      } : item),
      rules: current.rules.map((rule) => used.includes(rule.id) ? { ...rule, usageCount: rule.usageCount + 1 } : rule),
      selectedId: nextOrder[0]?.id ?? selected.id,
    }));
    this.pushToast(offline ? 'warning' : 'success', offline ? '已加入离线发件箱' : '字幕已进入直播区', offline ? '恢复连接后将按时间顺序合并' : `第 ${selected.sequence} 段已确认`);
  }

  private ignoreSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    const next = this.pendingSegments.find((item) => item.id !== selected.id);
    this.commit('忽略问题片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'ignored', staleReason: '已人工忽略' } : item),
      selectedId: next?.id ?? selected.id,
    }));
  }

  private recoverDuplicate(): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit('保留重复片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'pending', duplicateOf: undefined, staleReason: '重复提示已由校对员确认保留' } : item),
    }));
  }

  private submitRevision(): void {
    const selected = this.selected;
    if (!selected || selected.state !== 'confirmed') return;
    const text = this.revisionText.trim();
    const reason = this.revisionReason.trim();
    if (!reason) {
      this.pushToast('warning', '请填写回修原因', '播出回修必须记录原因，便于复核与回看');
      return;
    }
    if (!text) {
      this.pushToast('warning', '回修内容不能为空', '请填写修正后的字幕文本');
      return;
    }
    if (text === selected.corrected && this.revisionSpeaker === selected.speaker) {
      this.pushToast('info', '内容与当前播出版本一致', '若仅需确认无误，可直接标记为“已复查”');
      return;
    }
    if (activeRevision(selected)) {
      this.pushToast('warning', '该段已有待复核回修', '请等复核完成后再提交新的回修');
      return;
    }
    const offline = this.model.connection === 'offline';
    this.commit('播出回修已提交', (current) => ({
      ...current,
      segments: submitSegmentRevision(current.segments, selected.id, { reason, speaker: this.revisionSpeaker, text }, offline),
    }));
    this.resetRevisionDraft();
    this.pushToast('warning', offline ? '回修暂存离线发件箱' : '该段进入待复核', offline
      ? '原字幕继续播出，恢复连接后将检查是否与已复查版本冲突'
      : '复核完成前原字幕继续播出，直播区可看到“待复核”标记');
  }

  private approveRevision(revisionId: string): void {
    const exists = this.model.segments.some((item) => item.reviewHistory.some((rev) => rev.id === revisionId));
    if (!exists) return;
    this.commit('复核通过，直播内容已更新', (current) => ({
      ...current,
      segments: resolveSegmentRevision(current.segments, revisionId, 'approved'),
    }));
  }

  private rejectRevision(revisionId: string): void {
    const exists = this.model.segments.some((item) => item.reviewHistory.some((rev) => rev.id === revisionId));
    if (!exists) return;
    this.commit('复核驳回，原字幕继续播出', (current) => ({
      ...current,
      segments: resolveSegmentRevision(current.segments, revisionId, 'rejected'),
    }));
  }

  private chooseConflictVersion(revisionId: string, choice: ConflictChoice): void {
    const exists = this.model.segments.some((item) => item.reviewHistory.some((rev) => rev.id === revisionId));
    if (!exists) return;
    this.commit(choice === 'incoming' ? '已采用晚到回修版本' : '已保留已复查版本', (current) => ({
      ...current,
      segments: resolveRevisionConflict(current.segments, revisionId, choice),
    }));
  }

  private markReviewed(): void {
    const selected = this.selected;
    if (!selected || selected.state !== 'confirmed') return;
    this.commit('该段已复查，无需修改', (current) => ({
      ...current,
      segments: markSegmentReviewed(current.segments, selected.id),
    }));
  }

  private primaryActionForSelected(): void {
    const selected = this.selected;
    if (!selected) {
      this.confirmSelected();
      return;
    }
    if (selected.state !== 'confirmed') {
      this.confirmSelected();
      return;
    }
    const revision = activeRevision(selected);
    if (revision?.status === 'pending') this.approveRevision(revision.id);
    else if (!revision) this.submitRevision();
    // 冲突状态下 ⌘/Ctrl+Enter 不自动裁决，必须在并排差异中明确选择。
  }

  private setConnection(connection: ConnectionState): void {
    this.commit(connection === 'offline' ? '切换到离线校正' : connection === 'degraded' ? '模拟延迟波动' : '连接已恢复', (current) => ({
      ...current,
      connection,
      simulatedDelay: connection === 'connected' ? 0.8 : connection === 'degraded' ? 4.6 : current.simulatedDelay,
    }));
  }

  private mergeOffline(): void {
    const merged = mergeConfirmedSegments(this.model);
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = merged;
    this.persist();
    const outboxCount = this.model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed').length;
    const conflictCount = this.stats.revisionConflict;
    this.pushToast('success', '离线队列已合并', `${outboxCount} 个片段仍标记为离线来源，过期修改会继续显示提示`);
    if (conflictCount > 0) {
      this.pushToast('error', `${conflictCount} 段离线回修与已复查版本冲突`, '已并排显示差异，请校对员选择保留版本，晚到版本不会直接覆盖');
    }
  }

  private addRuleFromSelection(): void {
    const selected = this.selected;
    if (!selected) return;
    this.ruleSource = selected.corrected.length > 24 ? selected.corrected.slice(0, 24) : selected.corrected;
    this.ruleReplacement = selected.corrected;
    this.ruleSpeaker = selected.speaker;
    this.showRuleForm = true;
  }

  private addRule(): void {
    const source = this.ruleSource.trim();
    const replacement = this.ruleReplacement.trim();
    if (!source || !replacement) {
      this.pushToast('warning', '规则不完整', '原文和替换文本均不能为空');
      return;
    }
    this.commit('新增术语快捷规则', (current) => ({
      ...current,
      rules: [{
        id: `term-${Date.now().toString(36)}`,
        source,
        replacement,
        speaker: this.ruleSpeaker,
        enabled: true,
        caseSensitive: false,
        usageCount: 0,
        createdAt: Date.now(),
      }, ...current.rules],
    }));
    this.ruleSource = '';
    this.ruleReplacement = '';
    this.ruleSpeaker = '';
    this.showRuleForm = false;
  }

  private deleteRule(id: string): void {
    this.commit('删除术语规则', (current) => ({ ...current, rules: current.rules.filter((item) => item.id !== id) }));
  }

  private exportSrt(): void {
    const content = toSrt(this.model);
    if (!content) {
      this.pushToast('warning', '暂无已确认字幕', '先确认至少一个片段再导出');
      return;
    }
    const blob = new Blob([content], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.model.eventName.replace(/[^\p{L}\p{N}-]+/gu, '-')}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.pushToast('success', 'SRT 已导出', `${toSrt(this.model).split('\n\n').length} 段字幕`);
  }

  private adjustFont(delta: number): void {
    const fontSize = Math.max(14, Math.min(28, this.model.fontSize + delta));
    this.automatic({ ...this.model, fontSize });
  }

  private toggleTheme(): void {
    this.dark = !this.dark;
    localStorage.setItem(`${STORAGE_KEY}-theme`, this.dark ? 'dark' : 'light');
  }

  private handleShortcut = (event: KeyboardEvent): void => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key === 'Enter') {
      event.preventDefault();
      this.primaryActionForSelected();
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'j') {
      event.preventDefault();
      this.navigate(1);
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.navigate(-1);
      return;
    }
    const punctuation: Record<string, string> = { '1': '，', '2': '。', '3': '？', '4': '！' };
    if (modifier && punctuation[event.key]) {
      event.preventDefault();
      this.insertPunctuation(punctuation[event.key]);
    }
  };

  private renderPendingList() {
    const segments = this.pendingSegments;
    if (!segments.length) {
      return html`<div class="empty"><strong>待确认区已清空</strong><p>新的实时片段到达时会自动进入这里。</p></div>`;
    }
    return html`
      <div class="segment-list">
        ${segments.map((item) => html`
          <button class="segment-card ${item.id === this.model.selectedId ? 'selected' : ''} ${item.state} ${item.state === 'confirmed' ? this.reviewCardClass(item) : ''}" @click=${() => this.selectSegment(item.id)}>
            <div class="segment-meta">
              <span>${formatClock(item.startTime)} · #${String(item.sequence).padStart(3, '0')}</span>
              ${item.state === 'confirmed'
                ? html`<span class="review-badge ${activeRevision(item)?.status === 'conflict' ? 'conflict' : item.reviewState}">${activeRevision(item)?.status === 'conflict' ? '版本冲突' : reviewStateLabel(item.reviewState)}</span>`
                : html`<span class="segment-state ${item.state}">${stateLabel(item.state)}</span>`}
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span>${item.speaker}</span>
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
              ${item.reviewHistory.length ? html`<span>· <b>回修 ${item.reviewHistory.length} 次</b></span>` : nothing}
            </div>
            ${item.state === 'stale' && item.staleReason ? html`<div class="issue-note">${item.staleReason}。确认前请核对直播上下文。</div>` : nothing}
            ${item.state === 'duplicate' ? html`<div class="issue-note duplicate-note">${item.staleReason || '检测到重复片段'}，请保留或忽略。</div>` : nothing}
          </button>
        `)}
      </div>
    `;
  }

  private renderEditor() {
    const item = this.selected;
    if (!item) {
      return html`<div class="empty"><strong>选择一条字幕</strong><p>待确认片段在这里校对；已送直播的片段可发起播出回修。可使用 Alt+J / Alt+K 切换。</p></div>`;
    }
    if (item.state === 'confirmed') return this.renderRevisionEditor(item);
    const applicableRules = this.model.rules.filter((rule) => rule.enabled && (!rule.speaker || rule.speaker === item.speaker));
    return html`
      <div class="editor-scroll">
        <div class="editor-card">
          <div class="editor-top">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">实时片段 #${String(item.sequence).padStart(3, '0')} · 到达于 ${formatAge(item.receivedAt)}</p>
            </div>
            <div class="editor-status">
              <cds-tag type=${item.state === 'stale' ? 'warm-gray' : item.state === 'duplicate' ? 'purple' : 'blue'} size="sm">${stateLabel(item.state)}</cds-tag>
              <cds-tag type="outline" size="sm">修改 ${item.revision} 次</cds-tag>
            </div>
          </div>
          <div class="editor-form">
            ${item.state === 'duplicate' ? html`
              <cds-inline-notification kind="warning" low-contrast title="重复片段提示" subtitle=${item.staleReason || '与已确认片段高度相似'}>
                <cds-button slot="action" size="sm" @click=${this.recoverDuplicate}>保留并继续校对</cds-button>
              </cds-inline-notification>
            ` : nothing}
            ${item.state === 'stale' ? html`
              <cds-inline-notification kind="warning" low-contrast title="过期修改" subtitle=${`${item.staleReason || '该片段已超过 90 秒未确认'}。请结合上下文确认，或忽略以避免污染直播区。`}></cds-inline-notification>
            ` : nothing}
            <div class="form-grid">
              <cds-select label-text="发言人" value=${item.speaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => this.updateSelected({ speaker: event.detail.value }, '修改发言人')}>
                ${['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'].map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
              </cds-select>
              <cds-number-input class="number-input" label="延迟（秒）" .value=${this.model.simulatedDelay} step="0.1" min="0" max="9" @input=${(event: Event) => this.automatic({ ...this.model, simulatedDelay: Number((event.currentTarget as any).value) })}></cds-number-input>
            </div>
            <cds-textarea
              class="caption-input"
              label-text="校对后的字幕文本"
              helper-text="Ctrl/⌘ + 1–4 快速插入标点；术语规则将从左到右自动应用"
              .value=${item.corrected}
              @input=${(event: Event) => this.updateSelected({ corrected: (event.currentTarget as any).value }, '')}
            ></cds-textarea>
            <div class="edit-toolbar">
              <span>快速标点</span>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('，')}>，逗号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('。')}>。句号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('？')}>？问号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('…')}>…省略</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.wrapSelection('（', '）')}>（）括注</cds-button>
              <cds-button kind="secondary" size="sm" @click=${this.normalizeCurrentNumbers}>规范化数字</cds-button>
            </div>
            <div class="rule-suggestions">
              <small>术语快捷替换</small>
              ${applicableRules.length ? applicableRules.map((rule) => html`
                <cds-button kind="tertiary" size="sm" @click=${() => this.applyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
              `) : html`<small>当前发言人的规则为空</small>`}
              <cds-button kind="ghost" size="sm" @click=${this.addRuleFromSelection}>＋ 从当前文本新建</cds-button>
            </div>
          </div>
          <div class="confirm-bar">
            <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 确认并进入直播区 · <kbd>Alt J/K</kbd> 切换片段</div>
            <div>
              <cds-button kind="danger--tertiary" size="sm" @click=${this.ignoreSelected}>忽略片段</cds-button>
              <cds-button kind="primary" @click=${this.confirmSelected}>确认并送入直播区</cds-button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderDiffParts(current: string, incoming: string) {
    return html`<div class="diff-line">${diffText(current, incoming).map((part) => part.type === 'same'
      ? part.value
      : html`<span class=${part.type === 'add' ? 'diff-add' : 'diff-remove'}>${part.value}</span>`)}</div>`;
  }

  private renderRevisionEditor(item: CaptionSegment) {
    const revision = activeRevision(item);
    const isConflict = revision?.status === 'conflict';
    const reviewClass = isConflict ? 'review-conflict' : item.reviewState === 'reviewed' ? 'review-done' : item.reviewState === 'pending' ? 'review-pending' : '';
    const banner = isConflict
      ? html`<strong>版本冲突待裁决</strong><span>离线期间的晚到回修与已复查版本不一致，系统未做覆盖。请在下方并排对比后选择保留版本。</span>`
      : revision
        ? html`<strong>待复核 · 原字幕继续播出</strong><span>回修提交于 ${formatAge(revision.createdAt)}，复核完成前直播区仍显示原内容，并带“待复核”标记。</span>`
        : item.reviewState === 'reviewed'
          ? html`<strong>该段已复查</strong><span>${item.reviewedAt ? `复查于 ${formatAge(item.reviewedAt)}。` : ''}如播出中又发现错字，可再次发起回修。</span>`
          : html`<strong>该段尚未复查</strong><span>发现播出错字可直接回修；确认无误可标记为“已复查”。复核前原字幕不会被替换。</span>`;

    return html`
      <div class="revision-scroll">
        <div class="revision-card">
          <div class="revision-card-head">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">直播片段 #${String(item.sequence).padStart(3, '0')} · ${item.confirmedAt ? `确认于 ${formatAge(item.confirmedAt)}` : ''}</p>
            </div>
            <div class="review-badges">
              <span class="review-badge ${isConflict ? 'conflict' : item.reviewState}">${isConflict ? '版本冲突待裁决' : reviewStateLabel(item.reviewState)}</span>
              ${item.reviewHistory.length ? html`<span class="review-badge unreviewed">回修 ${item.reviewHistory.length} 次</span>` : nothing}
            </div>
          </div>
          <div class="revision-card-body">
            <div class="revision-banner ${revision ? (isConflict ? 'review-conflict' : 'review-pending') : reviewClass}">${banner}</div>

            <div class="live-box ${revision ? 'live-pending' : ''}">
              <h4>${revision ? '当前送播内容（复核前保持可见）' : '当前送播内容'}</h4>
              <p>[${item.speaker}] ${item.corrected}</p>
              <footer>来源：${item.source === 'offline' ? '离线恢复合并' : '直播确认'}${item.source === 'offline' && item.staleReason ? ` · ${item.staleReason}` : ''}</footer>
            </div>

            ${isConflict && revision ? html`
              <cds-inline-notification kind="error" low-contrast title="离线回修与已复查版本冲突" subtitle="晚到版本不能直接覆盖已复查内容，请选择最终播出版本。"></cds-inline-notification>
              <div class="conflict-grid">
                <div class="conflict-cell current">
                  <h4>当前已复查版本</h4>
                  <p>[${item.speaker}] ${item.corrected}</p>
                  ${this.renderDiffParts(item.corrected, revision.nextText)}
                  <small><span class="diff-remove">删除线</span> 是晚到回修要删掉的字，<span class="diff-add">绿色</span> 是晚到回修要补的字。</small>
                  <cds-button kind="secondary" size="sm" @click=${() => this.chooseConflictVersion(revision.id, 'current')}>保留已复查版本</cds-button>
                </div>
                <div class="conflict-cell incoming">
                  <h4>离线晚到回修版本</h4>
                  <p>[${revision.nextSpeaker}] ${revision.nextText}</p>
                  ${this.renderDiffParts(revision.nextText, item.corrected)}
                  <small><span class="diff-remove">删除线</span> 是已复查版本中没有的字，<span class="diff-add">绿色</span> 是已复查版本多出的字。</small>
                  <small>回修原因：${revision.reason} · 提交于 ${formatAge(revision.createdAt)}（离线）</small>
                  <cds-button kind="primary" size="sm" @click=${() => this.chooseConflictVersion(revision.id, 'incoming')}>采用晚到回修</cds-button>
                </div>
              </div>
            ` : nothing}

            ${revision && !isConflict ? html`
              <div class="propose-box ${revision.createdOffline ? 'offline' : ''}">
                <h4>${revision.createdOffline ? '离线暂存的回修版本' : '待复核的回修版本'}</h4>
                <p>[${revision.nextSpeaker}] ${revision.nextText}</p>
                <footer>回修原因：${revision.reason}<br/>提交于 ${formatStamp(revision.createdAt)}${revision.createdOffline ? ' · 离线发件箱' : ''}</footer>
              </div>
              <div class="revision-actions">
                <cds-button kind="danger--tertiary" size="sm" @click=${() => this.rejectRevision(revision.id)}>驳回，保留原字幕</cds-button>
                <cds-button kind="primary" size="sm" @click=${() => this.approveRevision(revision.id)}>复核通过并更新直播</cds-button>
              </div>
            ` : nothing}

            ${!revision ? html`
              <div class="revision-form-grid">
                <cds-select label-text="回修后发言人" value=${this.revisionSpeaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => { this.revisionSpeaker = event.detail.value; }}>
                  ${['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'].map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
                </cds-select>
                <div></div>
              </div>
              <cds-textarea
                class="caption-input"
                label-text="回修后的字幕文本"
                helper-text="在送播内容基础上修改；原字幕在复核通过前继续播出"
                .value=${this.revisionText}
                @input=${(event: Event) => { this.revisionText = (event.currentTarget as any).value; }}
              ></cds-textarea>
              <cds-text-input
                label-text="回修原因（必填）"
                placeholder="例如：观众反馈错字 / 专有名词写法更正 / 数字单位错误"
                .value=${this.revisionReason}
                @input=${(event: Event) => { this.revisionReason = (event.currentTarget as any).value; }}
              ></cds-text-input>
              <div class="revision-actions">
                <cds-button kind="ghost" size="sm" @click=${this.markReviewed}>无需修改，标记已复查</cds-button>
                <cds-button kind="primary" size="sm" @click=${this.submitRevision}>${this.model.connection === 'offline' ? '提交并暂存离线发件箱' : '提交回修（原字幕继续播出）'}</cds-button>
              </div>
            ` : nothing}
          </div>
        </div>

        ${this.renderRevisionHistory(item)}
      </div>
    `;
  }

  private renderRevisionHistory(item: CaptionSegment) {
    const history = item.reviewHistory;
    if (!history.length) return nothing;
    return html`
      <div class="revision-card">
        <div class="inspector-section-head" style="border-bottom:1px solid var(--cds-border-subtle,#e0e0e0);">
          <h3 style="margin:0;font-size:12px;">回修历史（${history.length}）</h3>
          <span>所有版本均可回看，选择结果长期保留</span>
        </div>
        <div class="revision-card-body">
          <div class="revision-history">
            ${history.map((rev) => {
              const open = this.expandedRevisionId === rev.id;
              return html`
                <div class="history-item">
                  <button class="history-head" @click=${() => { this.expandedRevisionId = open ? '' : rev.id; }}>
                    <span>第 ${rev.revisionNo} 次回修 · ${revisionStatusLabel(rev.status)}${rev.createdOffline ? ' · 离线' : ''}</span>
                    <time>${formatStamp(rev.createdAt)}</time>
                  </button>
                  ${open ? html`
                    <div class="history-body">
                      <div class="reason">原因：${rev.reason}</div>
                      <div class="old">上一版（送播中）：[${rev.previousSpeaker}] ${rev.previousText}</div>
                      <div class="next">回修版本：[${rev.nextSpeaker}] ${rev.nextText}</div>
                      ${rev.status !== 'pending' && rev.status !== 'conflict' ? html`
                        <div class="resolve">
                          ${rev.status === 'approved' ? '复核通过' : '复核驳回'} · ${rev.resolvedAt ? formatStamp(rev.resolvedAt) : ''}
                          ${rev.resolvedChoice ? ` · 选择：${rev.resolvedChoice === 'incoming' ? '采用回修版本' : '保留原版本'}` : ''}
                          ${rev.resolveNote ? html`<br/>${rev.resolveNote}` : ''}
                        </div>
                      ` : html`<div class="resolve">${rev.status === 'conflict' ? '等待校对员并排裁决' : '等待复核'}</div>`}
                    </div>
                  ` : nothing}
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }

  private renderInspector() {
    const item = this.selected;
    const confirmed = this.model.segments.filter((segment) => segment.state === 'confirmed').sort((a, b) => a.startTime - b.startTime);
    return html`
      <div class="inspector">
        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>术语快捷规则</h3>
            <span>${this.model.rules.filter((rule) => rule.enabled).length} 条启用</span>
          </div>
          <div class="rule-list">
            ${this.model.rules.map((rule) => html`
              <div class="rule-item">
                <div>
                  <strong>${rule.source} → ${rule.replacement}</strong>
                  <p>${rule.speaker || '全部发言人'} · 已使用 ${rule.usageCount} 次</p>
                </div>
                <div class="rule-item-actions">
                  <cds-button kind="ghost" size="sm" @click=${() => this.applyTerm(rule.id)}>应用</cds-button>
                  <cds-button kind="danger--ghost" size="xs" @click=${() => this.deleteRule(rule.id)}>删除</cds-button>
                </div>
              </div>
            `)}
          </div>
          ${this.showRuleForm ? html`
            <div class="rule-form">
              <cds-text-input label-text="原文" .value=${this.ruleSource} @input=${(event: Event) => { this.ruleSource = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input label-text="替换为" .value=${this.ruleReplacement} @input=${(event: Event) => { this.ruleReplacement = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input class="full" label-text="仅对某发言人应用（可空）" .value=${this.ruleSpeaker} @input=${(event: Event) => { this.ruleSpeaker = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-button class="full" size="sm" kind="primary" @click=${this.addRule}>保存规则</cds-button>
            </div>
          ` : html`
            <div style="padding: 10px;"><cds-button kind="tertiary" size="sm" @click=${() => { this.showRuleForm = true; }}>＋ 新增术语规则</cds-button></div>
          `}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>直播区时间线</h3>
            <span>${confirmed.length} 段 · 待复核 ${this.stats.reviewPending}${this.stats.revisionConflict ? ` · 冲突 ${this.stats.revisionConflict}` : ''}</span>
          </div>
          <div class="live-timeline">
            ${confirmed.length ? confirmed.slice(-12).reverse().map((segment) => {
              const revision = activeRevision(segment);
              const isConflict = revision?.status === 'conflict';
              const rowClass = isConflict ? 'review-conflict' : segment.reviewState === 'pending' ? 'review-pending' : segment.reviewState === 'reviewed' ? 'review-done' : '';
              return html`
              <button type="button" class="live-item ${rowClass} ${segment.id === this.model.selectedId ? 'selected' : ''}" @click=${() => this.selectSegment(segment.id)}>
                <span class="live-item-row">
                  <time>${formatClock(segment.startTime)} · ${segment.speaker}</time>
                  <span class="review-badge ${isConflict ? 'conflict' : segment.reviewState}">${isConflict ? '版本冲突' : reviewStateLabel(segment.reviewState)}</span>
                </span>
                <p>${segment.corrected}</p>
                ${revision ? html`<small>${isConflict ? '离线晚到回修与已复查版本冲突，点击并排裁决' : `回修待复核，原字幕继续播出 · 原因：${revision.reason}`}</small>` : nothing}
                ${segment.source === 'offline' ? html`<small>离线来源 · 恢复后合并</small>` : nothing}
                ${!revision && segment.reviewHistory.length ? html`<small>已完成 ${segment.reviewHistory.length} 次回修 · 点击回看历史版本</small>` : nothing}
              </button>`;
            }) : html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>`}
          </div>
          ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按时间顺序提交，不会覆盖已确认内容。</div>` : nothing}
          ${this.stats.reviewPending > 0 ? html`<div class="revision-banner ${this.stats.revisionConflict ? 'review-conflict' : 'review-pending'}"><strong>${this.stats.revisionConflict ? `${this.stats.revisionConflict} 段版本冲突待裁决` : `${this.stats.reviewPending} 段待复核`}</strong><span>${this.stats.revisionConflict ? '晚到离线回修不会覆盖已复查版本，需校对员并排选择。' : '复核完成前原字幕继续可见，点击直播区片段可直接复核。'}</span></div>` : nothing}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>当前片段上下文</h3>
            <span>${item ? `#${item.sequence}` : '未选择'}</span>
          </div>
          <div style="padding: 12px; line-height: 1.5; font-size: 11px;">
            ${item ? html`
              <div><strong>原始字幕：</strong>${item.original}</div>
              <div style="margin-top: 8px;"><strong>${item.state === 'confirmed' ? '当前送播：' : '修改前校正：'}</strong>${item.corrected}</div>
              ${item.state === 'confirmed' ? html`
                <div style="margin-top: 8px;"><strong>复查状态：</strong>${reviewStateLabel(item.reviewState)}${activeRevision(item) ? `（${revisionStatusLabel(activeRevision(item)!.status)}）` : ''}</div>
                <div style="margin-top: 4px;">已提交 ${item.reviewHistory.length} 次播出回修${item.reviewedAt ? ` · 最近复查 ${formatAge(item.reviewedAt)}` : ''}</div>
              ` : html`<div style="margin-top: 8px; color: var(--cds-text-secondary);">${item.tags.length ? `标签：${item.tags.join('、')}` : '尚未应用术语标签'}</div>`}
            ` : html`<span>请选择片段以查看上下文。</span>`}
          </div>
        </section>
      </div>
    `;
  }

  render() {
    const stats = this.stats;
    const backlogRatio = Math.min(100, stats.backlog * 8);
    return html`
      <div class="shell ${this.dark ? 'dark' : ''}" style=${`--caption-font-size: ${this.model.fontSize}px`}>
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">CC</div>
            <div class="brand-copy">
              <strong>LiveCaption Desk</strong>
              <span>${this.model.eventName} · ${this.model.eventDate}</span>
            </div>
          </div>
          <div class="connection-pill ${this.model.connection}">
            <span class="connection-dot"></span>
            <div class="connection-copy">
              <strong>${connectionLabel(this.model.connection)} · ${this.model.simulatedDelay.toFixed(1)} 秒延迟</strong>
              <small>${this.model.connection === 'offline' ? '仍可编辑，确认内容进入离线发件箱' : `待确认队列 ${stats.pending} 段 · 最近自动保存 ${new Date(this.model.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</small>
            </div>
          </div>
          <div class="header-actions">
            <cds-button kind="ghost" size="sm" @click=${this.toggleTheme}>${this.dark ? '浅色界面' : '深色值守'}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.undo}>撤销</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.redo}>重做</cds-button>
            <cds-button kind="primary" size="sm" @click=${this.exportSrt}>导出 SRT</cds-button>
          </div>
        </header>

        <section class="status-strip">
          <div class="status-cell hero">
            <strong>${this.model.connection === 'offline'
              ? '离线校正中，确认与回修暂存发件箱'
              : stats.revisionConflict > 0
                ? '离线回修与已复查版本冲突，等待并排裁决'
                : stats.reviewPending > 0
                  ? `${stats.reviewPending} 段回修待复核，原字幕继续播出`
                  : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 离线待合并 ${stats.offline} · 待复核 ${stats.reviewPending} · 冲突 ${stats.revisionConflict}</span>
            <div class="queue-track"><span style=${`width:${backlogRatio}%`}></span></div>
          </div>
          <div class="status-cell"><strong>${stats.pending}</strong><span>待确认片段</span></div>
          <div class="status-cell warning"><strong>${stats.oldestWaitSeconds}s</strong><span>最长等待时间</span></div>
          <div class="status-cell ${stats.stale + stats.duplicate + stats.revisionConflict > 0 ? 'danger' : ''}"><strong>${stats.stale + stats.duplicate + stats.revisionConflict}</strong><span>${stats.revisionConflict > 0 ? '异常/版本冲突' : '需要明确处理'}</span></div>
          <div class="status-cell ${stats.reviewPending > 0 ? 'warning' : ''}"><strong>${stats.reviewPending}</strong><span>回修待复核</span></div>
          <div class="status-cell"><strong>${this.model.simulatedDelay.toFixed(1)}s</strong><span>当前流延迟</span></div>
          <div class="font-controls">
            <label>字幕字号</label>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(-1)}>A−</cds-button>
            <strong>${this.model.fontSize}</strong>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(1)}>A＋</cds-button>
          </div>
        </section>

        <main class="workspace">
          <section class="column">
            <div class="column-head">
              <div>
                <h2>待确认区</h2>
                <p>按收到顺序排列，重复和过期内容不会被静默覆盖</p>
              </div>
              <cds-dropdown value=${this.filter} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.filter = event.detail.item.value as typeof this.filter; }}>
                <cds-dropdown-item value="active">仅需处理</cds-dropdown-item>
                <cds-dropdown-item value="attention">异常优先</cds-dropdown-item>
                <cds-dropdown-item value="all">全部片段</cds-dropdown-item>
              </cds-dropdown>
            </div>
            <div class="column-body">${this.renderPendingList()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>校对编辑台</h2>
                <p>确认前修改待校片段；选中直播片段可发起播出回修并复核</p>
              </div>
              <cds-tag type="green" size="sm">本地草稿</cds-tag>
            </div>
            <div class="column-body" style=${`font-size:${this.model.fontSize}px`}>${this.renderEditor()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>规则与直播区</h2>
                <p>回修复核前原字幕继续可见；离线版本冲突时并排裁决</p>
              </div>
              ${this.model.connection === 'offline'
                ? html`<cds-button kind="primary" size="sm" @click=${this.mergeOffline}>恢复并合并</cds-button>`
                : html`<cds-button kind="danger--tertiary" size="sm" @click=${() => this.setConnection('offline')}>模拟断线</cds-button>`}
            </div>
            <div class="column-body">${this.renderInspector()}</div>
          </section>
        </main>

        <div class="toast-stack">
          ${this.toasts.map((toast) => html`
            <cds-toast-notification
              kind=${toast.kind}
              title=${toast.title}
              subtitle=${toast.subtitle}
              @cds-notification-closed=${() => { this.toasts = this.toasts.filter((item) => item.id !== toast.id); }}
            ></cds-toast-notification>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caption-desk': CaptionDesk;
  }
}
