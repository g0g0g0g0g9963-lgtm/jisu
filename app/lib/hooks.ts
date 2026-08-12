"use client";

/**
 * 브라우저 바깥의 값(현재 시각, 브라우저 저장소)을 읽는 훅.
 *
 * useEffect 안에서 setState를 부르면 화면을 두 번 그리게 되고, 서버 렌더링과
 * 값이 어긋나기도 한다. React가 이런 용도로 제공하는 useSyncExternalStore를
 * 써서 서버에서는 "아직 모름", 브라우저에서는 실제 값이 나오게 한다.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

function createTicker(intervalMs: number) {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      timer ??= setInterval(() => {
        for (const listener of listeners) listener();
      }, intervalMs);

      return () => {
        listeners.delete(onChange);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    // 눈금 번호로 돌려줘야 값이 바뀔 때만 다시 그린다.
    getSnapshot: () => Math.floor(Date.now() / intervalMs),
  };
}

/** 현재 시각. 서버 렌더링 시점에는 null. */
export function useNow(intervalMs: number): Date | null {
  const ticker = useMemo(() => createTicker(intervalMs), [intervalMs]);
  const tick = useSyncExternalStore<number | null>(
    ticker.subscribe,
    ticker.getSnapshot,
    () => null,
  );

  return useMemo(
    () => (tick === null ? null : new Date(tick * intervalMs)),
    [tick, intervalMs],
  );
}

function createTextStore(key: string) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      // 다른 탭에서 바꾼 값도 따라간다.
      window.addEventListener("storage", onChange);
      return () => {
        listeners.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    getSnapshot() {
      try {
        return window.localStorage.getItem(key) ?? "";
      } catch {
        // 저장소를 막아둔 브라우저에서도 화면은 정상 동작해야 한다.
        return "";
      }
    },
    write(value: string) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // 저장만 실패할 뿐 화면 동작에는 영향이 없다.
      }
      notify();
    },
  };
}

/** 브라우저에 남는 문자열 값. 서버 렌더링 시점에는 빈 문자열. */
export function useStoredText(key: string): [string, (value: string) => void] {
  const store = useMemo(() => createTextStore(key), [key]);
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, () => "");
  const setValue = useCallback((next: string) => store.write(next), [store]);

  return [value, setValue];
}
