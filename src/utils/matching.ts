import type { ArchiveRecord, FieldKey, MatchCandidate, ScoringSchemeId } from '../types';

export interface ScoringProfile {
  id: ScoringSchemeId;
  label: string;
  short: string;
  description: string;
  weights: Pick<Record<FieldKey, number>, 'title' | 'date' | 'people' | 'places' | 'identifier'>;
  threshold: number;
}

/**
 * 两套核对口径：
 * - identity 身份优先：编号与人物权重最高，编号不同或人物不重合即关键冲突
 * - content 内容优先：标题、日期、地点权重最高，不设关键冲突闸口
 */
export const scoringProfiles: Record<ScoringSchemeId, ScoringProfile> = {
  identity: {
    id: 'identity',
    label: '身份优先',
    short: '编号 + 人物优先',
    description: '编号与人物决定排序。编号不同或人物完全不重合时标记关键冲突，未写处理说明不能确认或合并。',
    weights: { title: .16, date: .12, people: .3, places: .1, identifier: .32 },
    threshold: .38
  },
  content: {
    id: 'content',
    label: '内容优先',
    short: '标题 + 日期 + 地点优先',
    description: '标题、日期与地点决定排序，更看重题名、时间与事件地点的吻合。',
    weights: { title: .38, date: .26, people: .12, places: .2, identifier: .04 },
    threshold: .38
  }
};

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function computeFieldScores(left: ArchiveRecord, right: ArchiveRecord): Record<FieldKey, number> {
  return {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
}

/**
 * 关键冲突检测。
 * 身份优先口径：编号不同（规范化后不一致且不近似），或人物完全不重合。
 * 内容优先口径：仅看重标题、日期、地点，不标关键冲突。
 */
export function detectKeyConflict(
  scheme: ScoringSchemeId,
  fieldScores: Record<FieldKey, number>,
  left: ArchiveRecord,
  right: ArchiveRecord
): { keyConflict: boolean; reasons: string[] } {
  if (scheme !== 'identity') return { keyConflict: false, reasons: [] };
  const reasons: string[] = [];
  if (fieldScores.identifier < .75) reasons.push('编号不同');
  if (fieldScores.people === 0) reasons.push('人物不重合');
  return { keyConflict: reasons.length > 0, reasons };
}

const buildReasons = (scheme: ScoringSchemeId, fieldScores: Record<FieldKey, number>) => {
  const reasons: string[] = [];
  if (scheme === 'identity') {
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
    if (fieldScores.people > .8) reasons.push('人物一致');
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    if (fieldScores.places > .6) reasons.push('地点相近');
  } else {
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    if (fieldScores.places > .6) reasons.push('地点相近');
    if (fieldScores.people > .8) reasons.push('人物一致');
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  }
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return reasons;
};

export interface PairScore {
  score: number;
  fieldScores: Record<FieldKey, number>;
  reasons: string[];
  keyConflict: boolean;
  conflictReasons: string[];
}

export function scorePair(
  left: ArchiveRecord,
  right: ArchiveRecord,
  scheme: ScoringSchemeId = 'identity'
): PairScore {
  const profile = scoringProfiles[scheme];
  const fieldScores = computeFieldScores(left, right);
  const weights = profile.weights;
  const raw =
    fieldScores.title * weights.title +
    fieldScores.date * weights.date +
    fieldScores.people * weights.people +
    fieldScores.places * weights.places +
    fieldScores.identifier * weights.identifier;
  const { keyConflict, reasons: conflictReasons } = detectKeyConflict(scheme, fieldScores, left, right);
  return {
    score: Math.min(1, raw),
    fieldScores,
    reasons: buildReasons(scheme, fieldScores),
    keyConflict,
    conflictReasons
  };
}

/**
 * 全量重算候选（用于首轮匹配 / 全新工作区）。
 */
export function computeMatches(
  records: ArchiveRecord[],
  scheme: ScoringSchemeId = 'identity'
): MatchCandidate[] {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  const threshold = scoringProfiles[scheme].threshold;
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b, scheme) }))
      .filter((item) => item.score >= threshold)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        status: 'suggested',
        reasons: candidate.reasons,
        scoreScheme: scheme,
        keyConflict: candidate.keyConflict,
        conflictReasons: candidate.conflictReasons
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * 调和已有候选与最新分数：
 * - 已确认 / 忽略 / 合并的结论原样保留（分数、结论口径、处理说明、队列位置都不动）；
 * - 未决（suggested）候选按新口径重算：新出现的配对加入，
 *   低于阈值且此前未形成结论的配对移除，其余按新分降序，填入空出的位置；
 * - 已作结论候选的相对位置保持不变（穿插在队列中也不移动）。
 */
export function reconcileMatches(
  existing: MatchCandidate[],
  records: ArchiveRecord[],
  scheme: ScoringSchemeId,
  version: number | null
): MatchCandidate[] {
  const fresh = computeMatches(records, scheme);
  const freshById = new Map(fresh.map((match) => [match.id, match]));
  const rescored: MatchCandidate[] = [];
  const slots: Array<MatchCandidate | null> = [];

  existing.forEach((match) => {
    if (match.status !== 'suggested') {
      slots.push(match);
      freshById.delete(match.id);
      return;
    }
    const updated = freshById.get(match.id);
    if (!updated) {
      // 新口径下不再达到阈值的未决候选，分数失效后移除（腾出位置）
      slots.push(null);
      return;
    }
    freshById.delete(match.id);
    slots.push(null);
    rescored.push({
      ...match,
      score: updated.score,
      fieldScores: updated.fieldScores,
      reasons: updated.reasons,
      keyConflict: updated.keyConflict,
      conflictReasons: updated.conflictReasons,
      scoreScheme: scheme,
      scoreVersion: version
    });
  });

  // 新批次 / 新口径下首次出现的配对
  freshById.forEach((match) => rescored.push({ ...match, scoreVersion: version }));
  rescored.sort((a, b) => b.score - a.score);

  // 未决项按新分降序填入空槽；结论项原地不动；新对多出来时追加
  const result: MatchCandidate[] = [];
  let cursor = 0;
  slots.forEach((slot) => {
    if (slot) result.push(slot);
    else if (cursor < rescored.length) result.push(rescored[cursor++]);
  });
  while (cursor < rescored.length) result.push(rescored[cursor++]);
  return result;
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
