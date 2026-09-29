import type { ArchiveRecord, FieldKey, MatchCandidate, ReconciliationScheme } from '../types';

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

export const SCHEME_LABELS: Record<ReconciliationScheme, string> = {
  identity: '身份优先',
  content: '内容优先'
};

/** 各核对方案的字段权重：身份优先重编号与人物，内容优先重标题、日期与地点 */
const WEIGHTS: Record<ReconciliationScheme, Partial<Record<FieldKey, number>>> = {
  identity: { title: .20, date: .14, people: .26, places: .10, identifier: .30 },
  content: { title: .34, date: .26, people: .10, places: .22, identifier: .08 }
};

/** 关键冲突：身份优先方案下，编号不同或人物不重合即为关键冲突 */
const keyConflictsFor = (
  scheme: ReconciliationScheme,
  left: ArchiveRecord,
  right: ArchiveRecord,
  fieldScores: Record<FieldKey, number>
): string[] => {
  const conflicts: string[] = [];
  if (scheme === 'identity') {
    const lid = left.identifier.trim();
    const rid = right.identifier.trim();
    if (lid && rid && normalize(lid) !== normalize(rid)) {
      conflicts.push(`编号不一致（${lid} ↔ ${rid}）`);
    }
    if (left.people.length && right.people.length && fieldScores.people === 0) {
      conflicts.push(`人物不重合（${left.people.join('、')} ↔ ${right.people.join('、')}）`);
    }
  }
  return conflicts;
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord, scheme: ReconciliationScheme = 'identity') {
  const fieldScores: Record<FieldKey, number> = {
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
  const weights = WEIGHTS[scheme];
  const score = (Object.keys(weights) as FieldKey[])
    .reduce((sum, field) => sum + fieldScores[field] * (weights[field] ?? 0), 0);
  const reasons: string[] = [];
  if (scheme === 'identity') {
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
    else if (fieldScores.identifier > .5) reasons.push('编号相近');
    if (fieldScores.people > .8) reasons.push('人物一致');
    else if (fieldScores.people > .4) reasons.push('人物部分重合');
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    if (fieldScores.places > .6) reasons.push('地点相近');
  } else {
    if (fieldScores.title > .58) reasons.push('标题相似');
    if (fieldScores.date > .9) reasons.push('日期一致');
    else if (fieldScores.date > .6) reasons.push('日期相近');
    if (fieldScores.places > .6) reasons.push('地点相近');
    if (fieldScores.people > .8) reasons.push('人物一致');
    if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  }
  if (!reasons.length) reasons.push(scheme === 'content' ? '内容字段达到匹配阈值' : '组合字段达到匹配阈值');
  return {
    score: Math.min(1, score),
    fieldScores,
    reasons,
    keyConflicts: keyConflictsFor(scheme, left, right, fieldScores)
  };
}

export function computeMatches(records: ArchiveRecord[], scheme: ReconciliationScheme = 'identity'): MatchCandidate[] {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b, scheme) }))
      .filter((item) => item.score >= .38)
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
        scheme,
        keyConflicts: candidate.keyConflicts
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
