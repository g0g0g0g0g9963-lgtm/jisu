/**
 * 예약 서버(/api)와의 통신. NAS 배포판에서 예약의 진실의 원천은 서버 DB이며,
 * 화면의 bookings 상태는 서버에서 받아온 사본이다.
 */
import type { Booking } from "./bookings";

export type CreateBookingRequest = {
  roomId: string;
  dates: string[];
  start: string;
  end: string;
  owner: string;
  team: string;
  purpose: string;
  attendees: string[];
};

export type ApiResult = { ok: true } | { ok: false; message: string };

/** 비품 한 종류의 보유 수량과, 고른 시간대에 남은 수량. */
export type EquipmentSlot = { id: string; name: string; stock: number; left: number };

/** 그 시간대에 남은 비품 수를 서버에서 받아온다. 재고는 사무실 전체가 함께 쓴다. */
export async function fetchEquipment(
  date: string, start: string, end: string, excludeBookingId?: string,
): Promise<EquipmentSlot[]> {
  const query = new URLSearchParams({ date, start, end });
  if (excludeBookingId) query.set("exclude", excludeBookingId);
  const response = await fetch(`/api/equipment?${query}`, { headers: { accept: "application/json" } });
  if (response.status === 401) redirectToLogin();
  if (!response.ok) return [];
  const payload = (await response.json()) as { items?: EquipmentSlot[] };
  return payload.items ?? [];
}

export type CurrentUser = { name: string; email: string };

/** 세션이 만료됐으면 Microsoft 로그인으로 보낸다. (SSO 모드에서만 401이 온다) */
function redirectToLogin(): never {
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
  throw new Error("로그인이 필요해 로그인 화면으로 이동합니다.");
}

/** 로그인 사용자. SSO가 꺼진 서버에서는 null → 익명 모드. */
export async function fetchMe(): Promise<CurrentUser | null> {
  const response = await fetch("/api/me", { headers: { accept: "application/json" } });
  if (response.status === 401) redirectToLogin();
  if (!response.ok) return null;
  const payload = (await response.json()) as { user: CurrentUser | null };
  return payload.user;
}

export async function fetchBookings(): Promise<Booking[]> {
  const response = await fetch("/api/bookings", { headers: { accept: "application/json" } });
  if (response.status === 401) redirectToLogin();
  if (!response.ok) throw new Error(`예약 목록을 불러오지 못했습니다. (${response.status})`);
  const payload = (await response.json()) as { bookings?: Booking[] };
  return payload.bookings ?? [];
}

export async function postBookings(request: CreateBookingRequest): Promise<ApiResult> {
  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status === 401) redirectToLogin();
  if (response.ok) return { ok: true };

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; conflict?: Booking }
    | null;
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
  const response = await fetch(`/api/bookings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status === 401) redirectToLogin();
  if (response.ok) return { ok: true };

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; conflict?: Booking }
    | null;
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
  const response = await fetch(`/api/bookings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner }),
  });
  if (response.status === 401) redirectToLogin();
  if (response.ok) return { ok: true };

  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, message: payload?.error ?? `예약을 취소하지 못했습니다. (${response.status})` };
}
