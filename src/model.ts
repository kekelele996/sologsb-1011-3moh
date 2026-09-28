export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';
export type RevisionStatus = 'pending' | 'approved' | 'rejected' | 'outbox' | 'conflicted';
export type RevisionSource = 'online' | 'offline';
export type SegmentReviewState = 'none' | 'reviewed' | 'pending' | 'outbox' | 'conflicted';
export type VersionKind = 'initial' | 'confirm' | 'revision' | 'resolved';

export interface CaptionVersion {
  id: string;
  speaker: string;
  corrected: string;
  createdAt: number;
  kind: VersionKind;
}

export interface CaptionRevision {
  id: string;
  speaker: string;
  proposedText: string;
  /** 提交回修时所基于的播出版本，用于离线恢复后判断是否已被复查 */
  baseVersionId?: string;
  reason: string;
  status: RevisionStatus;
  createdAt: number;
  reviewedAt?: number;
  reviewedNote?: string;
  /** 冲突并排选择完成时间 */
  resolvedAt?: number;
  source: RevisionSource;
}

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  speaker: string;
  original: string;
  corrected: string;
  numberHints: string;
  source: SegmentSource;
  state: SegmentState;
  duplicateOf?: string;
  staleReason?: string;
  revision: number;
  tags: string[];
  /** 当前观众可见的播出版本 */
  airingVersionId?: string;
  /** 播出内容版本链，回修提交时的“上次内容”都保存在这里 */
  versions?: CaptionVersion[];
  /** 播出回修记录（含待复核、已复核、退回、离线晚到冲突） */
  revisions?: CaptionRevision[];
}

export interface TermRule {
  id: string;
  source: string;
  replacement: string;
  speaker: string;
  enabled: boolean;
  caseSensitive: boolean;
  usageCount: number;
  createdAt: number;
}

export interface DeskModel {
  eventName: string;
  eventDate: string;
  segments: CaptionSegment[];
  rules: TermRule[];
  selectedId: string;
  connection: ConnectionState;
  simulatedDelay: number;
  fontSize: number;
  nextSequence: number;
  autoStream: boolean;
  lastMergedAt?: number;
  updatedAt: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';

function segment(
  id: string,
  sequence: number,
  startTime: number,
  speaker: string,
  original: string,
  corrected = original,
  state: SegmentState = 'pending',
): CaptionSegment {
  return {
    id,
    sequence,
    startTime,
    receivedAt: now - (100 - sequence) * 8_000,
    confirmedAt: state === 'confirmed' ? now - (100 - sequence) * 7_000 : undefined,
    speaker,
    original,
    corrected,
    numberHints: '',
    source: 'live',
    state,
    revision: 0,
    tags: [],
  };
}

const seedRevisions = (segment: CaptionSegment, entries: Array<[CaptionRevision, boolean]>): CaptionSegment => {
  const versions = segment.versions ?? [{ id: `${segment.id}-v-confirm`, speaker: segment.speaker, corrected: segment.corrected, createdAt: segment.confirmedAt ?? now, kind: 'confirm' as const }];
  const revisions = entries.map(([entry, approved]) => {
    if (approved) versions.push({ id: `${entry.id}-version`, speaker: entry.speaker, corrected: entry.proposedText, createdAt: entry.reviewedAt ?? entry.createdAt, kind: 'revision' });
    return entry;
  });
  return {
    ...segment,
    speaker: versions[versions.length - 1].speaker,
    corrected: versions[versions.length - 1].corrected,
    airingVersionId: versions[versions.length - 1].id,
    versions,
    revisions,
  };
}

const seededSegmentsRaw: CaptionSegment[] = [
  segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发布会。', 'confirmed'),
  segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是实时协作。', '今天我们会介绍三个模块，首先是实时协作。', 'confirmed'),
  segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
  segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
  segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
  segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'pending'),
  segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
];

