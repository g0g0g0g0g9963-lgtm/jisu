/**
 * 예약 서버(/api)와의 통신. NAS 배포판에서 예약의 진실의 원천은 서버 DB이며,
 * 화면의 bookings 상태는 서버에서 받아온 사본이다.
 */
import type { Booking } from "./bookings";
import siteConfig from "../config/site.json";

export type CreateBookingRequest = {
  roomId: string;
  dates: string[];
  start: string;
  end: string;
  owner: string;
  team: string;
  purpose: string;
  attendees: string[];
  attendeeIds?: string[];
};

export type ApiResult = { ok: true; booking?: Booking } | { ok: false; message: string; code?: "booking-changed"; latest?: Booking };

export type CurrentUser = { name: string; email: string; isAdmin?: boolean };

/** 응답 본문까지 제한 시간 안에 읽는다. 쓰기 요청은 절대 자동 재전송하지 않는다. */
export async function requestApi<T>(url: string, init?: RequestInit): Promise<{ response: Response; payload: T | null }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), siteConfig.network.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status === 401) redirectToLogin();
    const text = await response.text();
    let payload: T | null = null;
    if (text) {
      try { payload = JSON.parse(text) as T; } catch {
        if (response.ok) throw new Error("서버 응답을 확인하지 못했습니다. 예약 내역을 확인해 주세요.");
      }
    }
    return { response, payload };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error("응답이 늦어지고 있습니다. 잠시 후 다시 확인해 주세요.");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 세션이 만료됐으면 Microsoft 로그인으로 보낸다. (SSO 모드에서만 401이 온다) */
function redirectToLogin(): never {
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
  throw new Error("로그인이 필요해 로그인 화면으로 이동합니다.");
}

/** 로그인 사용자. SSO가 꺼진 서버에서는 null → 익명 모드. */
export async function fetchMe(): Promise<CurrentUser | null> {
  const { response, payload } = await requestApi<unknown>("/api/me", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`로그인 상태를 확인하지 못했습니다. (${response.status})`);
  if (!payload || typeof payload !== "object" || !("user" in payload)) {
    throw new Error("로그인 상태 응답을 확인할 수 없습니다.");
  }
  const user = payload.user;
  if (user === null) return null;
  if (typeof user !== "object" || !("name" in user) || !("email" in user)
    || typeof user.name !== "string" || typeof user.email !== "string" || !user.name.trim() || !user.email.trim()) {
    throw new Error("로그인 사용자 정보가 올바르지 않습니다.");
  }
  return { name: user.name, email: user.email, isAdmin: "isAdmin" in user && user.isAdmin === true };
}

export async function fetchBookings(range?: { from: string; to: string }): Promise<Booking[]> {
  let result: { response: Response; payload: { bookings?: Booking[] } | null };
  try {
    const query = range ? `?${new URLSearchParams(range)}` : "";
    result = await requestApi<{ bookings?: Booking[] }>(`/api/bookings${query}`, { headers: { accept: "application/json" } });
  } catch {
    throw new Error("예약 내역을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  const { response, payload } = result;
  if (!response.ok) throw new Error(`예약 목록을 불러오지 못했습니다. (${response.status})`);
  if (!Array.isArray(payload?.bookings)) throw new Error("예약 목록 응답을 확인하지 못했습니다. 다시 확인해 주세요.");
  return payload.bookings;
}

export async function postBookings(request: CreateBookingRequest): Promise<ApiResult> {
  const { response, payload } = await requestApi<{ error?: string; conflict?: Booking; created?: Booking[] }>("/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) {
    if (!Array.isArray(payload?.created) || payload.created.length === 0) throw new Error("예약 결과를 확인하지 못했습니다.");
    return { ok: true };
  }
  if (response.status === 409 && payload?.conflict) {
    const clash = payload.conflict;
    return {
      ok: false,
      message: `${clash.date} ${clash.start}–${clash.end}에 ${clash.owner}님 예약이 이미 있어요. 다른 시간을 선택해 주세요.`,
    };
  }
  return { ok: false, message: payload?.error ?? `예약을 저장하지 못했습니다. (${response.status})` };
}

export type UpdateBookingRequest = {
  expectedRevision: number | undefined;
  roomId: string;
  date: string;
  start: string;
  end: string;
  owner: string;
  team: string;
  purpose: string;
};

/** 예약 한 건 수정. 본인 예약인지는 서버가 owner(익명) 또는 로그인 정보로 판단한다. */
export async function patchBookingRequest(id: string, request: UpdateBookingRequest): Promise<ApiResult> {
  const { response, payload } = await requestApi<{ error?: string; code?: string; latest?: Booking; conflict?: Booking; booking?: Booking }>(`/api/bookings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) {
    if (!payload?.booking?.id) throw new Error("예약 수정 결과를 확인하지 못했습니다.");
    return { ok: true, booking: payload.booking };
  }
  if (response.status === 409 && payload?.code === "booking-changed" && payload.latest?.id === id) {
    return { ok: false, code: "booking-changed", latest: payload.latest, message: payload.error ?? "예약 내용이 변경되었습니다." };
  }
  if (response.status === 409 && payload?.conflict) {
    const clash = payload.conflict;
    return {
      ok: false,
      message: `${clash.date} ${clash.start}–${clash.end}에 ${clash.owner}님 예약이 이미 있어요. 다른 시간을 선택해 주세요.`,
    };
  }
  return { ok: false, message: payload?.error ?? `예약을 수정하지 못했습니다. (${response.status})` };
}

export async function deleteBookingRequest(id: string, owner: string): Promise<ApiResult> {
  const { response, payload } = await requestApi<{ error?: string }>(`/api/bookings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner }),
  });
  if (response.ok) return { ok: true };
  return { ok: false, message: payload?.error ?? `예약을 취소하지 못했습니다. (${response.status})` };
}
