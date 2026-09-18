import { useMemo } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp } from '../srt';
import { resolveRange } from '../silence';
import { parseMaxPerLine, planReflow } from '../reflow';
import type { ReflowItemPlan, ReflowPlan } from '../reflow';

export interface ReflowForm {
  /** 连续区间字幕起点 id（与 to 顺序可互换） */
  fromId: string | null;
  toId: string | null;
  /** 每行最大字素数（输入框原始文本） */
  maxPerLine: string;
}

export const DEFAULT_REFLOW_FORM: ReflowForm = {
  fromId: null,
  toId: null,
  maxPerLine: '20',
};

interface ReflowPanelProps {
  subs: Subtitle[];
  form: ReflowForm;
  onFormChange: (form: ReflowForm) => void;
  /** 预览中被取消勾选的条目 id（可行项默认全部勾选） */
  excluded: string[];
  onExcludedChange: (ids: string[]) => void;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
  onApply: () => void;
}

interface ReflowPreview {
  error: string | null;
  plan: ReflowPlan | null;
  targetCount: number;
}

/** 面板预览与应用共用同一套规则：解析区间 / 每行上限并逐条重排 */
function useReflowPreview(subs: Subtitle[], form: ReflowForm): ReflowPreview {
  return useMemo(() => {
    if (subs.length === 0) return { error: '请先导入字幕', plan: null, targetCount: 0 };
    const max = parseMaxPerLine(form.maxPerLine);
    if (max === null)
      return { error: '每行最大字素数须为不小于 1 的整数', plan: null, targetCount: 0 };
    const targets = resolveRange(subs, form.fromId, form.toId);
    if (!targets)
      return {
        error: '请选择连续字幕区间（起点与终点，可同一条）',
        plan: null,
        targetCount: 0,
      };
    return { error: null, plan: planReflow(targets, max), targetCount: targets.length };
  }, [subs, form]);
}

function badgeOf(item: ReflowItemPlan): { text: string; cls: string } {
  if (item.status === 'infeasible') return { text: '不可行', cls: 'bad' };
  if (item.status === 'unchanged') return { text: '无需改动', cls: 'keep' };
  return { text: item.lines && item.lines[1] === null ? '一行' : '两行', cls: 'ok' };
}

function metaOf(item: ReflowItemPlan): string {
  if (!item.lines) return `可见 ${item.total} 字素`;
  return item.lines[1] === null
    ? `可见 ${item.total} 字素 → 一行 ${item.lines[0]}`
    : `可见 ${item.total} 字素 → 两行 ${item.lines[0]} / ${item.lines[1]}`;
}

export default function ReflowPanel({
  subs,
  form,
  onFormChange,
  excluded,
  onExcludedChange,
  selectedId,
  onJump,
  onApply,
}: ReflowPanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选区间两端
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start), [subs]);
  const byId = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const preview = useReflowPreview(subs, form);
  const { plan } = preview;

  const update = (patch: Partial<ReflowForm>) => onFormChange({ ...form, ...patch });

  // 仅「有变化」的条目可勾选；默认全部勾选，取消的 id 记入 excluded
  const checkedCount = plan
    ? plan.items.filter((it) => it.status === 'changed' && !excluded.includes(it.id)).length
    : 0;

  const toggleExcluded = (id: string) =>
    onExcludedChange(
      excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id]
    );

  const optionLabel = (s: Subtitle) =>
    `#${s.index} · ${formatTimestamp(s.start)} · ${s.text.split('\n')[0] || '（空文本）'}`;

  return (
    <aside className="reflow-panel">
      <div className="reflow-header">
        <span className="reflow-title">断行重排</span>
      </div>

      <div className="reflow-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再选择区间</div>}

        {subs.length > 0 && (
          <>
            <div className="silence-range">
              <div className="silence-field-title">连续字幕区间</div>
              <select
                className="drift-select"
                value={form.fromId ?? ''}
                onChange={(e) => update({ fromId: e.target.value || null })}
              >
                <option value="" disabled>
                  起点字幕…
                </option>
                {sorted.map((s) => (
                  <option key={s.id} value={s.id}>
                    {optionLabel(s)}
                  </option>
                ))}
              </select>
              <select
                className="drift-select"
                value={form.toId ?? ''}
                onChange={(e) => update({ toId: e.target.value || null })}
              >
                <option value="" disabled>
                  终点字幕…
                </option>
                {sorted.map((s) => (
                  <option key={s.id} value={s.id}>
                    {optionLabel(s)}
                  </option>
                ))}
              </select>
            </div>

            <div className="silence-range">
              <div className="silence-field-title">每行最大字素数</div>
              <input
                type="number"
                className="drift-input"
                min="1"
                step="1"
                value={form.maxPerLine}
                onChange={(e) => update({ maxPerLine: e.target.value })}
              />
              <span className="dim">
                按 Unicode 字素簇计数，i / b / u / font 标签不占宽度
              </span>
            </div>

            {plan && (
              <div className="drift-summary">
                <span>
                  区间 <b>{preview.targetCount}</b> 条 · 可重排 <b>{plan.changed}</b> ·
                  无需改动 <b>{plan.unchanged}</b> · 不可行 <b>{plan.infeasible}</b>
                </span>
                <span>
                  已勾选 <b>{checkedCount}</b> / {plan.changed} 条
                </span>
                <span className="dim">
                  一行放得下时保持一行；否则在两行均不超限的断点中依次取最大行长最小、
                  两行长度差最小、断点最靠前
                </span>
              </div>
            )}

            {preview.error && <div className="drift-error">{preview.error}</div>}

            {plan && (
              <div className="reflow-list">
                {plan.items.map((it) => {
                  const badge = badgeOf(it);
                  const checkable = it.status === 'changed';
                  const checked = checkable && !excluded.includes(it.id);
                  const sub = byId.get(it.id);
                  return (
                    <div
                      key={it.id}
                      className={`reflow-row ${it.id === selectedId ? 'active' : ''} ${
                        checkable && !checked ? 'unchecked' : ''
                      }`}
                      onClick={() => onJump(it.id, Math.max(0, sub?.start ?? 0) / 1000)}
                    >
                      <div className="reflow-row-head">
                        {checkable && (
                          <input
                            type="checkbox"
                            className="reflow-check"
                            checked={checked}
                            title="勾选后才会应用该条"
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleExcluded(it.id)}
                          />
                        )}
                        <span className="reflow-row-idx">#{it.index}</span>
                        <span className={`reflow-badge ${badge.cls}`}>{badge.text}</span>
                      </div>
                      <div className="reflow-text old">{it.text || '（空文本）'}</div>
                      {it.status === 'infeasible' ? (
                        <div className="reflow-reason" title={it.reason ?? ''}>
                          ⚠ {it.reason}
                        </div>
                      ) : (
                        <>
                          <div className="reflow-text new">{it.newText || '（空）'}</div>
                          <div className="reflow-meta">{metaOf(it)}</div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="drift-footer">
        <button
          className="btn success"
          disabled={!plan || checkedCount === 0}
          onClick={onApply}
          title={
            !plan
              ? (preview.error ?? '参数无效')
              : checkedCount === 0
                ? '没有已勾选的可重排条目'
                : '把勾选条目的重排文本写回当前字幕，保留 id、序号与时间；可一次撤销'
          }
        >
          ✅ 应用重排{plan && checkedCount > 0 ? `（写入 ${checkedCount} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}