const seg1 = seedRevisions(seededSegmentsRaw[0], [
  [{
    id: 'rev-seg1-1',
    speaker: '主持人',
    proposedText: '欢迎大家来到2025年产品发布会。',
    baseVersionId: 'seg-1-v-confirm',
    reason: '口误，年份应为去年回放场次',
    status: 'rejected',
    createdAt: now - 600_000,
    reviewedAt: now - 560_000,
    reviewedNote: '复核未通过：现场确为 2026 年发布会',
    source: 'online',
  }, false],
  [{
    id: 'rev-seg1-2',
    speaker: '主持人',
    proposedText: '欢迎大家来到2026年春季产品发布会。',
    baseVersionId: 'seg-1-v-confirm',
    reason: '漏了“春季”，直播口播完整名称',
    status: 'approved',
    createdAt: now - 420_000,
    reviewedAt: now - 380_000,
    reviewedNote: '复核通过，已替换直播字幕',
    source: 'online',
  }, true],
]);

const seg3 = seedRevisions(seededSegmentsRaw[2], [[{
  id: 'rev-seg3-1',
  speaker: '主讲人',
  proposedText: '延迟和质量监测会帮助我们保持字幕播出稳定。',
  baseVersionId: 'seg-3-v-confirm',
  reason: '播出后发现漏字，原话为“保持字幕播出稳定”',
  status: 'pending',
  createdAt: now - 120_000,
  source: 'online',
}, false]]);

const seededSegments: CaptionSegment[] = [seg1, seededSegmentsRaw[1], seg3, ...seededSegmentsRaw.slice(3)]
  .map((item) => {
    if (item.state !== 'confirmed' || item.versions?.length) return item;
    const versions: CaptionVersion[] = [{ id: `${item.id}-v-confirm`, speaker: item.speaker, corrected: item.corrected, createdAt: item.confirmedAt ?? now, kind: 'confirm' }];
    return { ...item, versions, revisions: item.revisions ?? [], airingVersionId: versions[0].id };
  });

const duplicate: CaptionSegment = {
  ...segment('seg-8', 8, 61, '主讲人', '今天我们重点讨论字幕队列。', '今天我们重点讨论字幕队列。', 'duplicate'),
  source: 'live',
  duplicateOf: 'seg-2',
  staleReason: '与第 2 段高度相似',
};

export function createInitialModel(): DeskModel {
  return {
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments: [...seededSegments, duplicate],
    rules: [
      { id: 'term-1', source: 'co pilot', replacement: 'Co-Pilot', speaker: '', enabled: true, caseSensitive: false, usageCount: 4, createdAt: now - 86_400_000 },
      { id: 'term-2', source: 'studio cloud', replacement: 'Studio Cloud', speaker: '', enabled: true, caseSensitive: false, usageCount: 7, createdAt: now - 43_200_000 },
      { id: 'term-3', source: '五G', replacement: '5G', speaker: '', enabled: true, caseSensitive: true, usageCount: 2, createdAt: now - 3_600_000 },
    ],
    selectedId: 'seg-4',
    connection: 'connected',
    simulatedDelay: 1.8,
    fontSize: 18,
    nextSequence: 9,
    autoStream: true,
    updatedAt: now,
  };
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
}

export function normalizeNumbers(text: string): string {
  const digitMap: Record<string, string> = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  const chineseNumber = (raw: string): number => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!/[十百千万]/u.test(raw)) return Number([...raw].map((char) => digits[char] ?? 0).join(''));
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of raw) {
      if (digits[char] !== undefined) {
        number = digits[char];
      } else if (char === '十') {
        section += (number || 1) * 10;
        number = 0;
      } else if (char === '百') {
        section += (number || 1) * 100;
        number = 0;
      } else if (char === '千') {
        section += (number || 1) * 1000;
        number = 0;
      } else if (char === '万') {
        total += (section + number) * 10_000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  };

  return text
    .replace(/[０-９]/g, (char) => digitMap[char] ?? char)
    .replace(/([零〇一二两三四五六七八九十百千万]+)/gu, (match) => String(chineseNumber(match)))
    .replace(/(?<=\d)[，,](?=\d{3}\b)/g, ',');
}

