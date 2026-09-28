export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';
export type SegmentReviewState = 'unreviewed' | 'pending' | 'reviewed';
export type RevisionStatus = 'pending' | 'approved' | 'rejected' | 'conflict';
export type ConflictChoice = 'incoming' | 'current';

/** 一次“播出回修”记录：保存回修原因、上一版（送播中）内容与处理结果。 */
export interface CaptionRevision {
  id: string;
  revisionNo: number;
  createdAt: number;
  reason: string;
  previousSpeaker: string;
  previousText: string;
  nextSpeaker: string;
  nextText: string;
  status: RevisionStatus;
  /** 离线期间提交，恢复合并后才参与冲突判定。 */
  createdOffline: boolean;
  /** 提交回修时该片段是否已经完成过复查（离线恢复时据此判断是否构成冲突）。 */
  baseReviewed: boolean;
  resolvedAt?: number;
  /** 冲突时校对员的选择：采用晚到回修 / 保留已复查版本。 */
  resolvedChoice?: ConflictChoice;
  resolveNote?: string;
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
  reviewState: SegmentReviewState;
  /** 新版本排在最前，历史版本始终保留以便回看。 */
  reviewHistory: CaptionRevision[];
  reviewedAt?: number;
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
    reviewState: state === 'confirmed' ? 'unreviewed' : 'unreviewed',
    reviewHistory: [],
  };
}

const seededSegments: CaptionSegment[] = [
  {
    ...segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发部会。', 'confirmed'),
    reviewState: 'reviewed',
    reviewedAt: now - 300_000,
    reviewHistory: [
      {
        id: 'rev-seg-1-1',
        revisionNo: 1,
        createdAt: now - 420_000,
        reason: '播出后观众反馈错字：“发部会”应为“发布会”',
        previousSpeaker: '主持人',
        previousText: '欢迎大家来到2026年产品发部会。',
        nextSpeaker: '主持人',
        nextText: '欢迎大家来到2026年产品发布会。',
        status: 'approved',
        createdOffline: false,
        baseReviewed: false,
        resolvedAt: now - 300_000,
      },
    ],
  },
  segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是实时协作。', '今天我们会介绍三个模块，首先是实时协作。', 'confirmed'),
  segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
  segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
  segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
  segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'pending'),
  segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
];

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

