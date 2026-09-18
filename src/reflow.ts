import type { Subtitle } from './types';

/**
 * 断行重排：忽略 i / b / u / font 标签的占位宽度，按 Unicode 字素簇计数，
 * 在不改变可见文字先后顺序与标签内容的前提下，把每条字幕重排为一行或两行。
 *
 * 规则：
 *  - 一行放得下（可见字素数 ≤ 每行上限）时直接排成一行；
 *  - 否则枚举断点排成两行。断点处两侧的空白被吞掉，两行都至少含一个
 *    可见字素；候选断点不得让行首出现闭合标点、行尾出现起始标点；
 *  - 在两行均不超限的方案中依次选择：最大行长最小 → 两行长度差最小 →
 *    断点最靠前；
 *  - 无可行方案时报告原因，该条保持原样。
 *
 * 标签被解析为零宽原子，永不删除、永不修改；空白（含原有换行）统一按
 * 单个空格渲染，行首 / 行尾 / 断点处的空白会被吞掉。
 */

/** 闭合 / 点号类标点：不得出现在行首 */
const NO_LINE_START = new Set(
  Array.from('。，、；：？！…·’”）】》」』〉〕〗〙〛)]}%,.;:!?')
);
/** 起始 / 开括类标点：不得出现在行尾 */
const NO_LINE_END = new Set(Array.from('‘“（【《「『〈〔〖〘〚([{'));

/** 匹配 i / b / u / font 开闭标签（font 可带属性） */
const TAG_RE = /<\/?(?:i|b|u|font)(?:\s[^>]*)?>/gi;

/**
 * 排版原子：标签零宽且原样保留；空白宽 1，渲染为单个空格，在行首 / 行尾 /
 * 断点处会被吞掉；字素宽 1，是计数与标点判断的基本单位。
 */
interface Atom {
  /** 渲染文本：标签原文 / 单个空格 / 单个字素簇 */
  text: string;
  kind: 'tag' | 'space' | 'char';
  /** kind 为 char 时的字素本体（标点判断用），否则为空串 */
  char: string;
}

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** 按 Unicode 字素簇切分；环境不支持 Intl.Segmenter 时退化为按码点切分 */
function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (seg) => seg.segment);
  return Array.from(s);
}

/** 把字幕文本解析为原子序列：标签零宽，可见文字按字素簇逐个成原子 */
function toAtoms(text: string): Atom[] {
  const atoms: Atom[] = [];
  const pushChunk = (chunk: string) => {
    for (const g of graphemes(chunk)) {
      if (/^\s$/u.test(g)) atoms.push({ text: ' ', kind: 'space', char: '' });
      else atoms.push({ text: g, kind: 'char', char: g });
    }
  };
  TAG_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    pushChunk(text.slice(last, m.index));
    atoms.push({ text: m[0], kind: 'tag', char: '' });
    last = m.index + m[0].length;
  }
  pushChunk(text.slice(last));
  return atoms;
}

/** 去掉首尾的空白原子（标签原子始终保留） */
function trimEdges(atoms: Atom[]): Atom[] {
  let lo = 0;
  let hi = atoms.length;
  while (lo < hi && atoms[lo].kind === 'space') lo++;
  while (hi > lo && atoms[hi - 1].kind === 'space') hi--;
  return atoms.slice(lo, hi);
}

/** 占位宽度：标签不计，空白与字素各计 1 */
function widthOf(atoms: Atom[]): number {
  let n = 0;
  for (const a of atoms) if (a.kind !== 'tag') n++;
  return n;
}

function render(atoms: Atom[]): string {
  return atoms.map((a) => a.text).join('');
}

/** 行内第一个可见字素（标点判断用）；全为标签时返回 null */
function firstVisible(atoms: Atom[]): string | null {
  for (const a of atoms) if (a.kind === 'char') return a.char;
  return null;
}

/** 行内最后一个可见字素（标点判断用）；全为标签时返回 null */
function lastVisible(atoms: Atom[]): string | null {
  for (let i = atoms.length - 1; i >= 0; i--) {
    if (atoms[i].kind === 'char') return atoms[i].char;
  }
  return null;
}

export interface ReflowOk {
  ok: true;
  /** 重排后的文本（一行，或以 \n 连接的两行） */
  text: string;
  /** 可见字素总数（空白计入，标签不计） */
  total: number;
  /** 重排后各行长度（字素数）；一行方案第二个元素为 null */
  lines: [number, number | null];
}

export interface ReflowFail {
  ok: false;
  total: number;
  /** 不可行原因（展示给用户） */
  reason: string;
}

export type ReflowResult = ReflowOk | ReflowFail;

/**
 * 重排单条字幕文本。maxPerLine 为每行最大字素数（≥ 1）。
 * 纯空白文本重排为空串；只有标签的文本原样返回（一行，长度 0）。
 */