export function normalizePunctuation(text: string): string {
  return text
    .replace(/([，。！？；：])(?=[^\s，。！？；：])/gu, '$1')
    .replace(/\s+([，。！？；：])/gu, '$1')
    .replace(/([,;:!?])(?=[^\s,;:!?])/g, (match) => ({ ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' }[match] ?? match));
}

export function applyRules(text: string, model: DeskModel): { text: string; used: string[] } {
  let next = text;
  const used: string[] = [];
  for (const rule of model.rules.filter((item) => item.enabled)) {
    if (!rule.source || !next) continue;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (expression.test(next)) {
      next = next.replace(expression, rule.replacement);
      used.push(rule.id);
    }
  }
  return { text: normalizePunctuation(next), used };
}

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const normalize = (value: string) => value.replace(/[\s，。！？；：,.;:!?]/g, '').toLocaleLowerCase();
  const candidateText = normalize(candidate.corrected || candidate.original);
  return existing.find((segmentItem) => {
    if (segmentItem.id === candidate.id || segmentItem.state === 'ignored') return false;
    const text = normalize(segmentItem.corrected || segmentItem.original);
    if (!candidateText || !text) return false;
    return text === candidateText || (Math.abs(segmentItem.startTime - candidate.startTime) < 12 && (text.includes(candidateText) || candidateText.includes(text)));
  });
}

/** 当前仍占用片段的活跃回修（待复核 / 离线发件箱 / 冲突待选择） */
export function activeRevision(segment: CaptionSegment): CaptionRevision | undefined {
  return segment.revisions?.find((revision) => revision.status === 'pending' || revision.status === 'outbox' || revision.status === 'conflicted');
}

/** 直播区需要呈现的复查状态 */
export function reviewState(segment: CaptionSegment): SegmentReviewState {
  const active = activeRevision(segment);
  if (active) return active.status === 'pending' ? 'pending' : active.status === 'outbox' ? 'outbox' : 'conflicted';
  return segment.revisions?.some((revision) => revision.status === 'approved' || revision.status === 'rejected') ? 'reviewed' : 'none';
}

export function airingVersion(segment: CaptionSegment): CaptionVersion | undefined {
  return segment.versions?.find((version) => version.id === segment.airingVersionId) ?? segment.versions?.[segment.versions.length - 1];
}

/** 提交播出回修：保存上次播出版本，填写原因；待复核期间原字幕继续可见 */
export function submitRevision(
  model: DeskModel,
  segmentId: string,
  payload: { speaker: string; proposedText: string; reason: string },
): DeskModel {
  const timestamp = Date.now();
  return {
    ...model,
    segments: model.segments.map((item) => {
      if (item.id !== segmentId) return item;
      const base = airingVersion(item);
      const revision: CaptionRevision = {
        id: `rev-${segmentId}-${timestamp.toString(36)}`,
        speaker: payload.speaker,
        proposedText: payload.proposedText.trim(),
        baseVersionId: base?.id,
        reason: payload.reason.trim(),
        status: model.connection === 'offline' ? 'outbox' : 'pending',
        createdAt: timestamp,
        source: model.connection === 'offline' ? 'offline' : 'online',
      };
      return { ...item, revisions: [...(item.revisions ?? []), revision] };
    }),
  };
}

/** 复核回修：通过则新版本上直播并保留旧版本，退回则保留原字幕 */
export function reviewRevision(model: DeskModel, segmentId: string, revisionId: string, approve: boolean): DeskModel {
  const timestamp = Date.now();
  return {
    ...model,
    segments: model.segments.map((item) => {
      if (item.id !== segmentId) return item;
      return {
        ...item,
        revisions: item.revisions?.map((revision) => {
          if (revision.id !== revisionId || revision.status !== 'pending') return revision;
          return {
            ...revision,
            status: approve ? 'approved' : 'rejected',
            reviewedAt: timestamp,
            reviewedNote: approve ? '复核通过，已替换直播字幕' : '复核未通过，保留原字幕',
          };
        }),
        versions: approve && item.revisions?.some((revision) => revision.id === revisionId)
          ? (() => {
              const target = item.revisions?.find((revision) => revision.id === revisionId);
              if (!target) return item.versions;
              return [...(item.versions ?? []), { id: `${revisionId}-version`, speaker: target.speaker, corrected: target.proposedText, createdAt: timestamp, kind: 'revision' as const }];
            })()
          : item.versions,
        airingVersionId: approve ? `${revisionId}-version` : item.airingVersionId,
        speaker: approve
          ? item.revisions?.find((revision) => revision.id === revisionId)?.speaker ?? item.speaker
          : airingVersion(item)?.speaker ?? item.speaker,
        corrected: approve
          ? item.revisions?.find((revision) => revision.id === revisionId)?.proposedText ?? item.corrected
          : airingVersion(item)?.corrected ?? item.corrected,
      };
    }),
  };
}

/** 冲突并排选择：采用晚到版本，或保留直播侧已复查版本 */
export function resolveRevisionConflict(
  model: DeskModel,
  segmentId: string,
  revisionId: string,
  choice: 'late' | 'current',
): DeskModel {
  const timestamp = Date.now();
  return {
    ...model,
    segments: model.segments.map((item) => {
      if (item.id !== segmentId) return item;
      const revision = item.revisions?.find((entry) => entry.id === revisionId);
      if (!revision || revision.status !== 'conflicted') return item;
      const applyLate = choice === 'late';
      const resolvedVersion: CaptionVersion | undefined = applyLate
        ? { id: `${revisionId}-version`, speaker: revision.speaker, corrected: revision.proposedText, createdAt: timestamp, kind: 'resolved' }
        : undefined;
      return {
        ...item,
        revisions: item.revisions?.map((entry) => entry.id === revisionId ? {
          ...entry,
          status: applyLate ? 'approved' : 'rejected',
          reviewedAt: timestamp,
          resolvedAt: timestamp,
          reviewedNote: applyLate ? '已并排比对差异，采用离线晚到版本' : '已并排比对差异，保留直播侧已复查版本',
        } : entry),
        versions: applyLate ? [...(item.versions ?? []), resolvedVersion!] : item.versions,
        airingVersionId: applyLate ? resolvedVersion!.id : item.airingVersionId,
        speaker: applyLate ? revision.speaker : airingVersion(item)?.speaker ?? item.speaker,
        corrected: applyLate ? revision.proposedText : airingVersion(item)?.corrected ?? item.corrected,
      };
    }),
  };
}

/** 演示用：模拟断线期间直播侧已经完成复查（离线晚到版本回来后将与之冲突） */
export function simulateRemoteReview(model: DeskModel, segmentId: string, revisionId: string, remoteText: string): DeskModel {
  const timestamp = Date.now();
  return {
    ...model,
    segments: model.segments.map((item) => {
      if (item.id !== segmentId) return item;
      return {
        ...item,
        versions: [...(item.versions ?? []), { id: `sim-${timestamp.toString(36)}`, speaker: item.speaker, corrected: remoteText, createdAt: timestamp, kind: 'revision' }],
        airingVersionId: `sim-${timestamp.toString(36)}`,
        corrected: remoteText,
        revisions: item.revisions?.map((revision) => revision.id === revisionId
          ? { ...revision, baseVersionId: revision.baseVersionId }
          : revision),
      };
    }),
  };
}

export interface DiffToken { value: string; type: 'equal' | 'del' | 'ins' }

/** 逐字 LCS 差异，用于离线恢复后的并排比对 */
export function diffText(from: string, to: string): DiffToken[] {
  const a = [...from];
  const b = [...to];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffToken['type'], value: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.value += value;
    else tokens.push({ type, value });
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('del', a[i]);
      i += 1;
    } else {
      push('ins', b[j]);
      j += 1;
    }
  }
  while (i < a.length) { push('del', a[i]); i += 1; }
  while (j < b.length) { push('ins', b[j]); j += 1; }
  return tokens;
}

