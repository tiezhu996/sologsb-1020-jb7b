export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
export type ReconciliationScheme = 'identity' | 'content';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
  /** 评分所依据的核对方案 */
  scheme: ReconciliationScheme;
  /** 关键冲突说明（身份优先：编号不同 / 人物不重合） */
  keyConflicts: string[];
  /** 关键冲突的处理说明；无说明时不能确认或合并 */
  handlingNote?: string;
  /** 方案切换前的旧结论分数 */
  previousScore?: number;
  /** 旧结论所属方案 */
  previousScheme?: ReconciliationScheme;
  /** 作出结论（确认 / 忽略 / 合并）时所采用的方案 */
  concludedUnder?: ReconciliationScheme;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  /** 合并时所采用的核对方案 */
  scheme: ReconciliationScheme;
  /** 关键冲突处理说明 */
  handlingNote?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  /** 当前核对口径 */
  scheme: ReconciliationScheme;
}