export function reflowText(text: string, maxPerLine: number): ReflowResult {
  const atoms = trimEdges(toAtoms(text));
  const total = widthOf(atoms);
  if (total <= maxPerLine) {
    return { ok: true, text: render(atoms), total, lines: [total, null] };
  }

  // 一行放不下：枚举断点 i（在 atoms[i] 之前断开，1 ≤ i ≤ n-1），
  // 断点两侧的空白原子被吞掉；两侧都至少剩一个可见字素才有效。
  const n = atoms.length;
  let best: { i: number; left: Atom[]; right: Atom[]; l1: number; l2: number } | null =
    null;
  // 是否存在两行均不超限的断点（不看标点规则），用于区分不可行原因
  let lengthFeasible = false;
  for (let i = 1; i < n; i++) {
    let li = i;
    while (li > 0 && atoms[li - 1].kind === 'space') li--;
    let ri = i;
    while (ri < n && atoms[ri].kind === 'space') ri++;
    const left = atoms.slice(0, li);
    const right = atoms.slice(ri);
    const l1 = widthOf(left);
    const l2 = widthOf(right);
    if (l1 === 0 || l2 === 0) continue;
    if (l1 > maxPerLine || l2 > maxPerLine) continue;
    lengthFeasible = true;
    // 标点规则：行首不得为闭合标点，行尾不得为起始标点
    const last = lastVisible(left);
    const first = firstVisible(right);
    if (last !== null && NO_LINE_END.has(last)) continue;
    if (first !== null && NO_LINE_START.has(first)) continue;
    if (
      !best ||
      Math.max(l1, l2) < Math.max(best.l1, best.l2) ||
      (Math.max(l1, l2) === Math.max(best.l1, best.l2) &&
        (Math.abs(l1 - l2) < Math.abs(best.l1 - best.l2) ||
          (Math.abs(l1 - l2) === Math.abs(best.l1 - best.l2) && i < best.i)))
    ) {
      best = { i, left, right, l1, l2 };
    }
  }

  if (!best) {
    return {
      ok: false,
      total,
      reason: lengthFeasible
        ? '不超长的断点都会让行首出现闭合标点或行尾出现起始标点'
        : `可见字素 ${total} 个，按每行 ≤ ${maxPerLine} 排两行也放不下`,
    };
  }
  return {
    ok: true,
    text: `${render(best.left)}\n${render(best.right)}`,
    total,
    lines: [best.l1, best.l2],
  };
}

/** 解析「每行最大字素数」输入：须为不小于 1 的整数；非法时返回 null */
export function parseMaxPerLine(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export type ReflowStatus = 'changed' | 'unchanged' | 'infeasible';

/** 单条字幕的重排预览结果 */
export interface ReflowItemPlan {
  id: string;
  index: number;
  /** 原文 */
  text: string;
  /** 重排结果（infeasible 时为 null） */
  newText: string | null;
  status: ReflowStatus;
  /** 可见字素总数 */
  total: number;
  /** 重排后各行长度；infeasible 时为 null */
  lines: [number, number | null] | null;
  /** 不可行原因（infeasible 时非空） */
  reason: string | null;
}

export interface ReflowPlan {
  items: ReflowItemPlan[];
  maxPerLine: number;
  /** 重排后文本有变化的条数（可勾选应用） */
  changed: number;
  /** 重排结果与原文一致的条数 */
  unchanged: number;
  /** 无可行方案的条数（保持原样） */
  infeasible: number;
}

/** 逐条计算重排预览；不修改入参 */
export function planReflow(targets: Subtitle[], maxPerLine: number): ReflowPlan {
  const items = targets.map((s): ReflowItemPlan => {
    const r = reflowText(s.text, maxPerLine);
    if (!r.ok) {
      return {
        id: s.id,
        index: s.index,
        text: s.text,
        newText: null,
        status: 'infeasible',
        total: r.total,
        lines: null,
        reason: r.reason,
      };
    }
    return {
      id: s.id,
      index: s.index,
      text: s.text,
      newText: r.text,
      status: r.text === s.text ? 'unchanged' : 'changed',
      total: r.total,
      lines: r.lines,
      reason: null,
    };
  });
  return {
    items,
    maxPerLine,
    changed: items.filter((it) => it.status === 'changed').length,
    unchanged: items.filter((it) => it.status === 'unchanged').length,
    infeasible: items.filter((it) => it.status === 'infeasible').length,
  };
}

/**
 * 应用重排：把所选条目（仅 status 为 changed 的）的文本替换为重排结果，
 * 其余字幕原样保留；返回新数组（不修改入参）。
 */
export function applyReflow(subs: Subtitle[], items: ReflowItemPlan[]): Subtitle[] {
  const byId = new Map(
    items
      .filter((it) => it.status === 'changed' && it.newText !== null)
      .map((it) => [it.id, it.newText as string])
  );
  if (byId.size === 0) return subs;
  return subs.map((s) => {
    const t = byId.get(s.id);
    return t === undefined ? s : { ...s, text: t };
  });
}
