import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, AuditEntry, ConclusionScheme, FieldKey,
  MatchCandidate, MergeResult, RecordGroup, ScoringSchemeId
} from './types';
import { fieldValue, reconcileMatches, scoringProfiles } from './utils/matching';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const schemeLabels: Record<ConclusionScheme, string> = {
  identity: '身份优先',
  content: '内容优先',
  legacy: '旧版固定口径'
};

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};
const conflictBlocked = (match: MatchCandidate) => !!match.keyConflict && !match.resolutionNote?.trim();
const schemeStamp = (match: MatchCandidate) =>
  `按${schemeLabels[match.conclusionScheme ?? 'legacy']}口径${match.conclusionVersion ? ` · 第 ${match.conclusionVersion} 批资料` : ''}`;

/** 旧版本地数据迁移：补齐双口径字段，旧结论标注为“旧版固定口径” */
const migrate = (saved: Partial<ArchiveState>): ArchiveState => ({
  revision: saved.revision ?? 1,
  records: saved.records ?? [],
  matches: (saved.matches ?? []).map((match) => ({
    ...match,
    scoreScheme: match.scoreScheme ?? 'identity',
    scoreVersion: match.scoreVersion ?? null,
    conclusionScheme: match.conclusionScheme
      ?? (match.status && match.status !== 'suggested' ? 'legacy' : undefined),
    conclusionVersion: match.conclusionVersion ?? null
  })),
  merges: (saved.merges ?? []).map((merge) => ({ ...merge, scheme: merge.scheme ?? 'legacy', schemeVersion: merge.schemeVersion ?? null })),
  audit: (saved.audit ?? []).map((entry) => ({ ...entry, scheme: entry.scheme ?? 'legacy', schemeVersion: entry.schemeVersion ?? null })),
  activeMatchId: saved.activeMatchId ?? '',
  selectedRecordIds: saved.selectedRecordIds ?? [],
  hydrated: true,
  scheme: saved.scheme === 'content' ? 'content' : 'identity',
  schemeVersion: saved.schemeVersion ?? 1
});

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const noteEditingId = useSignal('');

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    scheme: state.scheme,
    schemeVersion: state.schemeVersion
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = migrate(JSON.parse(raw) as Partial<ArchiveState>);
    state.revision = next.revision;
    state.records = next.records;
    state.matches = next.matches;
    state.merges = next.merges;
    state.audit = next.audit;
    state.scheme = next.scheme;
    state.schemeVersion = next.schemeVersion;
  };

  /** 载入本地工作区；旧版本保存的未决分数按当前口径补算一次 */
  const loadWorkspace = (raw: string) => {
    const saved = JSON.parse(raw) as Partial<ArchiveState>;
    const legacyPending = (saved.matches ?? []).some((match) => !match.scoreScheme && match.status === 'suggested');
    restore(raw);
    if (legacyPending) {
      state.matches = reconcileMatches(state.matches, state.records, state.scheme, null);
      commit(
        '核对口径迁移',
        `双口径核对上线：旧版固定权重算出的未决候选已按${schemeLabels[state.scheme]}口径重新评分；此前已作结论的匹配保留为「旧版固定口径」`,
        []
      );
    }
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3600);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      detail,
      recordIds,
      scheme: state.scheme,
      schemeVersion: state.schemeVersion
    };
    state.audit.unshift(entry);
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  // 顺序已由 reconcileMatches 保证：未决候选按当前口径分数降序，已作结论的相对位置保持不动
  const filteredMatches = useComputed$(() =>
    state.matches.filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const pendingKeyConflicts = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && conflictBlocked(match)).length);

  /** 切换核对口径：未决候选分数立即失效并重算重排，已作结论的保持原样 */
  const switchScheme = $((next: ScoringSchemeId) => {
    if (next === state.scheme) return;
    const prev = state.scheme;
    capture();
    state.scheme = next;
    state.matches = reconcileMatches(state.matches, state.records, next, state.schemeVersion);
    const pending = state.matches.filter((match) => match.status === 'suggested').length;
    commit(
      '切换核对口径',
      `口径由「${scoringProfiles[prev].label}」切换为「${scoringProfiles[next].label}」：${pending} 条未决候选旧分数失效，已按新口径重算并重排；已确认、忽略与合并的结论保持原样`,
      []
    );
    notify(`已切换为${scoringProfiles[next].label}口径，未决候选已重算重排`);
  });

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if (status === 'confirmed' && conflictBlocked(match)) {
      notify('该候选存在关键冲突，须先填写处理说明才能确认');
      return;
    }
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    match.conclusionScheme = state.scheme;
    match.conclusionVersion = state.schemeVersion;
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(
      status === 'confirmed' ? '确认匹配' : '忽略可疑匹配',
      `${matchLabel(state, match)}${match.resolutionNote?.trim() ? `；处理说明：${match.resolutionNote.trim()}` : ''}`,
      [match.leftId, match.rightId]
    );
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const picked = ids
      .map((id) => state.matches.find((item) => item.id === id))
      .filter((match): match is MatchCandidate => !!match);
    const alreadyConcluded = picked.filter((match) => match.status !== 'suggested');
    const blocked = status === 'confirmed'
      ? picked.filter((match) => match.status === 'suggested' && conflictBlocked(match))
      : [];
    const eligible = picked.filter((match) =>
      match.status === 'suggested' && !blocked.includes(match));
    const skipped = alreadyConcluded.length + blocked.length;
    if (!eligible.length) {
      notify(`未执行：跳过 ${skipped} 条${blocked.length ? `（其中 ${blocked.length} 条关键冲突缺处理说明）` : '（均已有结论）'}`);
      return;
    }
    capture();
    const stamp = new Date().toISOString();
    eligible.forEach((match) => {
      match.status = status;
      match.reviewedAt = stamp;
      match.conclusionScheme = state.scheme;
      match.conclusionVersion = state.schemeVersion;
      if (status === 'confirmed') {
        state.records.forEach((record) => {
          if (record.id === match.leftId || record.id === match.rightId) record.status = 'confirmed';
        });
      }
    });
    commit(
      '批量复核',
      `批量${status === 'confirmed' ? '确认' : '忽略'} ${eligible.length} 条匹配；跳过 ${skipped} 条（关键冲突缺处理说明 ${blocked.length} 条，已有结论 ${alreadyConcluded.length} 条）`,
      eligible.flatMap((match) => [match.leftId, match.rightId])
    );
    selectedMatchIds.value = [];
    notify(`已批量${status === 'confirmed' ? '确认' : '忽略'} ${eligible.length} 条；跳过 ${skipped} 条${blocked.length ? `（关键冲突缺说明 ${blocked.length} 条）` : ''}`);
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (conflictBlocked(match)) {
      notify('该候选存在关键冲突，须先填写处理说明才能合并');
      return;
    }
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) {
      notify('原始记录已被合并或移除，无法再次合并');
      return;
    }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const beginNote = (id: string) => {
    // 进入编辑时保留编辑前快照，使撤销可以回退整段处理说明
    if (noteEditingId.value !== id) {
      capture();
      noteEditingId.value = id;
    }
  };

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (conflictBlocked(match)) {
      notify('该候选存在关键冲突，须先填写处理说明才能合并');
      return;
    }
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) {
        item.status = 'merged';
        item.reviewedAt = new Date().toISOString();
        item.conclusionScheme = state.scheme;
        item.conclusionVersion = state.schemeVersion;
      } else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) {
        item.status = 'rejected';
      }
    });
    const mergeRecord: MergeResult = {
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString(),
      resolutionNote: match.resolutionNote?.trim() || undefined,
      scheme: state.scheme,
      schemeVersion: state.schemeVersion
    };
    state.merges.unshift(mergeRecord);
    commit(
      '合并两条记录',
      `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段${match.resolutionNote?.trim() ? `；关键冲突处理说明：${match.resolutionNote.trim()}` : ''}`,
      [left.id, right.id, merged.id]
    );
    mergeOpen.value = false;
    notify('记录已合并，处理说明、字段来源与所用口径已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    // 新资料批次：口径版本递增，未决候选分数失效重算，已有结论保留
    state.schemeVersion += 1;
    state.matches = reconcileMatches(state.matches, state.records, state.scheme, state.schemeVersion);
    commit(
      '导入档案记录',
      `从 ${importGroup.value} 组导入 ${rows.length} 条记录（第 ${state.schemeVersion} 批资料）；未决候选按${scoringProfiles[state.scheme].label}口径重新评分，已确认 / 忽略 / 合并的结论保持原样`,
      []
    );
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录，未决候选已按当前口径重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      currentScheme: state.scheme,
      currentSchemeLabel: schemeLabels[state.scheme],
      schemeVersion: state.schemeVersion,
      schemeProfiles: Object.fromEntries(Object.entries(scoringProfiles).map(([id, profile]) => [
        id,
        { label: profile.label, short: profile.short, description: profile.description, weights: profile.weights, threshold: profile.threshold }
      ])),
      records: state.records,
      matches: state.matches.map((match) => ({
        ...match,
        scoreSchemeLabel: match.scoreScheme ? schemeLabels[match.scoreScheme] : undefined,
        conclusionSchemeLabel: match.conclusionScheme ? schemeLabels[match.conclusionScheme] : undefined
      })),
      merges: state.merges.map((merge) => ({
        ...merge,
        schemeLabel: merge.scheme ? schemeLabels[merge.scheme] : schemeLabels.legacy
      })),
      audit: state.audit
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loadWorkspace(raw);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => snapshot());
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) {
        event.preventDefault();
        if (conflictBlocked(activeMatch.value)) notify('关键冲突须先填写处理说明，才能合并');
        else openMerge();
      }
      if (key === 'c' && activeMatch.value) {
        event.preventDefault();
        if (conflictBlocked(activeMatch.value)) notify('关键冲突须先填写处理说明，才能确认');
        else updateMatch(activeMatch.value.id, 'confirmed');
      }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>核对口径随资料批次可调；逐条确认可疑匹配，保留每个字段的来源选择与作出结论时使用的口径。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{pendingKeyConflicts.value}</strong><span>待处理关键冲突</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="scheme-row">
            <div class="scheme-switch" role="tablist" aria-label="核对口径">
              {(Object.keys(scoringProfiles) as ScoringSchemeId[]).map((id) => {
                const profile = scoringProfiles[id];
                const active = state.scheme === id;
                return (
                  <button
                    key={id}
                    class={`scheme-option ${active ? 'active' : ''}`}
                    aria-pressed={active}
                    onClick$={() => switchScheme(id)}
                    title={profile.description}
                  >
                    <strong>{profile.label}</strong>
                    <small>{profile.short}</small>
                  </button>
                );
              })}
            </div>
            <div class="scheme-meta">
              <span>第 {state.schemeVersion} 批资料</span>
              <span>当前：{scoringProfiles[state.scheme].label}</span>
            </div>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              const concluded = match.status !== 'suggested';
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''} ${match.keyConflict ? 'key' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    {match.keyConflict && <span class="conflict-badge" title={(match.conflictReasons ?? []).join('、')}>关键冲突 · {(match.conflictReasons ?? []).join('/')}</span>}
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title ?? '记录已合并'}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title ?? '记录已合并'}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">
                    {concluded
                      ? <><em>{schemeStamp(match)}</em>{match.reviewedAt ? ` · ${new Date(match.reviewedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}{match.resolutionNote?.trim() ? ` · 说明：${match.resolutionNote.trim()}` : ''}</>
                      : <>{match.reasons.join(' · ')} · 按{schemeLabels[match.scoreScheme ?? state.scheme]}口径评分{match.scoreVersion ? `（第${match.scoreVersion}批）` : ''}</>}
                  </div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const match = activeMatch.value!;
                const left = recordById(state, match.leftId);
                const right = recordById(state, match.rightId);
                if (!left || !right) return <div class="empty-state">该匹配涉及的原始记录已被合并，处理结论与口径记录保留在审计轨迹中。</div>;
                const blocked = conflictBlocked(match);
                const concluded = match.status !== 'suggested';
                return <>
                  <div class="active-score"><span>{Math.round(match.score * 100)}</span><div><strong>综合匹配分 · {schemeLabels[match.scoreScheme ?? state.scheme]}</strong><small>{match.reasons.join(' · ')}</small></div></div>
                  {match.keyConflict && (
                    <div class={`conflict-box ${match.resolutionNote?.trim() ? 'resolved' : ''}`}>
                      <div class="conflict-title">⚠ 关键冲突：{(match.conflictReasons ?? []).join('、')}</div>
                      <p>身份优先口径下，编号不同或人物不重合即构成关键冲突。未填写处理说明不能确认或合并；批量操作会自动跳过本项。</p>
                      <textarea
                        class="note-input"
                        value={match.resolutionNote ?? ''}
                        placeholder="写明判断依据，例如：已比对采访批次登记表，两侧为同一访谈的录音与手稿，编号分属两个馆藏系统…"
                        onFocus$={() => beginNote(match.id)}
                        onInput$={(event) => { match.resolutionNote = (event.target as HTMLTextAreaElement).value; }}
                        disabled={concluded}
                      />
                      <div class="note-state">
                        {concluded
                          ? <em>结论已固定（{schemeStamp(match)}），处理说明随结论一并保存</em>
                          : match.resolutionNote?.trim()
                            ? <em class="ok">已记录处理说明，可确认或合并（撤销可回退编辑）</em>
                            : <em class="warn">待填写：处理说明、旧结论与当前口径会一起保存、撤销重做和导出</em>}
                      </div>
                    </div>
                  )}
                  {concluded && (
                    <div class="conclusion-stamp">
                      <strong>{match.status === 'confirmed' ? '该匹配已确认' : match.status === 'rejected' ? '该匹配已忽略' : '该匹配已合并'}</strong>
                      <span>{schemeStamp(match)} · {match.reviewedAt ? new Date(match.reviewedAt).toLocaleString('zh-CN') : ''}</span>
                    </div>
                  )}
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack">
                    <button class="button primary wide" disabled={blocked} onClick$={openMerge}>逐字段合并{blocked ? '（需先填写处理说明）' : ''}</button>
                    <div class="split-actions">
                      <button class="button confirm" disabled={blocked} onClick$={() => updateMatch(match.id, 'confirmed')}>确认匹配{blocked ? '（需说明）' : ''}</button>
                      <button class="button ghost" onClick$={() => updateMatch(match.id, 'rejected')}>忽略</button>
                    </div>
                  </div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary>
                  <p>{new Date(merge.mergedAt).toLocaleString('zh-CN')} · 按{schemeLabels[merge.scheme ?? 'legacy']}口径{merge.schemeVersion ? ` · 第 ${merge.schemeVersion} 批资料` : ''}</p>
                  {merge.resolutionNote?.trim() && <p class="merge-note"><strong>关键冲突处理说明：</strong>{merge.resolutionNote}</p>}
                  <ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul>
                </details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择、处理说明与所用口径会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口（关键冲突须先写说明）</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配（关键冲突无说明时确认被拦截）</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（含口径切换与说明编辑）</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span class="audit-scheme">{schemeLabels[entry.scheme ?? 'legacy']}{entry.schemeVersion ? ` · 第${entry.schemeVersion}批` : ''}<em>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</em></span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>核对口径与保护规则</h3></div></div>
          <div class="scheme-explain">
            <strong class={state.scheme === 'identity' ? 'current' : ''}>身份优先</strong>
            <p>编号与人物权重最高；编号不同或人物不重合即标记<span class="tag-red">关键冲突</span>，须写处理说明才能确认 / 合并。</p>
            <strong class={state.scheme === 'content' ? 'current' : ''}>内容优先</strong>
            <p>标题、日期、地点权重最高；不设关键冲突闸口。</p>
          </div>
          <div class="rule-row"><span>1</span><p>切换口径或导入新批次后，未决候选分数立即失效并重算重排；已确认、忽略、合并的结论保持原样，并记录当时口径与批次。</p></div>
          <div class="rule-row"><span>2</span><p>关键冲突无处理说明不能确认或合并，批量操作跳过并告知数量；处理说明随结论一起保存、撤销重做和导出。</p></div>
          <div class="rule-row"><span>3</span><p>记录列表分批窗口渲染，导入大量数据时仍只挂载当前窗口。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。导入即作为新资料批次：未决候选按当前「{scoringProfiles[state.scheme].label}」口径重新评分，已有结论不受影响。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并按当前口径重算</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const match = activeMatch.value!;
            const left = recordById(state, match.leftId);
            const right = recordById(state, match.rightId);
            if (!left || !right) return null;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号、选择依据、处理说明与「{schemeLabels[state.scheme]} · 第 {state.schemeVersion} 批」口径标记均保留在审计轨迹中。</Modal.Description>
              {match.keyConflict && <div class="merge-note-bar">关键冲突（{(match.conflictReasons ?? []).join('、')}）处理说明：{match.resolutionNote?.trim()}</div>}
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
