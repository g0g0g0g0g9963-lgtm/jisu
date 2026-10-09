import { useRef, useState } from "react";
import type { Booking } from "./lib/bookings";
import { fetchBookings } from "./lib/api";
import { formatDateLabel } from "./lib/datetime";
import { useDialogFocus } from "./lib/hooks";
import { roomById } from "./lib/rooms";
import "./booking-conflict.css";

export type EditDraft = Pick<Booking, "id" | "revision" | "roomId" | "date" | "start" | "end" | "purpose"> & { team: string };
export const editDraftOf = (booking: Booking): EditDraft => ({
  id: booking.id, revision: booking.revision, roomId: booking.roomId, date: booking.date,
  start: booking.start, end: booking.end, purpose: booking.purpose, team: booking.team ?? "",
});
const roomLabel = (id: string) => { const room = roomById(id); return room ? `${room.floor}층 · ${room.name}` : "회의실 정보 없음"; };

/** Draft stays untouched until the user explicitly chooses to reload. */
export function BookingConflictDialog({ draft, onBack, onReload }: {
  draft: EditDraft; onBack: () => void; onReload: (latest: Booking) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [latest, setLatest] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(ref, true, true, () => { if (!busy) onBack(); });
  const compare = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const booking = (await fetchBookings()).find(item => item.id === draft.id);
      if (!booking || booking.isMine === false) {
        setError("예약이 취소되었거나 더 이상 수정할 수 없습니다. 돌아가서 예약 목록을 확인해 주세요.");
      } else if (!Number.isSafeInteger(booking.revision)) {
        setError("최신 내용을 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
      } else setLatest(booking);
    } catch { setError("최신 내용을 불러오지 못했습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  const rows = latest ? [
    ["회의실", roomLabel(latest.roomId), roomLabel(draft.roomId)],
    ["날짜", formatDateLabel(latest.date), formatDateLabel(draft.date)],
    ["시간", `${latest.start}–${latest.end}`, `${draft.start}–${draft.end}`],
    ["회의 목적", latest.purpose, draft.purpose],
    ["본부", latest.team || "미입력", draft.team || "미입력"],
  ] : [];
  return <div className="edit-backdrop booking-conflict-backdrop" role="presentation">
    <section ref={ref} className="booking-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="booking-conflict-title" aria-describedby="booking-conflict-description" aria-busy={busy}>
      <header>
        <h2 id="booking-conflict-title">{latest ? "최신 내용을 확인해 주세요" : "예약 내용이 변경되었어요"}</h2>
        <button type="button" className="booking-conflict-close" aria-label="안내 닫고 입력 내용으로 돌아가기" disabled={busy} onClick={onBack}>×</button>
      </header>
      <div aria-live="polite">
        <p id="booking-conflict-description">{latest ? roomLabel(latest.roomId) : <>다른 창에서 이 예약이 변경되었습니다.<br />최신 내용을 확인한 뒤 다시 수정해 주세요.</>}</p>
        {latest && <table className="booking-conflict-compare">
          <thead><tr><th scope="col">항목</th><th scope="col">현재 저장된 내용</th><th scope="col">이 창의 입력</th></tr></thead>
          <tbody>{rows.map(([label, current, input]) => <tr key={label} className={current !== input ? "changed" : undefined}><th scope="row">{label}</th><td>{current}</td><td>{input}</td></tr>)}</tbody>
        </table>}
        <p className="booking-conflict-note">{latest
          ? "아래 버튼을 누르면 최신 내용으로 수정창을 다시 엽니다. 변경하려던 항목을 다시 입력해 주세요."
          : "이 창에서 입력한 변경사항은 아직 저장되지 않았습니다."}</p>
      </div>
      {error && <p className="booking-conflict-error" role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={onBack}>돌아가기</button>
        {latest
          ? <button type="button" className="booking-conflict-primary" onClick={() => onReload(latest)}>최신 내용으로 다시 수정</button>
          : <button type="button" className="booking-conflict-primary" disabled={busy} onClick={compare}>{busy ? "확인 중…" : "최신 내용 확인"}</button>}
      </footer>
    </section>
  </div>;
}
