/**
 * 多轮勾选的 DOM 层。
 *
 * 只做两件事：
 *   1. 把「已勾选的轮次」映射成消息行上的属性，供 CSS 画整轮标记；
 *   2. 把鼠标所在的行映射成「当前轮次」，让该轮尾部的勾选框提亮。
 *
 * 状态本身在 forward-panel 的 store 里（按轮次号存），这里只是视图同步：
 * 消息区是分页渲染的，行随时可能被卸载重建，所以每次同步都从 `data-chat-turn`
 * 重新推导，不缓存 DOM 引用。
 */

import { getSelectedTurns, subscribeForward } from "./forward-panel.js";

/** 消息行标记：整轮已勾选。 */
const SEL_ATTR = "data-cite-turn-selected";
/** 消息行标记：该轮在 DOM 里的第一个/最后一个可见行（用于圆角收口）。 */
const FIRST_ATTR = "data-cite-turn-first";
const LAST_ATTR = "data-cite-turn-last";

function rows(): HTMLElement[] {
  return [...document.querySelectorAll('[data-dsh-part="message-row"]')] as HTMLElement[];
}

/** 读出该行所属轮次；无轮次或非法值返回 undefined。 */
function turnOf(element: Element | null | undefined): number | undefined {
  const raw = element?.closest?.('[data-chat-turn]')?.getAttribute("data-chat-turn");
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 同步整轮标记。
 *
 * 按 DOM 顺序扫一遍：同一轮连续的行归为一档，首尾各打一个标记，
 * 这样 CSS 才能给整块加圆角，而不是每行各自一个圆角。
 */
export function syncTurnMarks(): void {
  const selected = new Set(getSelectedTurns());
  let prevTurn: number | undefined;
  let prevEl: HTMLElement | null = null;
  for (const element of rows()) {
    const turn = turnOf(element);
    const isOn = turn !== undefined && selected.has(turn);
    if (isOn) {
      element.setAttribute(SEL_ATTR, "true");
      if (prevTurn !== turn) element.setAttribute(FIRST_ATTR, "true");
      else if (prevEl !== null) prevEl.removeAttribute(LAST_ATTR);
      prevTurn = turn;
      prevEl = element;
      continue;
    }
    if (prevEl !== null) {
      prevEl.setAttribute(LAST_ATTR, "true");
      prevTurn = undefined;
      prevEl = null;
    }
    element.removeAttribute(SEL_ATTR);
    element.removeAttribute(FIRST_ATTR);
    element.removeAttribute(LAST_ATTR);
  }
  if (prevEl !== null) prevEl.setAttribute(LAST_ATTR, "true");
}

/**
 * 安装 DOM 层：订阅勾选变化、挂悬停委托、观察分页新增的行。
 * @returns 卸载函数；重复安装前应先卸载。
 */
export function installMultiSelect(): () => void {
  let frame = 0;
  let lastTurns = "";
  const scheduleSync = (): void => {
    if (frame !== 0) return;
    const run = (): void => {
      frame = 0;
      lastTurns = getSelectedTurns().join(",");
      try {
        syncTurnMarks();
      } catch {
        // 消息区正在重建：下一次通知或观察回调会补上。
      }
    };
    frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  };

  // 勾选集合变化才重画。勾选框的显隐不在这里驱动：它完全由 CSS 的 :hover 决定
  // （只悬停按钮组本身才出现），所以这里不再监听鼠标。
  const unsubscribe = subscribeForward(() => {
    const now = getSelectedTurns().join(",");
    if (now !== lastTurns) scheduleSync();
  });

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver === "function" && typeof document !== "undefined") {
    observer = new MutationObserver(() => scheduleSync());
    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }

  scheduleSync();

  return () => {
    unsubscribe();
    if (observer !== null) observer.disconnect();
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    for (const element of rows()) {
      element.removeAttribute(SEL_ATTR);
      element.removeAttribute(FIRST_ATTR);
      element.removeAttribute(LAST_ATTR);
    }
  };
}