/** 为旧版本草稿补齐播出回修字段，保证重新打开页面后历史数据仍可用。 */
export function migrateModel(model: DeskModel): DeskModel {
  return {
    ...model,
    segments: model.segments.map((item) => ({
      ...item,
      reviewState: item.reviewState ?? (item.state === 'confirmed' ? 'unreviewed' : 'unreviewed'),
      reviewHistory: item.reviewHistory ?? [],
    })),
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

export function activeRevision(segment: CaptionSegment): CaptionRevision | undefined {
  return segment.reviewHistory.find((item) => item.status === 'pending' || item.status === 'conflict');
}

/** 提交一次播出回修：保存上一版内容与原因，原字幕继续播出，状态转为待复核。 */
export function submitSegmentRevision(
  segments: CaptionSegment[],
  segmentId: string,
  draft: { reason: string; speaker: string; text: string },
  offline: boolean,
): CaptionSegment[] {
  const reason = draft.reason.trim();
  const text = draft.text.trim();
  const time = Date.now();
  return segments.map((item) => {
    if (item.id !== segmentId || item.state !== 'confirmed') return item;
    if (activeRevision(item)) return item; // 待复核/待裁决期间不能叠加新回修
    const revisionNo = item.reviewHistory.length + 1;
    const revision: CaptionRevision = {
      id: `rev-${segmentId}-${time.toString(36)}`,
      revisionNo,
      createdAt: time,
      reason,
      previousSpeaker: item.speaker,
      previousText: item.corrected,
      nextSpeaker: draft.speaker,
      nextText: text,
      status: 'pending',
      createdOffline: offline,
      baseReviewed: item.reviewState === 'reviewed',
    };
    return {
      ...item,
      reviewHistory: [revision, ...item.reviewHistory],
      reviewState: 'pending',
    };
  });
}

/** 复核完成：通过则用新版本替换送播内容，驳回则原内容继续播出。 */
export function resolveSegmentRevision(
  segments: CaptionSegment[],
  revisionId: string,
  decision: 'approved' | 'rejected',
  note = '',
): CaptionSegment[] {
  const time = Date.now();
  return segments.map((item) => {
    const target = item.reviewHistory.find((rev) => rev.id === revisionId);
    if (!target || (target.status !== 'pending' && target.status !== 'conflict')) return item;
    const reviewed: CaptionRevision = {
      ...target,
      status: decision,
      resolvedAt: time,
      resolveNote: note || (decision === 'approved'
        ? '复核通过，已更新直播内容'
        : '复核驳回，直播内容保持不变'),
      resolvedChoice: target.resolvedChoice ?? (decision === 'approved' ? 'incoming' : 'current'),
    };
    if (decision === 'rejected') {
      return {
        ...item,
        reviewHistory: item.reviewHistory.map((rev) => rev.id === revisionId ? reviewed : rev),
        reviewState: 'reviewed',
        reviewedAt: time,
      };
    }
    return {
      ...item,
      speaker: target.nextSpeaker,
      corrected: target.nextText,
      revision: item.revision + 1,
      reviewHistory: item.reviewHistory.map((rev) => rev.id === revisionId ? reviewed : rev),
      reviewState: 'reviewed',
      reviewedAt: time,
    };
  });
}

/** 离线冲突裁决：校对员选择采用晚到回修，还是保留已复查的播出版本。 */
export function resolveRevisionConflict(
  segments: CaptionSegment[],
  revisionId: string,
  choice: ConflictChoice,
): CaptionSegment[] {
  return resolveSegmentRevision(
    segments,
    revisionId,
    choice === 'incoming' ? 'approved' : 'rejected',
    choice === 'incoming' ? '离线晚到版本与已复查版本不一致，校对员选择采用晚到回修' : '离线晚到版本与已复查版本不一致，校对员选择保留已复查版本',
  ).map((item) => {
    const target = item.reviewHistory.find((rev) => rev.id === revisionId);
    if (!target) return item;
    return { ...item, reviewHistory: item.reviewHistory.map((rev) => rev.id === revisionId ? { ...rev, resolvedChoice: choice } : rev) };
  });
}

/** 已确认且没有待处理回修时，校对员可直接标记“已复查、无需修改”。 */
export function markSegmentReviewed(segments: CaptionSegment[], segmentId: string): CaptionSegment[] {
  return segments.map((item) => {
    if (item.id !== segmentId || item.state !== 'confirmed' || activeRevision(item)) return item;
    return { ...item, reviewState: 'reviewed', reviewedAt: Date.now() };
  });
}

export function mergeConfirmedSegments(model: DeskModel): DeskModel {
  const seen: string[] = [];
  const time = Date.now();
  let segments = model.segments
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sequence - b.sequence || a.startTime - b.startTime)
    .map((item): CaptionSegment => {
      if (item.source === 'offline' && item.state === 'confirmed') {
        item.source = item.confirmedAt && time - item.confirmedAt > 90_000 ? 'offline' : 'live';
        item.staleReason = time - item.receivedAt > 90_000 ? `离线恢复后合并，原始片段已延迟 ${Math.round((time - item.receivedAt) / 1000)} 秒` : undefined;
        if (item.staleReason) item.state = 'stale';
      }
      const duplicate = isDuplicate(item, seen.map((id) => model.segments.find((segmentItem) => segmentItem.id === id)).filter(Boolean) as CaptionSegment[]);
      if (duplicate && item.state !== 'confirmed') {
        item.state = 'duplicate';
        item.duplicateOf = duplicate.id;
      }
      if (item.state !== 'ignored') seen.push(item.id);
      return item;
    });

  // 离线期间提交的播出回修在恢复后落地：
  // 若同一片段已被复查且晚到版本与播出版本不一致，不能直接覆盖，转为冲突并排展示。
  segments = segments.map((item) => {
    const pendingOffline = item.reviewHistory.find((rev) => rev.status === 'pending' && rev.createdOffline);
    if (!pendingOffline) return item;
    const sameAsLive = pendingOffline.nextText.trim() === item.corrected.trim() && pendingOffline.nextSpeaker === item.speaker;
    if (pendingOffline.baseReviewed && !sameAsLive) {
      const conflict: CaptionRevision = { ...pendingOffline, status: 'conflict' };
      return {
        ...item,
        reviewState: 'pending',
        reviewHistory: item.reviewHistory.map((rev) => rev.id === conflict.id ? conflict : rev),
      };
    }
    const autoApproved: CaptionRevision = {
      ...pendingOffline,
      status: 'approved',
      resolvedAt: time,
      resolvedChoice: 'incoming',
      resolveNote: sameAsLive ? '离线回修内容与当前播出版本一致，自动确认' : '恢复时该段尚未复查，离线回修自动通过',
    };
    const base = sameAsLive ? item : { ...item, speaker: pendingOffline.nextSpeaker, corrected: pendingOffline.nextText, revision: item.revision + 1 };
    return {
      ...base,
      reviewState: 'reviewed',
      reviewedAt: time,
      reviewHistory: item.reviewHistory.map((rev) => rev.id === autoApproved.id ? autoApproved : rev),
    };
  });

  return {
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: time,
    updatedAt: time,
  };
}

export interface DiffPart {
  type: 'same' | 'add' | 'remove';
  value: string;
}

/** 逐字 LCS 差异，供并排对比晚到版本与已复查版本。 */
export function diffText(current: string, incoming: string): DiffPart[] {
  const a = [...current];
  const b = [...incoming];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const raw: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      raw.push({ type: 'same', value: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      raw.push({ type: 'remove', value: a[i] });
      i += 1;
    } else {
      raw.push({ type: 'add', value: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    raw.push({ type: 'remove', value: a[i] });
    i += 1;
  }
  while (j < b.length) {
    raw.push({ type: 'add', value: b[j] });
    j += 1;
  }
  // 合并连续的同类片段，减少 DOM 节点。
  return raw.reduce<DiffPart[]>((acc, part) => {
    const last = acc[acc.length - 1];
    if (last && last.type === part.type) last.value += part.value;
    else acc.push({ ...part });
    return acc;
  }, []);
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  const reviewPending = model.segments.filter((item) => item.state === 'confirmed' && item.reviewState === 'pending');
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    reviewPending: reviewPending.length,
    revisionConflict: reviewPending.filter((item) => activeRevision(item)?.status === 'conflict').length,
    backlog: pending.length + stale.length + duplicate.length + offline.length,
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
    reviewState: 'unreviewed',
    reviewHistory: [],
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
