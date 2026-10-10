/** Isolated transport for the shared monitor. It never uses the employee session. */
export type KioskSession = { enabled: boolean; authorized: boolean; csrfToken?: string; preview?: boolean };
export type KioskBooking = { id: string; roomId: string; date: string; start: string; end: string; owner: string; purpose?: string };
export type KioskDraft = { roomId: string; date: string; start: string; end: string; owner: string; purpose: string };

export class KioskError extends Error {
  constructor(message: string, public status = 0, public uncertain = false) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const write = options.method === "POST" && path === "/bookings";
  try {
    const response = await fetch(`/api/kiosk${path}`, { ...options, signal: controller.signal, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new KioskError(typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.", response.status, write && response.status >= 500);
    if (!data) throw new KioskError("서버 응답을 확인할 수 없습니다. 다시 확인해 주세요.", response.status, write);
    return data as T;
  } catch (error) {
    if (error instanceof KioskError) throw error;
    throw new KioskError(write ? "예약 결과를 아직 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요." : "서버에 연결할 수 없습니다. 네트워크 연결을 확인해 주세요.", 0, write);
  } finally { window.clearTimeout(timeout); }
}

export const kioskSession = () => request<KioskSession>("/session");
export const connectKiosk = (code: string) => request<KioskSession>("/session", { method: "POST", headers: { "Content-Type": "application/json", "X-Kiosk-Action": "pair" }, body: JSON.stringify({ code }) });
export const getKioskBookings = async (from: string, to: string) => {
  const data = await request<{ bookings: KioskBooking[]; at: string }>(`/bookings?${new URLSearchParams({ from, to })}`);
  if (!Array.isArray(data.bookings) || data.bookings.some(item => !item || typeof item.id !== "string" || typeof item.roomId !== "string" || typeof item.date !== "string" || typeof item.start !== "string" || typeof item.end !== "string" || typeof item.owner !== "string")) throw new KioskError("예약 정보 형식을 확인할 수 없습니다. 새로고침해 주세요.");
  return data;
};
export const createKioskBooking = async (draft: KioskDraft, csrfToken: string, key: string) => {
  const data = await request<{ created: KioskBooking[] }>("/bookings", { method: "POST", headers: { "Content-Type": "application/json", "X-Kiosk-CSRF": csrfToken, "Idempotency-Key": key }, body: JSON.stringify(draft) });
  if (!Array.isArray(data.created) || data.created.length !== 1 || typeof data.created[0]?.id !== "string") throw new KioskError("예약 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.", 0, true);
  return data;
};

/** crypto.randomUUID is secure-context-only; getRandomValues also works on an
 * internal HTTP display while the deployment is being prepared for HTTPS. */
export function kioskRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
