import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  activeRevision,
  airingVersion,
  applyRules,
  cloneModel,
  createInitialModel,
  diffText,
  mergeConfirmedSegments,
  migrateModel,
  normalizeNumbers,
  queueStats,
  resolveRevisionConflict,
  reviewRevision,
  reviewState,
  simulateRemoteReview,
  submitRevision,
  STORAGE_KEY,
  simulateLatency,
  toSrt,
  type CaptionRevision,
  type CaptionSegment,
  type CaptionVersion,
  type ConnectionState,
  type DeskModel,
  type DiffToken,
  type RevisionStatus,
  type SegmentState,
  type ToastMessage,
  type VersionKind,
} from './model';

const HISTORY_LIMIT = 80;
const SPEAKERS = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'];

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

function revisionStatusLabel(status: RevisionStatus): string {
  return {
    pending: '待复核',
    approved: '复核通过',
    rejected: '复核退回',
    outbox: '离线发件箱',
    conflicted: '差异待选择',
  }[status];
}

function versionKindLabel(kind: VersionKind): string {
  return {
    initial: '原始版本',
    confirm: '送播版本',
    revision: '回修版本',
    resolved: '冲突选用版本',
  }[kind];
}

function reviewStateLabel(segment: CaptionSegment): string {
  return {
    none: '',
    reviewed: '已复查',
    pending: '待复核 · 原字幕可见',
    outbox: '回修暂存离线发件箱',
    conflicted: '差异待选择',
  }[reviewState(segment)];
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
      min-height: 60px; padding: 8px 20px; display: grid; grid-template-columns: 1.5fr repeat(4, minmax(118px, .6fr)) auto;
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
    .live-item { padding: 8px 11px; border-left: 3px solid #42be65; margin: 0 10px 7px; background: var(--cds-layer-02, #f4f4f4); }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }
    .live-item p { margin: 5px 0 0; font-size: var(--caption-font-size); line-height: 1.45; }
    .live-item small { display: block; margin-top: 4px; color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .delivery-status { margin: 0 10px 10px; padding: 9px 10px; background: #edf5ff; border-left: 3px solid #0f62fe; color: #0043ce; font-size: 10px; line-height: 1.45; }
    .delivery-status.revision-outbox { background: #f6f2ff; border-color: #a56eff; color: #491d8b; }
    .conflict-count { color: #da1e28; }
    .conflict-banner { margin: 8px 10px 2px; padding: 9px 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #fff1f1; border-left: 3px solid #da1e28; }
    .conflict-banner strong { color: #da1e28; font-size: 10px; line-height: 1.4; }

    .live-item { cursor: pointer; transition: outline .15s ease; }
    .live-item:hover { outline: 1px solid #78a9ff; }
    .live-item.pending { border-left-color: #f1c21b; }
    .live-item.outbox { border-left-color: #a56eff; }
    .live-item.conflicted { border-left-color: #da1e28; background: color-mix(in srgb, var(--cds-layer-02, #f4f4f4) 88%, #da1e28 12%); }
    .live-item.reviewed { border-left-color: #198038; }
    .live-item-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .live-proposed { margin-top: 5px; padding: 5px 7px; background: color-mix(in srgb, #fff 72%, #f1c21b 28%); border-left: 2px solid #f1c21b; }
    .live-item.conflicted .live-proposed { background: color-mix(in srgb, #fff 70%, #da1e28 30%); border-color: #da1e28; }
    .live-proposed small { color: #684e00; }
    .live-item.conflicted .live-proposed small { color: #821f19; }
    .live-open { display: block; margin-top: 5px; color: #0f62fe !important; }
    .revision-context-line { display: flex; gap: 5px; align-items: baseline; }

    .revision-scroll { display: flex; flex-direction: column; gap: 12px; }
    .airing-box { padding: 11px 12px; background: color-mix(in srgb, var(--cds-layer-02, #f4f4f4) 82%, #42be65 18%); border-left: 3px solid #42be65; }
    .airing-box-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .airing-box-head strong { font-size: 12px; color: #198038; }
    .airing-box-head span { font-size: 10px; color: var(--cds-text-secondary, #525252); }
    .airing-text { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .airing-box small { display: block; margin-top: 6px; color: var(--cds-text-secondary, #525252); font-size: 10px; }

    .revision-card { padding: 12px; border: 1px solid var(--cds-border-subtle, #e0e0e0); border-top: 3px solid #f1c21b; background: var(--cds-layer-02, #f4f4f4); }
    .revision-card.outbox { border-top-color: #a56eff; }
    .revision-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .revision-card-head span { font-size: 10px; color: var(--cds-text-secondary, #525252); }
    .revision-proposed { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .revision-card small { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .revision-reason { margin-top: 9px; padding: 7px 9px; background: var(--cds-layer, #fff); border-left: 2px solid #8d8d8d; font-size: 11px; line-height: 1.5; }
    .revision-actions { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .revision-hint { margin: 8px 0 0; font-size: 10px; color: var(--cds-text-secondary, #525252); line-height: 1.5; }
    .revision-confirm { margin: 0 -14px -14px; }
    .revision-toolbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding-bottom: 4px; }
    .revision-toolbar > span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .reason-input { min-height: 84px; }

    .sim-remote { margin-top: 10px; border-top: 1px dashed var(--cds-border-subtle, #e0e0e0); padding-top: 8px; }
    .sim-remote summary { cursor: pointer; font-size: 10px; color: #6929c4; }
    .sim-remote-body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }

    .diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .diff-col { padding: 11px; border: 1px solid var(--cds-border-subtle, #e0e0e0); min-width: 0; }
    .diff-col.current { border-top: 3px solid #42be65; background: color-mix(in srgb, var(--cds-layer, #fff) 94%, #42be65 6%); }
    .diff-col.late { border-top: 3px solid #da1e28; background: color-mix(in srgb, var(--cds-layer, #fff) 93%, #da1e28 7%); }
    .diff-col-head { display: flex; flex-direction: column; gap: 3px; margin-bottom: 7px; }
    .diff-col-head strong { font-size: 11px; }
    .diff-col-head span { font-size: 9px; color: var(--cds-text-secondary, #525252); }
    .diff-col p { margin: 0; font-size: calc(var(--caption-font-size) * .92); line-height: 1.6; word-break: break-word; }
    .diff-col small { display: block; margin-top: 7px; font-size: 10px; color: var(--cds-text-secondary, #525252); }
    .diff-token { color: inherit; background: transparent; border-radius: 2px; padding: 0 1px; }
    .diff-token.del { background: #ffd7d9; color: #821f19; text-decoration: line-through; }
    .diff-token.ins { background: #d7ffb8; color: #198038; text-decoration: underline; }

    .history-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .history-toggle { width: 100%; border: 0; background: transparent; color: inherit; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; text-align: left; }
    .history-toggle strong { font-size: 12px; }
    .history-toggle span { font-size: 10px; color: #0f62fe; }
    .history-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 1px; border-top: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-border-subtle, #e0e0e0); max-height: 320px; }
    .history-list { overflow: auto; background: var(--cds-background, #f4f4f4); }
    .history-item { display: grid; grid-template-columns: auto auto 1fr; gap: 7px; align-items: center; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer, #fff); padding: 8px 10px; cursor: pointer; color: inherit; }
    .history-item:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .history-item.selected { outline: 1px solid #78a9ff; background: var(--cds-layer-selected, #edf5ff); }
    .history-time { font: 500 9px/1.2 "IBM Plex Mono", monospace; color: var(--cds-text-secondary, #525252); }
    .history-item small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--cds-text-secondary, #525252); }
    .history-detail { padding: 12px; overflow: auto; background: var(--cds-layer, #fff); min-width: 0; }
    .history-detail h4 { margin: 0 0 8px; font-size: 12px; }
    .history-text { margin: 0 0 8px; font-size: calc(var(--caption-font-size) * .92); line-height: 1.55; }
    .history-detail small { font-size: 10px; color: var(--cds-text-secondary, #525252); }

    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; width: 380px; display: flex; flex-direction: column; gap: 8px; }
    cds-toast-notification { box-shadow: 0 8px 22px rgba(0,0,0,.18); }

    @media (max-width: 1280px) {
      .workspace { grid-template-columns: minmax(340px, .85fr) minmax(410px, 1fr) minmax(330px, .85fr); }
      .status-strip { grid-template-columns: 1.4fr repeat(4, minmax(100px, .55fr)); }
      .font-controls { display: none; }
    }

    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr auto; }
      .connection-pill { grid-row: 2; grid-column: 1 / -1; justify-self: stretch; min-width: 0; }
      .workspace { grid-template-columns: 1fr; overflow: visible; }
      .column { min-height: 520px; }
      .shell { display: block; }
      .status-strip { grid-template-columns: repeat(4, 1fr); }
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
  @state() private revisionSpeaker = '';
  @state() private revisionText = '';
  @state() private revisionReason = '';
  @state() private showHistory = false;
  @state() private historyEntryId = '';
  @state() private simText = '';
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

  private updateSelected(patch: Partial<CaptionSegment>, label = ''): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit(label, (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, ...patch, revision: item.revision + 1 } : item),
    }));
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
      segments: current.segments.map((item) => {
        if (item.id !== selected.id) return item;
        const timestamp = Date.now();
        const version: CaptionVersion = { id: `${item.id}-v-${timestamp.toString(36)}`, speaker: item.speaker, corrected: text, createdAt: timestamp, kind: 'confirm' };
        return {
          ...item,
          corrected: text,
          state: 'confirmed',
          source: offline ? 'offline' : item.source,
          confirmedAt: timestamp,
          staleReason: item.state === 'stale' ? item.staleReason : undefined,
          tags: used.length ? [...new Set([...item.tags, '术语已应用'])] : item.tags,
          revision: item.revision + 1,
          airingVersionId: version.id,
          versions: [version],
          revisions: [],
        };
      }),
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
    this.syncRevisionDrafts();
    this.persist();
    const outboxCount = this.model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed').length;
    const conflictCount = queueStats(this.model).conflictedRevisions;
    const pendingRevisions = queueStats(this.model).pendingRevisions;
    if (conflictCount > 0) {
      this.pushToast('warning', '发现离线晚到版本与直播侧复查冲突', `${conflictCount} 段需要并排比对差异后选择，未覆盖任何已复查内容`);
    } else {
      this.pushToast('success', '离线队列已合并', `${outboxCount} 个片段仍标记为离线来源；${pendingRevisions} 条回修进入待复核，过期修改会继续显示提示`);
    }
  }

  /** 回修草稿跟随当前选中片段的播出版本（不直接改动直播内容） */
  private syncRevisionDrafts(): void {
    const item = this.selected;
    const airing = item ? airingVersion(item) : undefined;
    this.revisionSpeaker = airing?.speaker ?? item?.speaker ?? '';
    this.revisionText = airing?.corrected ?? item?.corrected ?? '';
    this.revisionReason = '';
    this.simText = '';
    this.showHistory = false;
    this.historyEntryId = '';
  }

  private selectSegment(id: string): void {
    this.model = { ...this.model, selectedId: id };
    this.persist();
    this.syncRevisionDrafts();
  }

  private submitSelectedRevision(): void {
    const item = this.selected;
    if (!item || item.state !== 'confirmed') return;
    const text = this.revisionText.trim();
    const reason = this.revisionReason.trim();
    if (!reason) {
      this.pushToast('warning', '请填写回修原因', '提交播出回修必须说明修改原因');
      return;
    }
    const airing = airingVersion(item);
    if (!airing) return;
    if (text === airing.corrected && this.revisionSpeaker === airing.speaker) {
      this.pushToast('warning', '回修内容与当前直播字幕一致', '没有需要提交的改动');
      return;
    }
    const offline = this.model.connection === 'offline';
    this.commit(offline ? '回修已暂存离线发件箱' : '回修已提交，等待复核', (current) =>
      submitRevision(current, item.id, { speaker: this.revisionSpeaker, proposedText: text, reason }));
    this.syncRevisionDrafts();
    if (!offline) this.pushToast('info', '该段已标记为待复核', '复核完成前直播区继续显示原字幕');
  }

  private reviewSelectedRevision(revisionId: string, approve: boolean): void {
    const item = this.selected;
    if (!item) return;
    if (this.model.connection === 'offline') {
      this.pushToast('warning', '离线期间不能完成复核', '恢复连接后再进行复核操作');
      return;
    }
    this.commit(approve ? '复核通过，直播字幕已更新' : '复核退回，保留原字幕', (current) =>
      reviewRevision(current, item.id, revisionId, approve));
    this.syncRevisionDrafts();
  }

  private resolveSelectedConflict(revisionId: string, choice: 'late' | 'current'): void {
    const item = this.selected;
    if (!item) return;
    this.commit(choice === 'late' ? '已采用离线晚到版本' : '已保留直播侧复查版本', (current) =>
      resolveRevisionConflict(current, item.id, revisionId, choice));
    this.syncRevisionDrafts();
  }

  private submitSimRemoteReview(revisionId: string): void {
    const item = this.selected;
    if (!item) return;
    const remoteText = this.simText.trim();
    if (!remoteText) {
      this.pushToast('warning', '请填写直播侧复查后的字幕', '用于演示同一片段已被复查的冲突场景');
      return;
    }
    this.commit('已模拟直播侧完成复查', (current) => simulateRemoteReview(current, item.id, revisionId, remoteText));
    this.syncRevisionDrafts();
  }

  private jumpToFirstConflict(): void {
    const target = this.model.segments.find((item) => (item.revisions ?? []).some((revision) => revision.status === 'conflicted'));
    if (target) this.selectSegment(target.id);
  }

  private revisionInsert(mark: string): void {
    const host = this.renderRoot.querySelector('#revision-textarea') as HTMLElement & { value: string } | null;
    const textarea = (host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined) ?? this.renderRoot.querySelector('#revision-textarea') as HTMLTextAreaElement | null;
    if (!textarea) {
      this.revisionText += mark;
      return;
    }
    const start = textarea.selectionStart ?? this.revisionText.length;
    const end = textarea.selectionEnd ?? start;
    this.revisionText = `${this.revisionText.slice(0, start)}${mark}${this.revisionText.slice(end)}`;
    this.updateComplete.then(() => textarea.setSelectionRange(start + mark.length, start + mark.length));
  }

  private revisionNormalizeNumbers(): void {
    const normalized = normalizeNumbers(this.revisionText);
    if (normalized === this.revisionText) {
      this.pushToast('info', '没有需要规范化的数字', '已检查全角数字和中文数字');
      return;
    }
    this.revisionText = normalized;
  }

  private revisionApplyTerm(ruleId: string): void {
    const rule = this.model.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (!expression.test(this.revisionText)) {
      this.pushToast('warning', '当前回修文本没有该术语', `${rule.source} → ${rule.replacement}`);
      return;
    }
    this.revisionText = this.revisionText.replace(expression, rule.replacement);
    this.commit('应用术语替换', (current) => ({
      ...current,
      rules: current.rules.map((item) => item.id === rule.id ? { ...item, usageCount: item.usageCount + 1 } : item),
    }));
  }

  private historyEntries(segment: CaptionSegment): Array<{ id: string; at: number; kind: VersionKind | RevisionStatus; revision?: CaptionRevision; version?: CaptionVersion }> {
    const versionEntries = (segment.versions ?? []).map((version) => ({ id: version.id, at: version.createdAt, kind: version.kind as VersionKind | RevisionStatus, version }));
    const revisionEntries = (segment.revisions ?? []).map((revision) => ({ id: revision.id, at: revision.reviewedAt ?? revision.createdAt, kind: revision.status as VersionKind | RevisionStatus, revision }));
    return [...versionEntries, ...revisionEntries].sort((a, b) => b.at - a.at);
  }

  private renderDiffTokens(tokens: DiffToken[], side: 'from' | 'to') {
    const allow = side === 'from' ? 'del' : 'ins';
    return html`${tokens.filter((token) => token.type === 'equal' || token.type === allow).map((token) => token.type === 'equal'
      ? html`<span class="diff-token equal">${token.value}</span>`
      : html`<mark class="diff-token ${token.type}">${token.value === '' ? '·' : token.value}</mark>`)}`;
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
      if (this.selected?.state === 'confirmed') {
        const active = activeRevision(this.selected);
        if (!active) this.submitSelectedRevision();
      } else {
        this.confirmSelected();
      }
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
      if (this.selected?.state === 'confirmed' && !activeRevision(this.selected)) {
        this.revisionInsert(punctuation[event.key]);
      } else {
        this.insertPunctuation(punctuation[event.key]);
      }
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
          <button class="segment-card ${item.id === this.model.selectedId ? 'selected' : ''} ${item.state}" @click=${() => this.selectSegment(item.id)}>
            <div class="segment-meta">
              <span>${formatClock(item.startTime)} · #${String(item.sequence).padStart(3, '0')}</span>
              <span class="segment-state ${item.state}">${stateLabel(item.state)}</span>
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span>${item.speaker}</span>
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
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
      return html`<div class="empty"><strong>选择一条待确认字幕</strong><p>可以使用 Alt+J / Alt+K 在片段之间移动。</p></div>`;
    }
    if (item.state === 'confirmed') return this.renderRevisionConsole(item);
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

  private renderRevisionConsole(item: CaptionSegment) {
    const active = activeRevision(item);
    const airing = airingVersion(item);
    const state = reviewState(item);
    const stateTagType = state === 'conflicted' ? 'red' : state === 'outbox' ? 'purple' : state === 'pending' ? 'warm-gray' : state === 'reviewed' ? 'green' : 'blue';
    const applicableRules = this.model.rules.filter((rule) => rule.enabled && (!rule.speaker || rule.speaker === this.revisionSpeaker));
    const history = this.historyEntries(item);
    const selectedHistoryEntry = this.historyEntryId ? history.find((entry) => entry.id === this.historyEntryId) : undefined;

    return html`
      <div class="editor-scroll revision-scroll">
        <div class="editor-card">
          <div class="editor-top">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">已送播片段 #${String(item.sequence).padStart(3, '0')} · 播出回修台</p>
            </div>
            <div class="editor-status">
              <cds-tag type=${stateTagType} size="sm">${reviewStateLabel(item) || '直播中'}</cds-tag>
              <cds-tag type="outline" size="sm">${item.versions?.length ?? 1} 个播出版本 · ${item.revisions?.length ?? 0} 次回修</cds-tag>
            </div>
          </div>

          <div class="editor-form">
            <div class="airing-box">
              <div class="airing-box-head">
                <strong>当前直播字幕</strong>
                <span>${state === 'pending' ? '回修待复核，观众仍看到以下原字幕' : state === 'reviewed' ? '该片段已复查' : '复核完成前不会替换'}</span>
              </div>
              <p class="airing-text">${airing?.corrected ?? item.corrected}</p>
              <small>[${airing?.speaker ?? item.speaker}] · ${versionKindLabel(airing?.kind ?? 'confirm')} · ${airing ? formatAge(airing.createdAt) : ''}</small>
            </div>

            ${active?.status === 'conflicted' ? (() => {
              const current = airing;
              const tokens = diffText(current?.corrected ?? '', active.proposedText);
              return html`
                <cds-inline-notification kind="error" low-contrast title="离线晚到版本与已复查内容冲突" subtitle="同一片段在你离线期间已被复查，晚到版本没有覆盖直播。请并排比对差异后选择，选择结果会长期保存。"></cds-inline-notification>
                <div class="diff-grid">
                  <div class="diff-col current">
                    <div class="diff-col-head"><strong>直播侧已复查版本</strong><span>当前正在播出</span></div>
                    <p>${this.renderDiffTokens(tokens, 'from')}</p>
                    <small>[${current?.speaker ?? item.speaker}]</small>
                  </div>
                  <div class="diff-col late">
                    <div class="diff-col-head"><strong>离线晚到回修</strong><span>${formatAge(active.createdAt)}提交 · 发件箱暂存</span></div>
                    <p>${this.renderDiffTokens(tokens, 'to')}</p>
                    <small>[${active.speaker}]</small>
                  </div>
                </div>
                <div class="revision-reason"><strong>晚到回修原因：</strong>${active.reason}</div>
                <div class="revision-actions">
                  <cds-button kind="secondary" @click=${() => this.resolveSelectedConflict(active.id, 'current')}>保留当前已复查版本</cds-button>
                  <cds-button kind="primary" @click=${() => this.resolveSelectedConflict(active.id, 'late')}>采用晚到版本上直播</cds-button>
                </div>
              `;
            })() : nothing}

            ${active?.status === 'pending' ? html`
              <div class="revision-card pending">
                <div class="revision-card-head">
                  <cds-tag type="warm-gray" size="sm">待复核</cds-tag>
                  <span>${formatAge(active.createdAt)}提交 · 原字幕继续可见</span>
                </div>
                <p class="revision-proposed">${active.proposedText}</p>
                <small>[${active.speaker}]</small>
                <div class="revision-reason"><strong>回修原因：</strong>${active.reason}</div>
                <div class="revision-actions">
                  <cds-button kind="danger--tertiary" size="sm" ?disabled=${this.model.connection === 'offline'} @click=${() => this.reviewSelectedRevision(active.id, false)}>复核退回</cds-button>
                  <cds-button kind="primary" size="sm" ?disabled=${this.model.connection === 'offline'} @click=${() => this.reviewSelectedRevision(active.id, true)}>复核通过并上直播</cds-button>
                </div>
                ${this.model.connection === 'offline' ? html`<p class="revision-hint">离线期间不能完成复核，连接恢复后该回修仍在这里等待。</p>` : nothing}
              </div>
            ` : nothing}

            ${active?.status === 'outbox' ? html`
              <div class="revision-card outbox">
                <div class="revision-card-head">
                  <cds-tag type="purple" size="sm">离线发件箱</cds-tag>
                  <span>${formatAge(active.createdAt)}提交 · 恢复连接后合并</span>
                </div>
                <p class="revision-proposed">${active.proposedText}</p>
                <small>[${active.speaker}]</small>
                <div class="revision-reason"><strong>回修原因：</strong>${active.reason}</div>
                <p class="revision-hint">若恢复后同一片段已在直播侧复查，将自动转成并排差异选择，不会直接覆盖。</p>
                <details class="sim-remote">
                  <summary>演示：模拟断线期间直播侧已复查该片段</summary>
                  <div class="sim-remote-body">
                    <cds-textarea label-text="直播侧复查后正在播出的字幕" .value=${this.simText} @input=${(event: Event) => { this.simText = (event.currentTarget as any).value; }}></cds-textarea>
                    <cds-button kind="secondary" size="sm" @click=${() => this.submitSimRemoteReview(active.id)}>模拟复查并恢复</cds-button>
                  </div>
                </details>
              </div>
            ` : nothing}

            ${!active ? html`
              <div class="form-grid">
                <cds-select label-text="发言人" value=${this.revisionSpeaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => { this.revisionSpeaker = event.detail.value; }}>
                  ${SPEAKERS.map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
                </cds-select>
                <div class="revision-toolbar">
                  <span>快速标点</span>
                  ${['，', '。', '？', '…'].map((mark) => html`<cds-button kind="ghost" size="sm" @click=${() => this.revisionInsert(mark)}>${mark}</cds-button>`)}
                  <cds-button kind="ghost" size="sm" @click=${this.revisionNormalizeNumbers}>规范化数字</cds-button>
                </div>
              </div>
              <cds-textarea
                id="revision-textarea"
                class="caption-input"
                label-text="回修后的字幕文本"
                helper-text="从当前直播字幕修改；提交后该段进入待复核，通过前观众仍看到原字幕"
                .value=${this.revisionText}
                @input=${(event: Event) => { this.revisionText = (event.currentTarget as any).value; }}
              ></cds-textarea>
              <div class="rule-suggestions">
                <small>术语快捷替换</small>
                ${applicableRules.length ? applicableRules.map((rule) => html`
                  <cds-button kind="tertiary" size="sm" @click=${() => this.revisionApplyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
                `) : html`<small>当前发言人的规则为空</small>`}
              </div>
              <cds-textarea
                class="reason-input"
                label-text="回修原因（必填）"
                helper-text="例如：播出后发现错字／漏字，需与口播一致"
                .value=${this.revisionReason}
                @input=${(event: Event) => { this.revisionReason = (event.currentTarget as any).value; }}
              ></cds-textarea>
              <div class="confirm-bar revision-confirm">
                <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 提交回修 · 上次内容自动存入版本链</div>
                <cds-button kind="primary" @click=${this.submitSelectedRevision}>提交回修并进入待复核</cds-button>
              </div>
            ` : nothing}
          </div>
        </div>

        <div class="history-card">
          <button class="history-toggle" @click=${() => { this.showHistory = !this.showHistory; }}>
            <strong>回修历史与版本回看</strong>
            <span>${this.showHistory ? '收起 ▲' : `展开 ${history.length} 条记录 ▼`}</span>
          </button>
          ${this.showHistory ? html`
            <div class="history-layout">
              <div class="history-list">
                ${history.map((entry) => html`
                  <button class="history-item ${this.historyEntryId === entry.id ? 'selected' : ''}" @click=${() => { this.historyEntryId = entry.id; }}>
                    <span class="history-time">${new Date(entry.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <cds-tag size="sm" type=${entry.version
                      ? (entry.kind === 'resolved' ? 'purple' : entry.kind === 'revision' ? 'green' : 'blue')
                      : entry.revision?.resolvedAt
                        ? 'purple'
                        : ({ pending: 'warm-gray', approved: 'green', rejected: 'red', outbox: 'purple', conflicted: 'red' } as Record<RevisionStatus, string>)[entry.kind as RevisionStatus] ?? 'gray'}>${entry.version ? versionKindLabel(entry.kind as VersionKind) : entry.revision?.resolvedAt ? '差异已选择' : revisionStatusLabel(entry.kind as RevisionStatus)}</cds-tag>
                    <small>${entry.version ? `[${entry.version.speaker}] ${entry.version.corrected.slice(0, 18)}${entry.version.corrected.length > 18 ? '…' : ''}` : entry.revision?.reason}</small>
                  </button>
                `)}
              </div>
              <div class="history-detail">
                ${selectedHistoryEntry?.version ? html`
                  <h4>${versionKindLabel(selectedHistoryEntry.version.kind)} · ${formatAge(selectedHistoryEntry.version.createdAt)}</h4>
                  <p class="history-text">${selectedHistoryEntry.version.corrected}</p>
                  <small>[${selectedHistoryEntry.version.speaker}] · 版本 ID ${selectedHistoryEntry.version.id}</small>
                  ${item.airingVersionId === selectedHistoryEntry.version.id ? html`<cds-tag type="green" size="sm" style="margin-top:8px;">正在播出的版本</cds-tag>` : nothing}
                ` : selectedHistoryEntry?.revision ? html`
                  <h4>${revisionStatusLabel(selectedHistoryEntry.revision.status)} · ${formatAge(selectedHistoryEntry.at)}</h4>
                  <p class="history-text">${selectedHistoryEntry.revision.proposedText}</p>
                  <small>[${selectedHistoryEntry.revision.speaker}] · ${selectedHistoryEntry.revision.source === 'offline' ? '离线提交' : '在线提交'}</small>
                  <div class="revision-reason"><strong>回修原因：</strong>${selectedHistoryEntry.revision.reason}</div>
                  ${selectedHistoryEntry.revision.reviewedNote ? html`<div class="issue-note">${selectedHistoryEntry.revision.reviewedNote}${selectedHistoryEntry.revision.reviewedAt ? `（${formatAge(selectedHistoryEntry.revision.reviewedAt)}）` : ''}</div>` : nothing}
                ` : html`<p class="revision-hint">选择左侧任意一条记录查看完整内容，所有版本和回修记录在重新打开页面后仍然保留。</p>`}
              </div>
            </div>
          ` : nothing}
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
            <span>${confirmed.length} 段已确认 · ${this.stats.pendingRevisions} 段待复核${this.stats.conflictedRevisions ? html` · <b class="conflict-count">${this.stats.conflictedRevisions} 处差异</b>` : nothing}</span>
          </div>
          ${this.stats.conflictedRevisions ? html`
            <div class="conflict-banner">
              <strong>有 ${this.stats.conflictedRevisions} 段离线晚到版本与已复查内容冲突</strong>
              <cds-button kind="danger" size="sm" @click=${this.jumpToFirstConflict}>前往并排选择</cds-button>
            </div>
          ` : nothing}
          <div class="live-timeline">
            ${confirmed.length ? confirmed.slice(-12).reverse().map((segment) => {
              const segmentReview = reviewState(segment);
              const segmentActive = activeRevision(segment);
              return html`
              <article class="live-item ${segmentReview}" @click=${() => this.selectSegment(segment.id)} role="button" tabindex="0" @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter') this.selectSegment(segment.id); }}>
                <div class="live-item-head">
                  <time>${formatClock(segment.startTime)} · ${segment.speaker}</time>
                  ${segmentReview !== 'none' ? html`<cds-tag size="sm" type=${segmentReview === 'conflicted' ? 'red' : segmentReview === 'outbox' ? 'purple' : segmentReview === 'pending' ? 'warm-gray' : 'green'}>${reviewStateLabel(segment)}</cds-tag>` : nothing}
                </div>
                <p>${segment.corrected}</p>
                ${segmentActive && segmentActive.status !== 'approved' ? html`
                  <div class="live-proposed">
                    <small>${segmentActive.status === 'conflicted' ? '晚到版本：' : '待复核回修：'}${segmentActive.proposedText}</small>
                  </div>
                ` : nothing}
                <small class="live-open">点击打开播出回修与历史${segment.source === 'offline' ? ' · 离线来源恢复后合并' : ''}</small>
              </article>
            `;}) : html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>`}
          </div>
          ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按时间顺序提交，不会覆盖已确认内容。</div>` : nothing}
          ${this.stats.outboxRevisions > 0 ? html`<div class="delivery-status revision-outbox">另有 ${this.stats.outboxRevisions} 条播出回修暂存在发件箱；若同片段已复查，恢复后会转成并排差异选择。</div>` : nothing}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>当前片段上下文</h3>
            <span>${item ? `#${item.sequence}` : '未选择'}</span>
          </div>
          <div style="padding: 12px; line-height: 1.5; font-size: 11px;">
            ${item ? html`
              <div><strong>原始字幕：</strong>${item.original}</div>
              ${item.state === 'confirmed' ? html`
                <div style="margin-top: 8px;"><strong>当前播出：</strong>${airingVersion(item)?.corrected ?? item.corrected}</div>
                <div style="margin-top: 8px; color: var(--cds-text-secondary);">版本链 ${item.versions?.length ?? 0} 个 · 回修记录 ${item.revisions?.length ?? 0} 条 · 复查状态：${reviewStateLabel(item) || '尚未复查'}</div>
                ${(item.revisions ?? []).slice(-2).map((revision) => html`<div style="margin-top:6px;" class="revision-context-line"><cds-tag size="sm" type="outline">${revisionStatusLabel(revision.status)}</cds-tag> ${revision.reason}</div>`)}
              ` : html`
                <div style="margin-top: 8px;"><strong>修改前校正：</strong>${item.corrected}</div>
                <div style="margin-top: 8px; color: var(--cds-text-secondary);">${item.tags.length ? `标签：${item.tags.join('、')}` : '尚未应用术语标签'}</div>
              `}
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
            <strong>${stats.conflictedRevisions > 0 ? '离线晚到版本与已复查字幕冲突，需并排选择' : this.model.connection === 'offline' ? '离线校正中，确认后暂存发件箱' : stats.pendingRevisions > 0 ? `${stats.pendingRevisions} 段播出回修等待复核，直播仍显示原字幕` : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 待复核回修 ${stats.pendingRevisions} · 差异 ${stats.conflictedRevisions} · 离线待合并 ${stats.offline}</span>
            <div class="queue-track"><span style=${`width:${backlogRatio}%`}></span></div>
          </div>
          <div class="status-cell"><strong>${stats.pending}</strong><span>待确认片段</span></div>
          <div class="status-cell warning"><strong>${stats.oldestWaitSeconds}s</strong><span>最长等待时间</span></div>
          <div class="status-cell ${stats.conflictedRevisions ? 'danger' : ''}"><strong>${stats.stale + stats.duplicate + stats.pendingRevisions + stats.conflictedRevisions}</strong><span>${stats.conflictedRevisions ? '含差异待选择' : '需要明确处理'}</span></div>
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
                <p>确认前修改待发字幕，已送播片段可在此提交播出回修</p>
              </div>
              <cds-tag type="green" size="sm">本地草稿</cds-tag>
            </div>
            <div class="column-body" style=${`font-size:${this.model.fontSize}px`}>${this.renderEditor()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>规则与直播区</h2>
                <p>点击直播片段可播出回修；离线内容恢复后统一合并</p>
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