/** 旧版本本地草稿补齐版本链 */
export function migrateModel(model: DeskModel): DeskModel {
  let changed = false;
  const segments = model.segments.map((item) => {
    if (item.state !== 'confirmed') return item;
    if (item.versions?.length && item.airingVersionId) return item;
    changed = true;
    const versions: CaptionVersion[] = [{ id: `${item.id}-v-confirm`, speaker: item.speaker, corrected: item.corrected, createdAt: item.confirmedAt ?? item.receivedAt, kind: 'confirm' }];
    return { ...item, versions, revisions: item.revisions ?? [], airingVersionId: versions[0].id };
  });
  return changed ? { ...model, segments } : model;
}

export function mergeConfirmedSegments(model: DeskModel): DeskModel {
  const seen: string[] = [];
  const segments = model.segments
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sequence - b.sequence || a.startTime - b.startTime)
    .map((item): CaptionSegment => {
      if (item.source === 'offline' && item.state === 'confirmed') {
        item.source = item.confirmedAt && Date.now() - item.confirmedAt > 90_000 ? 'offline' : 'live';
        item.staleReason = Date.now() - item.receivedAt > 90_000 ? `离线恢复后合并，原始片段已延迟 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` : undefined;
        if (item.staleReason) item.state = 'stale';
      }
      // 离线期间提交的播出回修：若直播侧同一片段已复查（基线版本不再是当前播出版本），
      // 晚到版本不能直接覆盖，转为“冲突待选择”并排差异；否则进入待复核队列。
      item.revisions = item.revisions?.map((revision) => {
        if (revision.status !== 'outbox') return revision;
        const baseStillAiring = !revision.baseVersionId || revision.baseVersionId === item.airingVersionId;
        return baseStillAiring
          ? { ...revision, status: 'pending' as const }
          : { ...revision, status: 'conflicted' as const, reviewedNote: '离线期间该片段已在直播侧完成复查，请并排比对后选择' };
      });
      const duplicate = isDuplicate(item, seen.map((id) => model.segments.find((segmentItem) => segmentItem.id === id)).filter(Boolean) as CaptionSegment[]);
      if (duplicate && item.state !== 'confirmed') {
        item.state = 'duplicate';
        item.duplicateOf = duplicate.id;
      }
      if (item.state !== 'ignored') seen.push(item.id);
      return item;
    });

  return {
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  const allRevisions = model.segments.flatMap((item) => item.revisions ?? []);
  const pendingRevisions = allRevisions.filter((revision) => revision.status === 'pending').length;
  const conflictedRevisions = allRevisions.filter((revision) => revision.status === 'conflicted').length;
  const outboxRevisions = allRevisions.filter((revision) => revision.status === 'outbox').length;
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    pendingRevisions,
    conflictedRevisions,
    outboxRevisions,
    backlog: pending.length + stale.length + duplicate.length + offline.length + pendingRevisions + conflictedRevisions + outboxRevisions,
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.round((Date.now() - item.receivedAt) / 1000))) : 0,
  };
}

