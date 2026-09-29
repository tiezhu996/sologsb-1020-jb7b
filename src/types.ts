export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
export type ScoringSchemeId = 'identity' | 'content';
export type ConclusionScheme = ScoringSchemeId | 'legacy';

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
  /** 当前分数按哪套口径、哪个资料批次算出（未决候选切口径后立即重算并改标） */
  scoreScheme?: ScoringSchemeId;
  scoreVersion?: number | null;
  /** 作出确认 / 忽略 / 合并结论时使用的口径；legacy 表示双方案功能上线前的旧结论 */
  conclusionScheme?: ConclusionScheme;
  conclusionVersion?: number | null;
  /** 当前口径下是否构成关键冲突（身份优先：编号不同或人物不重合） */
  keyConflict?: boolean;
  conflictReasons?: string[];
  /** 关键冲突处理说明，无说明不得确认或合并 */
  resolutionNote?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  resolutionNote?: string;
  scheme?: ConclusionScheme;
  schemeVersion?: number | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
  /** 该动作发生时生效的核对口径与资料批次 */
  scheme?: ConclusionScheme;
  schemeVersion?: number | null;
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
  scheme: ScoringSchemeId;
  /** 资料批次 / 口径版本，每次导入递增 */
  schemeVersion: number;
}