export function createLiveSegment(sequence: number): CaptionSegment {
  const speakers = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问'];
  const samples = [
    '接下来请产品团队介绍新的工作流。',
    '请注意屏幕右侧的实时队列状态。',
    '在弱网环境下我们会保留未确认片段。',
    '如果网络恢复,系统会按照时间顺序自动合并。',
    '这段字幕包含二零二五年的项目数据。',
    '大家可以在会后查看完整回放和术语表。',
  ];
  const start = Math.max(0, sequence * 9 - 10);
  return {
    id: `seg-live-${sequence}-${Date.now().toString(36)}`,
    sequence,
    startTime: start,
    receivedAt: Date.now(),
    speaker: speakers[(sequence - 1) % speakers.length],
    original: samples[(sequence - 1) % samples.length],
    corrected: samples[(sequence - 1) % samples.length],
    numberHints: '',
    source: 'live',
    state: 'pending',
    revision: 0,
    tags: [],
  };
}

export function simulateLatency(model: DeskModel): DeskModel {
  if (model.connection === 'offline') return model;
  const step = model.connection === 'degraded' ? 0.7 : model.simulatedDelay > 2.8 ? -0.3 : 0.15;
  const delay = Math.max(0.7, Math.min(8.9, Number((model.simulatedDelay + step).toFixed(1))));
  const applyStream = model.autoStream && Math.random() > 0.68;
  let nextSequence = model.nextSequence;
  let segments = model.segments;
  if (applyStream) {
    const candidate = createLiveSegment(model.nextSequence);
    const duplicate = isDuplicate(candidate, segments);
    segments = [...segments, duplicate ? { ...candidate, state: 'duplicate', duplicateOf: duplicate.id, staleReason: `与第 ${duplicate.sequence} 段重复` } : candidate];
    nextSequence += 1;
  }
  const pendingCutoff = Date.now() - 90_000;
  segments = segments.map((item) => item.state === 'pending' && item.receivedAt < pendingCutoff
    ? { ...item, state: 'stale', staleReason: `片段已等待 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` }
    : item);
  return {
    ...model,
    segments,
    nextSequence,
    simulatedDelay: delay,
    connection: delay > 4.2 ? 'degraded' : model.connection,
    updatedAt: Date.now(),
  };
}

export function toSrt(model: DeskModel): string {
  const stamp = (seconds: number, separator = ',') => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  };
  return model.segments
    .filter((item) => item.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime)
    .map((item, index) => `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speaker}] ${item.corrected}\n`)
    .join('\n');
}
